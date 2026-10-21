import { expect, it } from 'vitest';
import { modelOnlyTransport } from '../src/benchmarks/transport';

it('admits only the selected model endpoint and rejects redirects and every mutation destination', async () => {
  let requests = 0;
  const transport = modelOnlyTransport('https://models.invalid/api/v1', async () => { requests++; return new Response('{}'); });
  for (const url of ['https://models.invalid/api/v1/search', 'https://models.invalid/api/v1/chat/completions?url=x', 'https://arr.invalid/api/v3/command', 'https://private.invalid/download', 'http://models.invalid/api/v1/chat/completions']) {
    await expect(transport(url, { method: 'POST' })).rejects.toThrow(/denied/);
  }
  await transport('https://models.invalid/api/v1/chat/completions', { method: 'POST' });
  expect(requests).toBe(1);
  const redirect = modelOnlyTransport('https://models.invalid/api/v1', async () => new Response(null, { status: 302, headers: { location: 'https://private.invalid' } }));
  await expect(redirect('https://models.invalid/api/v1/chat/completions', { method: 'POST' })).rejects.toThrow(/redirect/);
});
