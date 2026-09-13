import {
  analyzeBuilderRequest,
  approveAndMergeProposal,
  confirmHighRisk,
  createBuilderRequest,
  createBuildProposal,
  refreshProposalStatus,
  rejectProposal,
} from '../../src/builder.js';
import { recordSuggestionFeedback, runImprovementCycle } from '../../src/improvements.js';

const json = (body, status = 200) => Response.json(body, { status, headers: { 'cache-control': 'no-store' } });

export default async (req) => {
  if (req.method !== 'POST') return json({ ok: false, error: 'Method not allowed' }, 405);
  const secret = process.env.GHOSTOS_WEBHOOK_SECRET;
  if (!secret) return json({ ok: false, error: 'GhostOS is not configured' }, 503);
  if (req.headers.get('x-ghostos-secret') !== secret) return json({ ok: false, error: 'Unauthorized' }, 401);

  try {
    const body = await req.json();
    if (body.action === 'create') {
      if (!body.goal || String(body.goal).trim().length < 5) return json({ ok: false, error: 'goal is required' }, 400);
      const request = await createBuilderRequest({ goal: String(body.goal).trim(), context: String(body.context || ''), priority: body.priority || 'Normal', requestedBy: 'Owner' });
      return json({ ok: true, request });
    }
    if (body.action === 'discover') return json({ ok: true, result: await runImprovementCycle({ allowAutonomousProposal: true }) });
    if (!body.requestId) return json({ ok: false, error: 'requestId is required' }, 400);
    if (body.action === 'analyze') return json({ ok: true, request: await analyzeBuilderRequest(body.requestId) });
    if (body.action === 'confirm_high_risk') return json({ ok: true, request: await confirmHighRisk(body.requestId) });
    if (body.action === 'build') {
      await recordSuggestionFeedback(body.requestId, 'Build Approved');
      const result = await createBuildProposal(body.requestId);
      return json({ ok: !result?.blocked, ...result }, result?.blocked ? 409 : 200);
    }
    if (body.action === 'refresh') return json({ ok: true, request: await refreshProposalStatus(body.requestId) });
    if (body.action === 'dismiss') return json({ ok: true, request: await recordSuggestionFeedback(body.requestId, 'Dismissed') });
    if (body.action === 'snooze') return json({ ok: true, request: await recordSuggestionFeedback(body.requestId, 'Snoozed', { snoozeDays: Number(body.snoozeDays || 7) }) });
    if (body.action === 'reject') {
      await recordSuggestionFeedback(body.requestId, 'Rejected');
      return json({ ok: true, request: await rejectProposal(body.requestId) });
    }
    if (body.action === 'approve_merge') {
      await recordSuggestionFeedback(body.requestId, 'Merge Approved');
      const request = await approveAndMergeProposal(body.requestId);
      await recordSuggestionFeedback(body.requestId, 'Merged');
      return json({ ok: true, request });
    }
    return json({ ok: false, error: 'Unsupported action' }, 400);
  } catch (error) {
    console.error('GhostOS BUILDER error', error?.message || error);
    return json({ ok: false, error: error?.message || 'BUILDER request failed' }, 500);
  }
};
