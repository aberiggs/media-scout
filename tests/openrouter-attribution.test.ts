import { expect, it } from 'vitest';
import { getGlobalDispatcher, MockAgent, setGlobalDispatcher } from 'undici';
import pino from 'pino';
import type { Stack } from '../src/compose';
import { buildApp } from '../src/daemon';
import { SearchRuntime } from '../src/search/runtime';
import { defaultSettings } from '../src/search/settings';
import { openSearchStore } from '../src/search/store';

it.each([
  { baseUrl: 'https://openrouter.ai/api/v1', attributed: true, redirect: false },
  { baseUrl: 'https://openrouter.ai.example.test/api/v1', attributed: false, redirect: false },
  { baseUrl: 'https://openrouter.ai:8443/api/v1', attributed: false, redirect: false },
  { baseUrl: 'http://openrouter.ai/api/v1', attributed: false, redirect: false },
  { baseUrl: 'http://127.0.0.1:43210/api/v1', attributed: false, redirect: false },
  { baseUrl: 'https://openrouter.ai/api/v1', attributed: true, redirect: true },
])('scopes attribution on $baseUrl (redirect: $redirect)', async ({ baseUrl, attributed, redirect }) => {
  const settings = structuredClone(defaultSettings);
  settings.ai = { ...settings.ai, apiKey: 'fixture-model-key', model: 'fixture/model', baseUrl };
  settings.integrations.prowlarr = { ...settings.integrations.prowlarr, url: 'http://prowlarr.example.test', apiKey: 'fixture-prowlarr-key' };
  const runtime = new SearchRuntime({ initialSettings: settings, store: openSearchStore(':memory:') });
  const app = await buildApp({ runtime, logger: pino({ level: 'silent' }) } as unknown as Stack, { webRoot: '/missing' });
  const dispatcher = getGlobalDispatcher();
  const network = new MockAgent();
  network.disableNetConnect();
  setGlobalDispatcher(network);
  try {
    const daemon = new URL(await app.listen({ host: '127.0.0.1', port: 0 }));
    network.enableNetConnect(daemon.host);
    let outgoing: Headers | undefined;
    const base = new URL(baseUrl);
    const model = network.get(base.origin).intercept({ method: 'POST', path: `${base.pathname}/responses` });
    let redirected = false;
    if (redirect) {
      const target = new URL('https://redirect.example.test/responses');
      model.reply(307, request => {
        outgoing = new Headers(request.headers);
        return '';
      }, { headers: { location: target.href } });
      network.get(target.origin).intercept({ method: 'POST', path: target.pathname }).reply(400, () => {
        redirected = true;
        return '';
      });
    } else model.reply(200, request => {
      outgoing = new Headers(request.headers);
      return {
        id: 'fixture-response', object: 'response', created_at: 1, completed_at: 1, status: 'completed',
        error: null, incomplete_details: null, instructions: null, model: 'fixture/model',
        output: [{ id: 'final', type: 'function_call', call_id: 'final', name: 'finalize_release_set', status: 'completed',
          arguments: JSON.stringify({ status: 'no-match', selections: [], covered: [], gaps: [], deferred: [], broadCoverage: 'none', scopeGaps: [] }) }],
        parallel_tool_calls: false, tool_choice: 'auto', tools: [], usage: null, metadata: null,
        frequency_penalty: null, presence_penalty: null, temperature: null, top_p: null,
      };
    }, { headers: { 'content-type': 'application/json' } });

    const { searchId } = await runtime.startSearch({ prompt: 'Find a fixture' });
    await runtime.drain();
    if (!redirect) network.assertNoPendingInterceptors();
    expect(redirected, 'the Responses POST must not reach a different origin after an OpenRouter redirect').toBe(false);
    expect(await runtime.getSearch(searchId)).toMatchObject({ status: redirect ? 'failed' : 'no-match' });
    expect(outgoing?.get('authorization')).toBe('Bearer fixture-model-key');
    expect({
      referer: outgoing?.get('HTTP-Referer'),
      title: outgoing?.get('X-OpenRouter-Title'),
      visibility: outgoing?.get('X-OpenRouter-App-Visibility'),
    }).toEqual(attributed ? {
      referer: 'https://github.com/aberiggs/media-scout', title: 'Media Scout', visibility: 'hidden',
    } : {
      referer: process.env.OPENROUTER_HTTP_REFERER || null,
      title: process.env.OPENROUTER_APP_TITLE || null,
      visibility: null,
    });
  } finally {
    try { await app.close(); await runtime.close(); }
    finally { setGlobalDispatcher(dispatcher); await network.close(); }
  }
});
