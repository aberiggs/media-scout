import { afterEach, describe, expect, it, vi } from 'vitest';
import { HTTPClient, OpenRouter } from '@openrouter/sdk';
import type { Fetcher } from '@openrouter/sdk';
import { z } from 'zod';
import { OpenRouterLLM } from '../src/clients/llm';

const TIMEOUT_MS = 60_000;
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

describe('OpenRouterLLM.json deadline', () => {
  it('aborts a never-resolving SDK transport at 60 seconds and settles the call', async () => {
    vi.useFakeTimers();
    let requestSignal: AbortSignal | undefined;
    const llm = build((input) => {
      requestSignal = (input as Request).signal;
      return new Promise<Response>((_resolve, reject) => {
        requestSignal!.addEventListener('abort', () => reject(requestSignal!.reason), { once: true });
      });
    });
    let settled = false;
    const result = call(llm).then(
      () => ({ ok: true as const }),
      (error: unknown) => ({ ok: false as const, error }),
    ).finally(() => { settled = true; });

    await vi.advanceTimersByTimeAsync(TIMEOUT_MS - 1);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);

    expect(settled).toBe(true);
    expect(requestSignal?.aborted).toBe(true);
    const outcome = await result;
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error).toMatchObject({ code: 'llm-timeout' });
  });

  it('cancels a response whose body stalls after headers arrive', async () => {
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
    let settled = false;
    const result = call(llm).then(
      () => ({ ok: true as const }),
      (error: unknown) => ({ ok: false as const, error }),
    ).finally(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(0);

    await vi.advanceTimersByTimeAsync(TIMEOUT_MS);

    expect(settled).toBe(true);
    expect(requestSignal?.aborted).toBe(true);
    const outcome = await result;
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error).toMatchObject({ code: 'llm-timeout' });
  });

  it('shares the deadline with the corrective JSON request and cancels that request', async () => {
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
    let settled = false;
    const result = call(llm).then(
      () => ({ ok: true as const }),
      (error: unknown) => ({ ok: false as const, error }),
    ).finally(() => { settled = true; });

    await vi.advanceTimersByTimeAsync(40_000);
    expect(calls).toBe(2);
    await vi.advanceTimersByTimeAsync(19_999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);

    expect(settled).toBe(true);
    expect(correctiveSignal?.aborted).toBe(true);
    const outcome = await result;
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error).toMatchObject({ code: 'llm-timeout' });
  });

  it('consumes a transport rejection that arrives after the public call timed out', async () => {
    vi.useFakeTimers();
    let rejectTransport!: (reason: unknown) => void;
    const llm = build(() => new Promise<Response>((_resolve, reject) => {
      rejectTransport = reject;
    }));
    const result = call(llm).then(
      () => ({ ok: true as const }),
      (error: unknown) => ({ ok: false as const, error }),
    );

    await vi.advanceTimersByTimeAsync(TIMEOUT_MS);
    const outcome = await result;
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error).toMatchObject({ code: 'llm-timeout' });

    rejectTransport(new Error('late transport rejection'));
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not start a scheduled 5xx retry after the deadline', async () => {
    vi.useFakeTimers();
    let calls = 0;
    const attempts: Array<{ logicalAttempt: number; transportAttempt: number }> = [];
    let requestSignal: AbortSignal | undefined;
    const llm = build((input) => {
      calls++;
      requestSignal = (input as Request).signal;
      return Promise.resolve(new Response(JSON.stringify({ error: { code: 503, message: 'busy' } }), {
        status: 503,
        headers: { 'content-type': 'application/json', 'retry-after': '120' },
      }));
    });
    let settled = false;
    const result = llm.json({ system: 'sys', user: 'user', schema, label: 'verdict', onAttempt: (attempt) => attempts.push(attempt) }).then(
      () => ({ ok: true as const }),
      (error: unknown) => ({ ok: false as const, error }),
    ).finally(() => { settled = true; });

    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toBe(1);
    await vi.advanceTimersByTimeAsync(TIMEOUT_MS);
    expect(settled).toBe(true);
    expect(requestSignal?.aborted).toBe(true);
    expect(calls).toBeGreaterThan(1);
    expect(attempts.length).toBe(calls);
    expect(attempts.every((attempt) => attempt.logicalAttempt === 0)).toBe(true);
    const callsAtDeadline = calls;
    await vi.advanceTimersByTimeAsync(120_000);

    expect(calls).toBe(callsAtDeadline);
    expect(attempts.length).toBe(callsAtDeadline);
    expect(vi.getTimerCount()).toBe(0);
    const outcome = await result;
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error).toMatchObject({ code: 'llm-timeout' });
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

  it('clears its deadline timer after a successful response', async () => {
    vi.useFakeTimers();
    const llm = build(() => Promise.resolve(reply('{"verdict":"grab"}')));

    await expect(call(llm)).resolves.toEqual({ verdict: 'grab' });

    expect(vi.getTimerCount()).toBe(0);
  });
});
