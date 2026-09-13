function safeError(error) {
  return {
    code: error?.error || error?.code || error?.statusCode || error?.status || error?.name || 'UNKNOWN_ERROR',
    message: String(error?.message || error || 'Lead dispatch cycle failed').slice(0, 4000),
    statusCode: error?.statusCode || error?.status || null,
  };
}

function safeTraceDetail(stage, data = {}) {
  return JSON.stringify({
    stage,
    at: new Date().toISOString(),
    ...data,
  }).slice(0, 20000);
}

export default async () => {
  let airtable = null;
  let traceId = null;
  let lastStage = 'handler_started';
  let currentJobId = null;

  async function trace(stage, data = {}, status = 'Running') {
    lastStage = stage;
    if (!airtable) return false;
    const detail = safeTraceDetail(stage, data);
    try {
      if (!traceId) {
        const record = await airtable.logActivity({
          agent: 'ATLAS',
          actionType: 'lead_dispatch_trace',
          status,
          detail,
          consequential: false,
        });
        traceId = record.id;
      } else {
        await airtable.updateRecord(airtable.TABLES.ACTIVITY, traceId, {
          Status: status,
          Detail: detail,
        });
      }
      return true;
    } catch (traceError) {
      console.error('GhostOS lead dispatch trace persistence failed', JSON.stringify({
        stage,
        error: safeError(traceError),
      }));
      return false;
    }
  }

  try {
    airtable = await import('../../src/airtable.js');
    await trace('scan_started');
    await trace('module_import_started');

    const [{ createLeadDispatcher }, relayDelivery, ghostos] = await Promise.all([
      import('../../src/lead-dispatch.js'),
      import('../../src/relay-delivery.js'),
      import('../../src/ghostos.js'),
    ]);
    await trace('module_import_complete');

    const tracedDeps = {
      createRecord: async (table, fields) => {
        const record = await airtable.createRecord(table, fields);
        if (table === airtable.TABLES.MESSAGES) {
          const jobId = Array.isArray(fields.Job) ? fields.Job[0] : currentJobId;
          await trace('relay_message_created', { jobId: jobId || null, messageId: record.id });
        }
        return record;
      },
      getRecord: async (table, id) => {
        const record = await airtable.getRecord(table, id);
        if (table === airtable.TABLES.JOBS) {
          currentJobId = id;
          await trace('lead_selected', {
            jobId: id,
            status: record?.fields?.Status || null,
            dispatchStatus: record?.fields?.['GhostOS Dispatch Status'] || null,
          });
          if (String(record?.fields?.['RELAY Reply Draft'] || '').trim()) {
            await trace('existing_draft_found', { jobId: id });
          }
        }
        return record;
      },
      listRecords: async (table, options) => {
        const records = await airtable.listRecords(table, options);
        if (table === airtable.TABLES.JOBS) {
          await trace('leads_loaded', { count: records.length });
        } else if (table === airtable.TABLES.MESSAGES) {
          const existing = currentJobId
            ? records.find((row) => Array.isArray(row.fields?.Job)
              && row.fields.Job.includes(currentJobId)
              && String(row.fields?.Body || '').trim())
            : null;
          await trace(existing ? 'relay_message_reused' : 'relay_message_checked', {
            jobId: currentJobId || null,
            messageCount: records.length,
            existingMessage: Boolean(existing),
          });
        }
        return records;
      },
      updateRecord: async (table, id, fields) => {
        const record = await airtable.updateRecord(table, id, fields);
        if (table === airtable.TABLES.JOBS) {
          await trace('job_updated', {
            jobId: id,
            dispatchStatus: fields['GhostOS Dispatch Status'] || null,
          });
        }
        return record;
      },
      logActivity: async (entry) => {
        const record = await airtable.logActivity(entry);
        await trace('activity_written', {
          jobId: entry.jobId || currentJobId || null,
          actionType: entry.actionType || null,
          activityStatus: entry.status || 'Done',
        });
        return record;
      },
      createRelayDraft: relayDelivery.createRelayDraft,
      processLead: async (jobId, options) => {
        await trace('openai_agent_started', { jobId });
        try {
          const result = await ghostos.processLead(jobId, options);
          await trace('openai_agent_complete', { jobId });
          return result;
        } catch (error) {
          await trace('openai_agent_failed', { jobId, failure: safeError(error) }, 'Error');
          throw error;
        }
      },
      now: () => new Date().toISOString(),
    };

    const result = await createLeadDispatcher(tracedDeps).runCycle({ maxLeads: 5 });
    await trace('cycle_complete', {
      leadsScanned: result.leadsScanned,
      newLeadsSeen: result.newLeadsSeen,
      leadsEligible: result.leadsEligible,
      leadsProcessed: result.leadsProcessed,
      failures: result.failures?.length || 0,
    }, result.failures?.length ? 'Error' : 'Done');

    const payload = { ok: true, ...result };
    console.log('GhostOS lead dispatch cycle completed', JSON.stringify(payload));
    return Response.json(payload, { headers: { 'cache-control': 'no-store' } });
  } catch (error) {
    const failure = safeError(error);
    await trace(lastStage, { failure }, 'Error');
    const payload = { ok: false, stage: lastStage, error: failure };
    console.error('GhostOS lead dispatch cycle failed', JSON.stringify(payload));
    return Response.json(payload, {
      status: 500,
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
      },
    });
  }
};

export const config = { schedule: '*/2 * * * *' };
