/** Model capability only: no indexer, Arr, download or redirect capability. */
export function modelOnlyTransport(baseUrl: string, send: typeof fetch = fetch): typeof fetch {
  const base = new URL(baseUrl);
  if (!['https:', 'http:'].includes(base.protocol) || base.username || base.password || base.search || base.hash) throw new Error('model endpoint denied');
  const path = base.pathname.replace(/\/$/, '') + '/chat/completions';
  return async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (url.origin !== base.origin || url.pathname !== path || url.search || url.hash || request.method !== 'POST') throw new Error('benchmark transport denied');
    const response = await send(new Request(request, { redirect: 'manual' }));
    if (response.status >= 300 && response.status < 400 || response.redirected) throw new Error('benchmark redirect denied');
    return response;
  };
}
