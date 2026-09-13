function json(body, status) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store'
    }
  });
}

function safeError(error) {
  return {
    readSucceeded: false,
    writeSucceeded: false,
    statusCode: Number(error?.statusCode || error?.status) || 500,
    airtableCode: String(error?.error || error?.code || error?.name || 'HEALTH_CHECK_FAILED').slice(0, 200),
    message: String(error?.message || 'Airtable write health check failed.').slice(0, 2000)
  };
}

export default async () => {
  try {
    const module = await import('../../src/airtable-health.js');
    const result = await module.runAirtableWriteHealthCheck();
    const ok = Boolean(result?.writeSucceeded && result?.readAfterWriteSucceeded);
    const body = {
      readSucceeded: Boolean(result?.readSucceeded),
      writeSucceeded: ok,
      statusCode: result?.error?.statusCode || (ok ? 200 : 500),
      airtableCode: result?.error?.code || null,
      message: result?.error?.message || (ok ? 'Airtable read, write, and read-after-write succeeded.' : 'Airtable health check did not complete.')
    };
    return json(body, ok ? 200 : 500);
  } catch (error) {
    const body = safeError(error);
    return json(body, body.statusCode >= 400 && body.statusCode <= 599 ? body.statusCode : 500);
  }
};
