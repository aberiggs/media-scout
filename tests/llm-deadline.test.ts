import { afterEach, describe, expect, it, vi } from 'vitest';
import { HTTPClient, OpenRouter } from '@openrouter/sdk';
import type { Fetcher } from '@openrouter/sdk';
import { z } from 'zod';
import { OpenRouterLLM } from '../src/clients/llm';

const MODEL = 'z-ai/glm-5.3-flash';
const schema = z.object({ verdict: z.enum(['grab', 'manual', 'skip']) });

function build(fetcher: Fetcher) {
  const sdk = new OpenRouter({
    apiKey: 'test-key',
    serverURL: 'http://llm.test',
    httpClient: new HTTPClient({ fetcher }),
    retryConfig: { strategy: 'none' },
  });
  return new OpenRouterLLM({ client: sdk, model: MODEL });
}

function reply(content: string): Response {
  return new Response(JSON.stringify({
    id: 'resp1',
    created: 1700000000,
    object: 'chat.completion',
    model: MODEL,
    system_fingerprint: 'fp1',
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
  }), { status: 200, headers: { 'content-type': 'application/json' } });
}

function failure(headers: Record<string, string>): Response {
  return new Response(JSON.stringify({ error: { code: 503, message: 'busy' } }), {
    status: 503,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

function call(llm: OpenRouterLLM) {
  return llm.json({ system: 'sys', user: 'user', schema, label: 'verdict' });
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('OpenRouterLLM.json cancellation and retry behavior', () => {
  it('allows a slow successful response beyond 60 seconds', async () => {
    vi.useFakeTimers();
    const llm = build(() => new Promise<Response>((resolve) => setTimeout(() => resolve(reply('{"verdict":"skip"}')), 61_000)));
    const result = call(llm);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(61_000);
    await expect(result).resolves.toEqual({ verdict: 'skip' });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('cancels a response body stalled after headers when the caller aborts', async () => {
    vi.useFakeTimers();
    let requestSignal: AbortSignal | undefined;
    const llm = build((input) => {
      requestSignal = (input as Request).signal;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          requestSignal!.addEventListener('abort', () => {
            controller.error(requestSignal!.reason);
          }, { once: true });
        },
      });
      return Promise.resolve(new Response(body, {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }));
    });
    const caller = new AbortController();
    const remove = vi.spyOn(caller.signal, 'removeEventListener');
    const result = llm.json({ system: 'sys', user: 'user', schema, label: 'verdict', signal: caller.signal });
    await vi.advanceTimersByTimeAsync(0);
    caller.abort(Object.assign(new Error('caller cancelled'), { code: 'aborted' }));
    await expect(result).rejects.toMatchObject({ code: 'aborted' });
    expect(requestSignal?.aborted).toBe(true);
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
  });

  it('cancels the corrective JSON request when the caller aborts', async () => {
    vi.useFakeTimers();
    let calls = 0;
    let correctiveSignal: AbortSignal | undefined;
    const llm = build((input) => {
      calls++;
      if (calls === 1) {
        return new Promise<Response>((resolve) => {
          setTimeout(() => resolve(reply('not json')), 40_000);
        });
      }
      correctiveSignal = (input as Request).signal;
      return new Promise<Response>((_resolve, reject) => {
        correctiveSignal!.addEventListener('abort', () => reject(correctiveSignal!.reason), { once: true });
      });
    });
    const caller = new AbortController();
    const result = llm.json({ system: 'sys', user: 'user', schema, label: 'verdict', signal: caller.signal });

    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(40_000);
    expect(calls).toBe(2);
    caller.abort(Object.assign(new Error('caller cancelled'), { code: 'aborted' }));
    await expect(result).rejects.toMatchObject({ code: 'aborted' });
    expect(correctiveSignal?.aborted).toBe(true);
  });

  it('consumes a transport rejection that arrives after caller cancellation', async () => {
    vi.useFakeTimers();
    let rejectTransport!: (reason: unknown) => void;
    const llm = build(() => new Promise<Response>((_resolve, reject) => {
      rejectTransport = reject;
    }));
    const caller = new AbortController();
    const result = llm.json({ system: 'sys', user: 'user', schema, label: 'verdict', signal: caller.signal });
    await vi.advanceTimersByTimeAsync(0);
    caller.abort(Object.assign(new Error('caller cancelled'), { code: 'aborted' }));
    await expect(result).rejects.toMatchObject({ code: 'aborted' });

    rejectTransport(new Error('late transport rejection'));
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not start a scheduled 5xx retry after caller cancellation', async () => {
    vi.useFakeTimers();
    let calls = 0;
    const attempts: Array<{ logicalAttempt: number; transportAttempt: number }> = [];
    const llm = build(() => {
      calls++;
      return Promise.resolve(new Response(JSON.stringify({ error: { code: 503, message: 'busy' } }), {
        status: 503,
        headers: { 'content-type': 'application/json', 'retry-after': '120' },
      }));
    });
    const caller = new AbortController();
    const result = llm.json({ system: 'sys', user: 'user', schema, label: 'verdict', signal: caller.signal, onAttempt: (attempt) => attempts.push(attempt) });

    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toBe(1);
    expect(calls).toBe(1);
    caller.abort(Object.assign(new Error('caller cancelled'), { code: 'aborted' }));
    await expect(result).rejects.toMatchObject({ code: 'aborted' });
    await vi.advanceTimersByTimeAsync(120_000);

    expect(calls).toBe(1);
    expect(attempts).toEqual([{ logicalAttempt: 0, transportAttempt: 0 }]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    ['zero Retry-After seconds', { 'retry-after': '0' }],
    ['zero Retry-After milliseconds', { 'retry-after-ms': '0' }],
    ['expired Retry-After date', { 'retry-after': 'Wed, 21 Oct 2015 07:28:00 GMT' }],
    ['negative Retry-After seconds', { 'retry-after': '-1' }],
    ['overflowing Retry-After seconds', { 'retry-after': '1e308' }],
  ])('uses exponential fallback for %s', async (_description, headers) => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0.25);
    let calls = 0;
    const llm = build(() => Promise.resolve(++calls === 1
      ? failure(headers)
      : reply('{"verdict":"skip"}')));
    const result = call(llm);

    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toBe(1);
    await vi.advanceTimersByTimeAsync(249);
    expect(calls).toBe(1);
    await vi.advanceTimersByTimeAsync(1);

    await expect(result).resolves.toEqual({ verdict: 'skip' });
    expect(calls).toBe(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('honors a positive Retry-After duration', async () => {
    vi.useFakeTimers();
    let calls = 0;
    const llm = build(() => Promise.resolve(++calls === 1
      ? failure({ 'retry-after': '2' })
      : reply('{"verdict":"skip"}')));
    const result = call(llm);

    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toBe(1);
    await vi.advanceTimersByTimeAsync(1_999);
    expect(calls).toBe(1);
    await vi.advanceTimersByTimeAsync(1);

    await expect(result).resolves.toEqual({ verdict: 'skip' });
    expect(calls).toBe(2);
  });

  it('removes caller abort listener after successful completion', async () => {
    vi.useFakeTimers();
    const llm = build(() => Promise.resolve(reply('{"verdict":"grab"}')));
    const caller = new AbortController();
    const remove = vi.spyOn(caller.signal, 'removeEventListener');
    await expect(llm.json({ system: 'sys', user: 'user', schema, label: 'verdict', signal: caller.signal })).resolves.toEqual({ verdict: 'grab' });
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
    expect(vi.getTimerCount()).toBe(0);
  });
});
