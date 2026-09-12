/**
 * Job pipeline.
 *
 * Every internal status carries a `publicLabel` — the customer-safe wording the
 * Ghost Tech website can show. The site-sync feed only ever exposes the public
 * label, never internal notes, costs or margins.
 */

export interface JobStatusDef {
  key: string;
  label: string;
  publicLabel: string;
  /** Shown on the public site at all? Cancelled/lost work stays internal. */
  publicVisible: boolean;
  terminal?: boolean;
}

export const JOB_STATUSES: JobStatusDef[] = [
  { key: 'intake', label: 'Intake', publicLabel: 'Received', publicVisible: true },
  { key: 'diagnosing', label: 'Diagnosing', publicLabel: 'In diagnosis', publicVisible: true },
  { key: 'quoted', label: 'Quoted', publicLabel: 'Quote sent', publicVisible: true },
  {
    key: 'awaiting_approval',
    label: 'Awaiting customer approval',
    publicLabel: 'Waiting on your approval',
    publicVisible: true,
  },
  { key: 'approved', label: 'Approved', publicLabel: 'Approved', publicVisible: true },
  { key: 'awaiting_parts', label: 'Awaiting parts', publicLabel: 'Parts on order', publicVisible: true },
  { key: 'in_repair', label: 'In repair', publicLabel: 'In repair', publicVisible: true },
  {
    key: 'ready_for_pickup',
    label: 'Ready for pickup',
    publicLabel: 'Ready for pickup',
    publicVisible: true,
  },
  { key: 'completed', label: 'Completed', publicLabel: 'Completed', publicVisible: true, terminal: true },
  { key: 'cancelled', label: 'Cancelled', publicLabel: 'Cancelled', publicVisible: false, terminal: true },
];

export const jobStatus = (key: string): JobStatusDef =>
  JOB_STATUSES.find((s) => s.key === key) ?? JOB_STATUSES[0];

export const publicLabelFor = (key: string): string => jobStatus(key).publicLabel;
export const isValidJobStatus = (key: string): boolean =>
  JOB_STATUSES.some((s) => s.key === key);

/** Statuses that still need work from the shop. */
export const OPEN_JOB_STATUSES = JOB_STATUSES.filter((s) => !s.terminal).map((s) => s.key);

/**
 * The five quick owner actions from the dashboard. Each is a real state
 * transition plus its side effects — not a free-text note.
 */
export const OWNER_ACTIONS = {
  picked_up: {
    label: 'Picked Up Device',
    toStatus: 'diagnosing',
    stamp: 'pickedUpAt',
    summary: 'Owner picked up the device from the customer',
  },
  started_repair: {
    label: 'Started Repair',
    toStatus: 'in_repair',
    stamp: 'repairStartedAt',
    summary: 'Owner started the repair',
  },
  finished_repair: {
    label: 'Finished Repair',
    toStatus: 'ready_for_pickup',
    stamp: 'repairFinishedAt',
    summary: 'Owner finished the repair, device ready for pickup',
  },
  collected_payment: {
    label: 'Collected Payment',
    toStatus: 'completed',
    stamp: 'paidAt',
    summary: 'Owner collected payment and closed the job',
  },
} as const;

export type OwnerActionKey = keyof typeof OWNER_ACTIONS;
export const isOwnerAction = (k: string): k is OwnerActionKey => k in OWNER_ACTIONS;

/** Short, human-friendly tracking code the customer site can query by. */
export function newTrackingCode(): string {
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no look-alikes
  let out = '';
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  for (const b of bytes) out += alphabet[b % alphabet.length];
  return `GT-${out}`;
}
