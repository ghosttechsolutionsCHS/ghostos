/**
 * Server-side configuration. Values never leave the server: callers may ask
 * whether something is configured, never what it is.
 */
export const env = (k: string): string => process.env[k] ?? '';

export const MODEL = env('GHOSTOS_MODEL') || 'gpt-5.6-sol';

/** Session signing falls back to the webhook secret so v2 works on day one. */
export const sessionSecret = (): string =>
  env('GHOSTOS_SESSION_SECRET') || env('GHOSTOS_WEBHOOK_SECRET');

export const ownerPasscode = (): string => env('GHOSTOS_OWNER_PASSCODE');

export interface ConfigFlag {
  name: string;
  configured: boolean;
  required: boolean;
  purpose: string;
}

/** Booleans only — this is what BUILDER and the Agents view are allowed to see. */
export function configStatus(): ConfigFlag[] {
  return [
    { name: 'GHOSTOS_OWNER_PASSCODE', configured: !!ownerPasscode(), required: true, purpose: 'Owner login for the dashboard' },
    { name: 'GHOSTOS_SESSION_SECRET', configured: !!env('GHOSTOS_SESSION_SECRET'), required: false, purpose: 'Dedicated session signing key (falls back to webhook secret)' },
    { name: 'GHOSTOS_WEBHOOK_SECRET', configured: !!env('GHOSTOS_WEBHOOK_SECRET'), required: true, purpose: 'Authenticates the inbound lead webhook' },
    { name: 'OPENAI_API_KEY', configured: !!env('OPENAI_API_KEY'), required: true, purpose: 'ATLAS and department reasoning' },
    { name: 'AIRTABLE_PAT', configured: !!env('AIRTABLE_PAT'), required: false, purpose: 'Two-way sync with the Airtable GhostOS base' },
    { name: 'AIRTABLE_BASE_ID', configured: !!env('AIRTABLE_BASE_ID'), required: false, purpose: 'Which Airtable base to sync' },
    { name: 'GHOSTOS_SITE_SYNC_TOKEN', configured: !!env('GHOSTOS_SITE_SYNC_TOKEN'), required: false, purpose: 'Lets the customer website read public job status' },
  ];
}
