import { TABLES, getRecord, logActivity, updateRecord } from '../../src/airtable.js';

const json = (body, status = 200) => Response.json(body, {
  status,
  headers: { 'cache-control': 'no-store' },
});

function getCookie(req, name) {
  const cookie = req.headers.get('cookie') || '';
  return cookie.split(';').map((part) => part.trim()).find((part) => part.startsWith(`${name}=`))?.slice(name.length + 1) || '';
}

function safeEqual(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export default async (req) => {
  if (req.method !== 'POST') return json({ ok: false, error: 'Method not allowed' }, 405);

  const secret = Netlify.env.get('GHOSTOS_WEBHOOK_SECRET') || '';
  const ownerSession = Netlify.env.get('GHOSTOS_OWNER_SESSION_TOKEN') || '';
  const headerAuthorized = safeEqual(req.headers.get('x-ghostos-secret') || '', secret);
  const cookieAuthorized = safeEqual(getCookie(req, 'ghostos_owner'), ownerSession);
  if (!secret && !ownerSession) return json({ ok: false, error: 'GhostOS is not configured' }, 503);
  if (!headerAuthorized && !cookieAuthorized) return json({ ok: false, error: 'Unauthorized' }, 401);

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
