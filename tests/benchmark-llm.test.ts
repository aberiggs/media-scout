import { afterEach, expect, it } from 'vitest';
import nock from 'nock';
import { OpenRouter } from '@openrouter/sdk';
import { z } from 'zod';
import { OpenRouterLLM, type LLMAttemptEvent } from '../src/clients/llm';

const base = 'http://benchmark-model.test';
const body = (content: string) => ({ id: 'one', created: 1, object: 'chat.completion', model: 'test', system_fingerprint: null, choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }] });
afterEach(() => nock.cleanAll());
it('accounts malformed JSON and correction separately, preserving unknown cost', async () => {
  const events: LLMAttemptEvent[] = [];
  nock(base).post('/chat/completions').reply(200, { ...body('bad'), usage: { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15, cost: 0.001 } });
  nock(base).post('/chat/completions').reply(200, body('{"ok":true}'));
  const llm = new OpenRouterLLM({ client: new OpenRouter({ apiKey: 'canary', serverURL: base }), model: 'test', maxAttempts: 2, onAttempt: e => events.push(e) });
  await expect(llm.json({ system: 's', user: 'u', schema: z.object({ ok: z.boolean() }), label: 'test' })).resolves.toEqual({ ok: true });
  expect(events.map(e => [e.valid, e.failure, e.correction, e.cost])).toEqual([[false, 'invalid-json', false, 0.001], [true, null, true, null]]);
  expect(events[0]!.logicalCallId).toBe(events[1]!.logicalCallId);
  expect(events[0]!.attemptId).not.toBe(events[1]!.attemptId);
});
it('counts transport failures against the attempt ceiling and redacts their bodies', async () => {
  const events: LLMAttemptEvent[] = [];
  nock(base).post('/chat/completions').reply(503, { error: { message: 'private-secret' } });
  const llm = new OpenRouterLLM({ client: new OpenRouter({ apiKey: 'canary', serverURL: base }), model: 'test', maxAttempts: 1, onAttempt: e => events.push(e) });
  await expect(llm.json({ system: 's', user: 'u', schema: z.object({ ok: z.boolean() }), label: 'test' })).rejects.toThrow();
  expect(events).toHaveLength(1);
  expect(events[0]!.failure).toBe('provider-error');
  expect(JSON.stringify(events)).not.toContain('private-secret');
});
it('records schema rejection without retry and bounds emitted output tokens', async () => {
  const events: LLMAttemptEvent[] = [];
  const scope = nock(base).post('/chat/completions', b => b.max_tokens === 64).reply(200, body('{"ok":"bad"}'));
  const llm = new OpenRouterLLM({ client: new OpenRouter({ apiKey: 'canary', serverURL: base }), model: 'test', maxOutputTokens: 64, onAttempt: e => events.push(e) });
  await expect(llm.json({ system: 's', user: 'u', schema: z.object({ ok: z.boolean() }), label: 'test' })).rejects.toThrow();
  expect(scope.isDone()).toBe(true);
  expect(events.map(e => e.failure)).toEqual(['schema-error']);
});
it('does not emit unexpected provider-returned model strings', async () => {
  const events: LLMAttemptEvent[] = [];
  nock(base).post('/chat/completions').reply(200, { ...body('{"ok":true}'), model: 'Bearer sk-proj-AbCdEfGhIjKlMnOp' });
  const llm = new OpenRouterLLM({ client: new OpenRouter({ apiKey: 'canary', serverURL: base }), model: 'test', onAttempt: e => events.push(e) });
  await llm.json({ system: 's', user: 'u', schema: z.object({ ok: z.boolean() }), label: 'test' });
  expect(events[0]!.model).toBeNull();
  expect(JSON.stringify(events)).not.toMatch(/Bearer|sk-proj/);
});
