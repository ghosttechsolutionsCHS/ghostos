function safePayload(result = {}) {
  return {
    provider: 'anthropic',
    model: String(result.model || ''),
    success: Boolean(result.success),
    latencyMs: Number.isFinite(Number(result.latencyMs)) ? Number(result.latencyMs) : null,
    statusCode: Number.isFinite(Number(result.statusCode)) ? Number(result.statusCode) : null,
    code: result.code ? String(result.code).slice(0, 200) : null,
    message: String(result.message || 'Anthropic health check failed').slice(0, 1000),
  };
}

export default async () => {
  try {
    const { checkAnthropicHealth } = await import('../../src/ai-provider.js');
    const result = safePayload(await checkAnthropicHealth());
    return new Response(JSON.stringify(result), {
      status: result.success ? 200 : 503,
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
      },
    });
  } catch (error) {
    const result = safePayload({
      success: false,
      statusCode: Number(error?.statusCode || error?.status || 0) || null,
      code: error?.code || error?.name || 'HEALTH_ERROR',
      message: error?.message || 'Anthropic health check failed',
    });
    return new Response(JSON.stringify(result), {
      status: 500,
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
      },
    });
  }
};
