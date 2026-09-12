import { env } from './env.js';

/**
 * Airtable adapter.
 *
 * Airtable stays the owner's business database; Postgres is what the dashboard
 * renders. When no PAT is configured every call reports `configured: false`
 * instead of throwing, so the dashboard degrades to its own store cleanly.
 *
 * Table and field names are configurable because the live base could not be
 * introspected without a token.
 */

const API = 'https://api.airtable.com/v0';

export const jobsTable = (): string => env('AIRTABLE_JOBS_TABLE') || 'Leads & Jobs';

export interface AirtableStatus {
  configured: boolean;
  baseConfigured: boolean;
  table: string;
  reachable?: boolean;
  message?: string;
}

export function airtableConfigured(): boolean {
  return !!env('AIRTABLE_PAT') && !!env('AIRTABLE_BASE_ID');
}

export function airtableStatus(): AirtableStatus {
  return {
    configured: airtableConfigured(),
    baseConfigured: !!env('AIRTABLE_BASE_ID'),
    table: jobsTable(),
    message: airtableConfigured()
      ? undefined
      : 'AIRTABLE_PAT is not set, so the GhostOS base is not connected. The dashboard is running on its own store.',
  };
}

async function call(path: string, init: RequestInit = {}): Promise<any> {
  const pat = env('AIRTABLE_PAT');
  const base = env('AIRTABLE_BASE_ID');
  const res = await fetch(`${API}/${base}/${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${pat}`,
      'content-type': 'application/json',
      ...(init.headers || {}),
    },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error?.message || data?.error?.type || `Airtable ${res.status}`);
  return data;
}

/** Live check used by the Agents view and BUILDER's inspection. */
export async function probe(): Promise<AirtableStatus> {
  const status = airtableStatus();
  if (!status.configured) return { ...status, reachable: false };
  try {
    await call(`${encodeURIComponent(jobsTable())}?maxRecords=1`);
    return { ...status, reachable: true, message: 'Connected' };
  } catch (e: any) {
    return { ...status, reachable: false, message: e?.message || 'Airtable unreachable' };
  }
}

export interface AirtableRecord {
  id: string;
  fields: Record<string, any>;
}

export async function listJobRecords(max = 50): Promise<AirtableRecord[]> {
  if (!airtableConfigured()) return [];
  const data = await call(`${encodeURIComponent(jobsTable())}?maxRecords=${max}`);
  return (data.records || []) as AirtableRecord[];
}

/** Mirrors a status change back to Airtable. Best-effort by design. */
export async function pushJobStatus(
  recordId: string,
  fields: Record<string, any>,
): Promise<{ ok: boolean; message?: string }> {
  if (!airtableConfigured()) return { ok: false, message: 'Airtable not configured' };
  try {
    await call(`${encodeURIComponent(jobsTable())}/${recordId}`, {
      method: 'PATCH',
      body: JSON.stringify({ fields }),
    });
    return { ok: true };
  } catch (e: any) {
    return { ok: false, message: e?.message };
  }
}
