import { afterEach, describe, expect, it } from 'vitest';
import nock from 'nock';
import { z } from 'zod';
import { OpenRouter } from '@openrouter/sdk';
import { OpenRouterError } from '@openrouter/sdk/models/errors';
import { OpenRouterLLM } from '../src/clients/llm';
import { ApiError } from '../src/http';

const BASE = 'http://llm.test';
const MODEL = 'z-ai/glm-5.3-flash';
const schema = z.object({ verdict: z.enum(['grab', 'manual', 'skip']) });

/** Fresh SDK client per test: no retries (determinism) and the full-base serverURL seam. */
const build = () => {
  const sdk = new OpenRouter({
    apiKey: 'test-key',
    serverURL: BASE,
    retryConfig: { strategy: 'none' },
  });
  return { sdk, llm: new OpenRouterLLM({ client: sdk, model: MODEL }) };
};

const replyBody = (content: string) => ({
  id: 'resp1',
  created: 1700000000,
  object: 'chat.completion',
  model: MODEL,
  system_fingerprint: 'fp1',
  choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
});

afterEach(() => nock.cleanAll());

describe('OpenRouterLLM.json', () => {
  it('sends strict JSON Schema plus provider-compatible routing, strips fences, and parses output', async () => {
    const scope = nock(BASE)
      .matchHeader('Authorization', 'Bearer test-key')
      .post('/chat/completions', (body) => {
        expect(body.model).toBe(MODEL);
        expect(body.messages).toEqual([
          { role: 'system', content: 'sys prompt' },
          { role: 'user', content: 'user prompt' },
        ]);
        expect(body.response_format).toEqual({
          type: 'json_schema',
          json_schema: {
            name: 'llm_output',
            strict: true,
            schema: {
              type: 'object',
              properties: { verdict: { type: 'string', enum: ['grab', 'manual', 'skip'] } },
              required: ['verdict'],
              additionalProperties: false,
            },
          },
        });
        expect(body.provider).toEqual({ require_parameters: true });
        return true;
      })
      .reply(200, replyBody('```json\n{"verdict":"grab"}\n```'));
    const { llm } = build();
    const out = await llm.json({
      system: 'sys prompt',
      user: 'user prompt',
      schema,
      label: 'verdict',
    });
    expect(out).toEqual({ verdict: 'grab' });
    expect(scope.isDone()).toBe(true);
  });

  it('strips bare fences (``` ... ``` without json tag)', async () => {
    nock(BASE)
      .post('/chat/completions')
      .reply(200, replyBody('```\n{"verdict":"manual"}\n```'));
    const { llm } = build();
    const out = await llm.json({
      system: 's',
      user: 'u',
      schema,
      label: 'verdict',
    });
    expect(out).toEqual({ verdict: 'manual' });
  });

  it('parses a language-tagged fence whose closing fence is jammed against the JSON (live P7 shape)', async () => {
    // Cycle-1 live evidence: the OPENING of the fence was well-formed
    // ("```json\n[\n" appeared verbatim in the live error snippet); the
    // completion was malformed at the END. The old anchored regex required
    // \n``` at end-of-string, so a closing fence adjacent to JSON
    // (or trailing prose — covered by the next row) made it miss and left the
    // leading backticks for JSON.parse. Keep the payload an object to match the
    // provider's structured-output contract.
    nock(BASE)
      .post('/chat/completions')
      .reply(200, replyBody('```json\n{"items":[{"verdict":"grab"}]}```'));
    const { llm } = build();
    await expect(
      llm.json({
        system: 's',
        user: 'u',
        schema: z.object({ items: z.array(schema) }),
        label: 'verdict',
      }),
    ).resolves.toEqual({ items: [{ verdict: 'grab' }] });
  });

  it('leaves unfenced JSON containing embedded ``` markup intact', async () => {
    nock(BASE)
      .post('/chat/completions')
      .reply(200, replyBody('{"verdict":"manual","reason":"use ```grab``` style only"}'));
    const { llm } = build();
    await expect(
      llm.json({
        system: 's',
        user: 'u',
        schema: z.object({ verdict: z.enum(['grab', 'manual']), reason: z.string() }),
        label: 'verdict',
      }),
    ).resolves.toEqual({ verdict: 'manual', reason: 'use ```grab``` style only' });
  });

  it('parses a fence followed by trailing prose after the closing fence', async () => {
    nock(BASE)
      .post('/chat/completions')
      .reply(200, replyBody('```\n{"verdict":"grab"}\n```\nThat is my verdict.'));
    const { llm } = build();
    await expect(
      llm.json({ system: 's', user: 'u', schema, label: 'verdict' }),
    ).resolves.toEqual({ verdict: 'grab' });
  });

  it('parses a fence whose language tag is not followed by a newline', async () => {
    nock(BASE)
      .post('/chat/completions')
      .reply(200, replyBody('```json{"verdict":"grab"}\n```'));
    const { llm } = build();
    await expect(
      llm.json({ system: 's', user: 'u', schema, label: 'verdict' }),
    ).resolves.toEqual({ verdict: 'grab' });
  });

  it('does NOT salvage an unterminated fence: retry path fires, then the labeled error', async () => {
    const first = nock(BASE)
      .post('/chat/completions')
      .reply(200, replyBody('```json\n{"verdict":"grab"}'));
    const second = nock(BASE)
      .post('/chat/completions')
      .reply(200, replyBody('still broken'));
    const { llm } = build();
    await expect(llm.json({ system: 's', user: 'u', schema, label: 'verdict' })).rejects.toThrow(/unparseable JSON after retry/);
    expect(first.isDone()).toBe(true);
    expect(second.isDone()).toBe(true);
  });

  it('retries the same send exactly once on unparseable JSON, then succeeds', async () => {
    const first = nock(BASE)
      .post('/chat/completions')
      .reply(200, replyBody('I cannot answer that'));
    const second = nock(BASE)
      .post('/chat/completions', (body) => {
        expect(body.messages).toHaveLength(3);
        expect(body.messages[2].content).toMatch(/Correction: Return only a JSON value/i);
        expect(body.response_format.json_schema.strict).toBe(true);
        expect(body.provider.require_parameters).toBe(true);
        return true;
      })
      .reply(200, replyBody('{"verdict":"skip"}'));
    const { llm } = build();
    const out = await llm.json({ system: 's', user: 'u', schema, label: 'verdict' });
    expect(out).toEqual({ verdict: 'skip' });
    expect(first.isDone()).toBe(true);
    expect(second.isDone()).toBe(true);
  });

  it('reports each initial and corrective logical attempt', async () => {
    nock(BASE).post('/chat/completions').reply(200, replyBody('not json'));
    nock(BASE).post('/chat/completions').reply(200, replyBody('{"verdict":"skip"}'));
    const { llm } = build();
    const attempts: Array<{ logicalAttempt: number; transportAttempt: number }> = [];
    await llm.json({ system: 's', user: 'u', schema, label: 'verdict', onAttempt: (attempt) => attempts.push(attempt) });
    expect(attempts).toEqual([
      { logicalAttempt: 0, transportAttempt: 0 },
      { logicalAttempt: 1, transportAttempt: 0 },
    ]);
  });

  it('propagates onAttempt rejection before sending a request', async () => {
    let calls = 0;
    const stub = { chat: { send: async () => { calls++; } } } as unknown as OpenRouter;
    const llm = new OpenRouterLLM({ client: stub, model: MODEL });
    const failure = new Error('attempt rejected');
    await expect(llm.json({ system: 's', user: 'u', schema, label: 'verdict', onAttempt: () => { throw failure; } }))
      .rejects.toBe(failure);
    expect(calls).toBe(0);
  });

  it('throws with the label after garbage content twice', async () => {
    nock(BASE).post('/chat/completions').reply(200, replyBody('nope'));
    nock(BASE).post('/chat/completions').reply(200, replyBody('still nope'));
    const { llm } = build();
    await expect(llm.json({ system: 's', user: 'u', schema, label: 'verdict' })).rejects.toThrow(/verdict/);
  });

  it('never interprets prose verdicts as structured decisions', async () => {
    const prose = '**Verdict: Grab** — this release looks best.';
    nock(BASE).post('/chat/completions').reply(200, replyBody(prose));
    nock(BASE).post('/chat/completions').reply(200, replyBody(prose));
    const { llm } = build();
    await expect(llm.json({ system: 's', user: 'u', schema, label: 'picker' })).rejects.toThrow(/unparseable JSON after retry/);
  });

  it('throws the zod error on schema-invalid JSON without retry', async () => {
    const scope = nock(BASE)
      .post('/chat/completions')
      .reply(200, replyBody('{"verdict":"maybe"}'));
    const { llm } = build();
    await expect(llm.json({ system: 's', user: 'u', schema, label: 'verdict' })).rejects.toThrow(/Invalid option/i);
    expect(scope.isDone()).toBe(true);
  });

  it('throws when the SDK response is a stream instead of a completion', async () => {
    // Test seam: the SDK types say ChatCompletion, but its runtime can hand back a
    // ReadableStream when streaming sneaks through; cast so the guard is exercisable.
    const stub = {
      chat: { send: async () => new ReadableStream() },
    } as unknown as OpenRouter;
    const llm = new OpenRouterLLM({ client: stub, model: MODEL });
    await expect(llm.json({ system: 's', user: 'u', schema, label: 'verdict' })).rejects.toThrow(/stream/i);
  });

  it('throws safely on no-content instead of inventing a JSON decision', async () => {
    const scope = nock(BASE)
      .post('/chat/completions')
      .reply(200, {
        ...replyBody(''),
        choices: [{
          index: 0,
          message: { role: 'assistant', content: null },
          finish_reason: 'stop',
        }],
      });
    const { llm } = build();
    await expect(llm.json({ system: 's', user: 'u', schema, label: 'picker' })).rejects.toThrow(/no string message content/);
    expect(scope.isDone()).toBe(true);
  });

  it('rejects an explicit refusal even when the same message contains valid grab JSON', async () => {
    const refusal = 'I cannot make this decision.';
    const scope = nock(BASE)
      .post('/chat/completions')
      .reply(200, {
        ...replyBody('{"verdict":"grab"}'),
        choices: [{
          index: 0,
          message: { role: 'assistant', content: '{"verdict":"grab"}', refusal },
          finish_reason: 'stop',
        }],
      });
    const { llm } = build();
    let caught: unknown;
    try {
      await llm.json({ system: 's', user: 'u', schema, label: 'picker' });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as {code:string}).code).toBe('provider-refusal');
    expect((caught as Error).message).toBe('LLM completion included a refusal');
    expect((caught as Error).message).not.toContain(refusal);
    expect(scope.isDone()).toBe(true);
  });

  it('propagates transport errors without retrying them as malformed output', async () => {
    let calls = 0;
    const stub = {
      chat: {
        send: async () => {
          calls += 1;
          throw new Error('provider unavailable');
        },
      },
    } as unknown as OpenRouter;
    const llm = new OpenRouterLLM({ client: stub, model: MODEL });
    await expect(llm.json({ system: 's', user: 'u', schema, label: 'picker' })).rejects.toThrow('provider unavailable');
    expect(calls).toBe(1);
  });

  it('returns a typed deadline outcome without exposing provider details', async () => {
    const stub = { chat: { send: async () => new Promise<never>(() => {}) } } as unknown as OpenRouter;
    const llm = new OpenRouterLLM({ client: stub, model: MODEL, timeoutMs: 5 });
    await expect(llm.json({ system: 's', user: 'u', schema, label: 'picker' })).rejects.toMatchObject({ code: 'llm-timeout', name: 'TimeoutError' });
  });

  it('aborts an active provider request promptly and does not start correction or another attempt', async () => {
    let entered!:()=>void;const started=new Promise<void>(resolve=>{entered=resolve;});let sends=0,received:AbortSignal|undefined;
    const stub={chat:{send:async(_input:unknown,options:{signal:AbortSignal})=>{sends++;received=options.signal;entered();return new Promise<never>((_resolve,reject)=>options.signal.addEventListener('abort',()=>reject(options.signal.reason),{once:true}));}}} as unknown as OpenRouter;
    const llm=new OpenRouterLLM({client:stub,model:MODEL});const controller=new AbortController();const attempts:Array<{logicalAttempt:number;transportAttempt:number}>=[];
    const pending=llm.json({system:'s',user:'u',schema,label:'cancelled',signal:controller.signal,onAttempt:attempt=>attempts.push(attempt)});await started;controller.abort(Object.assign(new Error('caller cancelled'),{code:'aborted'}));
    await expect(pending).rejects.toMatchObject({code:'aborted'});expect(received?.aborted).toBe(true);expect(sends).toBe(1);expect(attempts).toEqual([{logicalAttempt:0,transportAttempt:0}]);
  });

  it('cancellation during transport backoff prevents another paid provider attempt', async () => {
    let firstAttempt!:()=>void;const entered=new Promise<void>(resolve=>{firstAttempt=resolve;});let sends=0;
    const serverError=Object.assign(Object.create(OpenRouterError.prototype),{statusCode:503,headers:new Headers()}) as OpenRouterError;
    const stub={chat:{send:async()=>{sends++;throw serverError;}}} as unknown as OpenRouter;const llm=new OpenRouterLLM({client:stub,model:MODEL});const controller=new AbortController();
    const attempts:Array<{logicalAttempt:number;transportAttempt:number}>=[];const pending=llm.json({system:'s',user:'u',schema,label:'cancel retry',signal:controller.signal,onAttempt:attempt=>{attempts.push(attempt);if(attempt.transportAttempt===0)firstAttempt();}});
    await entered;controller.abort(Object.assign(new Error('caller cancelled'),{code:'aborted'}));await expect(pending).rejects.toMatchObject({code:'aborted'});
    expect(sends).toBe(1);expect(attempts).toHaveLength(1);
  });

  it('preserves shared ApiError status and Retry-After transport metadata for non-search callers', async () => {
    nock(BASE).post('/chat/completions').reply(429, 'private provider body', { 'Retry-After': '120' });
    const { llm } = build();
    let caught: unknown;
    try { await llm.json({ system: 's', user: 'u', schema, label: 'monitoring planner' }); } catch (error) { caught = error; }
    expect(caught).toBeInstanceOf(ApiError);
    expect(caught).toMatchObject({ status: 429, retryAfter: 120 });
    expect((caught as Error).message).not.toContain('private provider body');
  });
});
