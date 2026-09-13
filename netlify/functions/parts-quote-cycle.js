function linkedToJob(row, jobId) {
  return Array.isArray(row.fields?.Job) && row.fields.Job.includes(jobId);
}

function safeError(error) {
  return {
    code: error?.error || error?.code || error?.statusCode || error?.status || error?.name || 'UNKNOWN_ERROR',
    message: String(error?.message || error || 'Parts quote cycle failed').slice(0, 4000),
    statusCode: error?.statusCode || error?.status || null,
  };
}

export default async () => {
  try {
    const [airtable, pipelineModule, ghostos] = await Promise.all([
      import('../../src/airtable.js'),
      import('../../src/parts-quote-pipeline.js'),
      import('../../src/ghostos.js'),
    ]);

    const [jobs, parts, quotes] = await Promise.all([
      airtable.listRecords(airtable.TABLES.JOBS, { maxRecords: 300 }),
      airtable.listRecords(airtable.TABLES.PARTS, { maxRecords: 500 }),
      airtable.listRecords(airtable.TABLES.QUOTES, { maxRecords: 300 }),
    ]);

    const candidates = jobs
      .filter((job) => job.fields?.['GhostOS Dispatch Status'] === 'Processed')
      .filter((job) => ['New Lead', 'Need Quote'].includes(job.fields?.Status))
      .filter((job) => job.fields?.['RELAY State'] !== 'Need More Info')
      .filter((job) => pipelineModule.repairLeadNeedsPart(job))
      .filter((job) => !parts.some((row) => linkedToJob(row, job.id)))
      .filter((job) => !quotes.some((row) => linkedToJob(row, job.id)))
      .sort((a, b) => new Date(b.createdTime || 0) - new Date(a.createdTime || 0));

    const selected = candidates[0] || null;
    if (!selected) {
      const result = { scanned: jobs.length, eligible: 0, processed: 0 };
      console.log('GhostOS parts quote continuation cycle', JSON.stringify(result));
      return Response.json(result, { headers: { 'cache-control': 'no-store' } });
    }

    await airtable.logActivity({
      agent: 'ATLAS',
      jobId: selected.id,
      actionType: 'parts_quote_continuation_started',
      status: 'Running',
      detail: 'Continuing a previously dispatched repair lead into SUPPLY -> quote economics -> RELAY draft. No purchase or customer send is authorized.',
    });

    const result = await pipelineModule.createPartsQuotePipeline({
      researchParts: ghostos.runSupplyResearchForJob,
    }).run(selected.id);

    await airtable.logActivity({
      agent: 'ATLAS',
      jobId: selected.id,
      actionType: 'parts_quote_continuation_completed',
      status: 'Done',
      detail: JSON.stringify({ completed: Boolean(result.completed), waitingForVerifiedPart: Boolean(result.waitingForVerifiedPart), approvalRequired: Boolean(result.approvalRequired) }).slice(0, 20000),
    });

    const payload = { scanned: jobs.length, eligible: candidates.length, processed: 1, jobId: selected.id, result };
    console.log('GhostOS parts quote continuation cycle', JSON.stringify(payload));
    return Response.json(payload, { headers: { 'cache-control': 'no-store' } });
  } catch (error) {
    const payload = { ok: false, error: safeError(error) };
    console.error('GhostOS parts quote continuation cycle failed', JSON.stringify(payload));
    return Response.json(payload, { status: 500, headers: { 'cache-control': 'no-store' } });
  }
};

// One already-dispatched repair lead per run keeps live-web SUPPLY work bounded and idempotent.
export const config = { schedule: '*/2 * * * *' };
