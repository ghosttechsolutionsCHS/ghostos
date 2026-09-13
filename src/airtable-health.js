import { TABLES, createRecord, getRecord, listRecords } from './airtable.js';

export const AIRTABLE_HEALTH_VERSION = 'airtable-write-health-v1';

export function safeAirtableError(error) {
  if (!error) return null;
  return {
    code: error?.error || error?.code || error?.statusCode || error?.status || error?.name || 'UNKNOWN_AIRTABLE_ERROR',
    message: String(error?.message || error).slice(0, 4000),
    statusCode: error?.statusCode || error?.status || null,
  };
}

export async function runAirtableWriteHealthCheck(overrides = {}) {
  const deps = {
    listRecords,
    createRecord,
    getRecord,
    tokenLoaded: Boolean(process.env.AIRTABLE_PAT),
    now: () => new Date().toISOString(),
    ...overrides,
  };

  const result = {
    version: AIRTABLE_HEALTH_VERSION,
    tokenLoaded: Boolean(deps.tokenLoaded),
    baseReachable: false,
    readSucceeded: false,
    writeAttempted: false,
    writeSucceeded: false,
    readAfterWriteSucceeded: false,
    reusedExistingProof: false,
    healthRecordId: null,
    error: null,
  };

  try {
    await deps.listRecords(TABLES.CONTROL, { maxRecords: 1 });
    result.baseReachable = true;
    result.readSucceeded = true;
  } catch (error) {
    result.error = safeAirtableError(error);
    return result;
  }

  try {
    const recent = await deps.listRecords(TABLES.ACTIVITY, {
      maxRecords: 200,
      sort: [{ field: 'Created At', direction: 'desc' }],
    });
    const existing = recent.find((row) => String(row.fields?.Detail || '').includes(AIRTABLE_HEALTH_VERSION));
    if (existing) {
      const reread = await deps.getRecord(TABLES.ACTIVITY, existing.id);
      result.writeSucceeded = true;
      result.readAfterWriteSucceeded = Boolean(reread?.id === existing.id);
      result.reusedExistingProof = true;
      result.healthRecordId = existing.id;
      return result;
    }
  } catch (error) {
    result.error = safeAirtableError(error);
    return result;
  }

  result.writeAttempted = true;
  const stamp = deps.now();
  try {
    const created = await deps.createRecord(TABLES.ACTIVITY, {
      Event: `ATLAS — airtable_write_health_check — ${stamp}`,
      Agent: 'ATLAS',
      'Action Type': 'airtable_write_health_check',
      Status: 'Done',
      Detail: `GhostOS production Airtable write health check ${AIRTABLE_HEALTH_VERSION}. Created by the same Airtable helper path used by lead dispatch. No customer record was modified.`,
      Consequential: false,
      'Created At': stamp,
    });
    result.writeSucceeded = true;
    result.healthRecordId = created.id;

    const reread = await deps.getRecord(TABLES.ACTIVITY, created.id);
    result.readAfterWriteSucceeded = Boolean(
      reread?.id === created.id &&
      String(reread.fields?.['Action Type'] || '') === 'airtable_write_health_check'
    );
    return result;
  } catch (error) {
    result.error = safeAirtableError(error);
    return result;
  }
}
