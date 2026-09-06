export function createSentryClient({ fetchImpl = globalThis.fetch, base = '/sentry-api' } = {}) {
  async function request(path, { signal, body } = {}) {
    const timeout = AbortSignal.timeout(10000);
    const response = await fetchImpl(`${base}${path}`, {
      method: body ? 'POST' : 'GET', cache: 'no-store',
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      headers: body ? { 'Content-Type': 'application/json' } : {},
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload?.error?.message || payload?.message || `SENTRY HTTP ${response.status}`);
    return payload;
  }
  return {
    get: (path, signal) => request(path, { signal }),
    // This is called only by an explicit operator action in the SENTRY panel.
    command: (body) => request('/golden-demo/session/commands', { body }),
  };
}
