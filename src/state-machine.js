export const JOB_STATES = Object.freeze([
  'New Lead',
  'Need Quote',
  'Quoted',
  'Awaiting Customer',
  'Part Approval',
  'Part Ordered',
  'Scheduled',
  'In Progress',
  'Completed',
  'Lost / Declined',
]);

const TRANSITIONS = Object.freeze({
  'New Lead': new Set(['Need Quote', 'Awaiting Customer', 'Lost / Declined']),
  'Need Quote': new Set(['Quoted', 'Awaiting Customer', 'Part Approval', 'Lost / Declined']),
  Quoted: new Set(['Awaiting Customer', 'Part Approval', 'Scheduled', 'Lost / Declined']),
  'Awaiting Customer': new Set(['Need Quote', 'Quoted', 'Part Approval', 'Scheduled', 'Lost / Declined']),
  'Part Approval': new Set(['Part Ordered', 'Need Quote', 'Lost / Declined']),
  'Part Ordered': new Set(['Scheduled', 'In Progress', 'Lost / Declined']),
  Scheduled: new Set(['In Progress', 'Lost / Declined']),
  'In Progress': new Set(['Completed', 'Lost / Declined']),
  Completed: new Set([]),
  'Lost / Declined': new Set(['New Lead']),
});

export function canTransition(from, to) {
  if (!JOB_STATES.includes(to)) return false;
  if (!from || from === to) return true;
  return Boolean(TRANSITIONS[from]?.has(to));
}

export function assertTransition(from, to) {
  if (!canTransition(from, to)) {
    throw new Error(`Invalid job state transition: ${from || '(none)'} -> ${to}`);
  }
}

export function inferNextState({ current, hasQuote, needsPartApproval, customerReplyNeeded, scheduled, completed, lost }) {
  if (completed) return 'Completed';
  if (lost) return 'Lost / Declined';
  if (scheduled) return 'Scheduled';
  if (needsPartApproval) return 'Part Approval';
  if (hasQuote && customerReplyNeeded) return 'Awaiting Customer';
  if (hasQuote) return 'Quoted';
  if (customerReplyNeeded && current === 'New Lead') return 'Awaiting Customer';
  return current === 'New Lead' ? 'Need Quote' : current;
}
