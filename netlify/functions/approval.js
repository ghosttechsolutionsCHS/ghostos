import { TABLES, getRecord, logActivity, updateRecord } from '../../src/airtable.js';

const json = (body, status = 200) => Response.json(body, {
  status,
  headers: { 'cache-control': 'no-store' },
});

export default async (req) => {
  if (req.method !== 'POST') return json({ ok: false, error: 'Method not allowed' }, 405);

  const secret = process.env.GHOSTOS_WEBHOOK_SECRET;
  if (!secret) return json({ ok: false, error: 'GhostOS is not configured' }, 503);
  if (req.headers.get('x-ghostos-secret') !== secret) return json({ ok: false, error: 'Unauthorized' }, 401);

  try {
    const { approvalId, decision, notes = '' } = await req.json();
    if (!approvalId || !['Approved', 'Rejected'].includes(decision)) {
      return json({ ok: false, error: 'approvalId and decision (Approved or Rejected) are required' }, 400);
    }

    const approval = await getRecord(TABLES.APPROVALS, approvalId);
    if (approval.fields.Status !== 'Pending') {
      return json({ ok: false, error: `Approval is already ${approval.fields.Status || 'resolved'}` }, 409);
    }

    const resolvedAt = new Date().toISOString();
    await updateRecord(TABLES.APPROVALS, approvalId, {
      Status: decision,
      'Resolved At': resolvedAt,
      'Resolution Notes': notes,
    });

    const quoteId = Array.isArray(approval.fields.Quote) ? approval.fields.Quote[0] : null;
    const jobId = Array.isArray(approval.fields.Job) ? approval.fields.Job[0] : null;
    const type = approval.fields.Type;

    if (quoteId) {
      await updateRecord(TABLES.QUOTES, quoteId, {
        'Owner Approval Status': decision,
        ...(decision === 'Approved' ? { Status: 'Approved' } : {}),
      });
    }

    if (jobId) {
      if (decision === 'Approved' && type === 'Purchase') {
        await updateRecord(TABLES.JOBS, jobId, {
          Status: 'Part Approval',
          'RELAY State': 'Awaiting Owner',
          'RELAY Next Action': 'Owner approved the part purchase. Execute the authorized purchase through the configured purchasing workflow; do not mark Part Ordered until purchase confirmation exists.',
        });
      } else if (decision === 'Approved') {
        await updateRecord(TABLES.JOBS, jobId, {
          Status: 'Quoted',
          'RELAY State': 'Awaiting Customer',
          'RELAY Next Action': 'Owner approved the consequential quote/action. RELAY can prepare the routine customer follow-up.',
        });
      } else {
        await updateRecord(TABLES.JOBS, jobId, {
          'RELAY State': 'Awaiting Owner',
          'RELAY Next Action': `Owner rejected ${type || 'the requested action'}. Re-plan without executing it.`,
        });
      }

      await logActivity({
        agent: 'ATLAS',
        jobId,
        actionType: 'owner_approval_resolved',
        status: decision === 'Approved' ? 'Done' : 'Blocked',
        detail: `${type || 'Approval'}: ${decision}${notes ? ` — ${notes}` : ''}`,
        consequential: true,
      });
    }

    return json({ ok: true, approvalId, decision, resolvedAt });
  } catch (error) {
    console.error('GhostOS approval error', error);
    return json({ ok: false, error: error?.message || 'Approval error' }, 500);
  }
};
