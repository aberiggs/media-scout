import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import pino from 'pino';
import { buildApp } from '../src/daemon';
import type { Stack } from '../src/compose';
import { State } from '../src/core/state';
import { GeneralSearchService } from '../src/core/general-search';
import { defaultSettings } from '../src/settings';

const apps: Array<{ close: () => Promise<void>; state: State }> = [];
afterEach(async () => { for (const app of apps.splice(0)) { await app.close(); app.state.close(); } });

async function fixture() {
  const state = State.open(':memory:');
  state.saveSettings(defaultSettings);
  const calls = { search: vi.fn(async (_raw:unknown, onEvent?: (event:Record<string,unknown>)=>void, _signal?:AbortSignal) => { onEvent?.({ sequence: 0, type: 'planning' }); onEvent?.({ sequence: 1, type: 'complete', response: { answer: 'done' } }); return { answer: 'done' }; }), status: vi.fn(async () => ({ nextOrdinal: 0 })) };
  const generalSearch = {
    createOperation: vi.fn(async (_id, raw) => ({ created: raw })), operationStatus: calls.status,
    stepOperation: vi.fn(async (_id, raw) => ({ stepped: raw })), stopOperation: vi.fn(async () => ({ stopped: true })),
  };
  const stack = { state, logger: pino({ level: 'silent' }), config: {}, createSnapshot: () => ({ generalSearch, generalSearchConversation: { search: calls.search } }) } as unknown as Stack;
  const app = await buildApp(stack); apps.push({ close: () => app.close(), state });
  return { app, calls, generalSearch };
}

describe('general-search additive HTTP integration', () => {
  it('returns actual stream progress and completion, and rejects cross-origin writes', async () => {
    const { app, calls } = await fixture();
    const denied = await app.inject({ method: 'POST', url: '/api/search/conversation', headers: { origin: 'https://elsewhere.test' }, payload: {} });
    expect(denied.statusCode).toBe(403);
    const response = await app.inject({ method: 'POST', url: '/api/search/conversation/stream', payload: {} });
    expect(response.headers['content-type']).toContain('application/x-ndjson');
    expect(response.body.split('\n').filter(Boolean).map((line) => JSON.parse(line).type)).toEqual(['planning', 'complete']);
    expect(calls.search).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['throws before progress', async (calls: Awaited<ReturnType<typeof fixture>>['calls']) => { calls.search.mockImplementationOnce(async () => { throw Object.assign(new Error('private upstream URL must not escape'), { code: 'search-expired' }); }); }, 'search-expired'],
    ['preserves a typed refusal', async (calls: Awaited<ReturnType<typeof fixture>>['calls']) => { calls.search.mockImplementationOnce(async () => { throw Object.assign(new Error('secret provider body'), { code: 'provider-refusal' }); }); }, 'provider-refusal'],
    ['preserves exhausted planning budget', async (calls: Awaited<ReturnType<typeof fixture>>['calls']) => { calls.search.mockImplementationOnce(async () => { throw Object.assign(new Error('secret'), { code: 'ai-budget-exhausted' }); }); }, 'ai-budget-exhausted'],
    ['preserves invalid planner output', async (calls: Awaited<ReturnType<typeof fixture>>['calls']) => { calls.search.mockImplementationOnce(async () => { throw Object.assign(new Error('secret'), { code: 'invalid-search-plan' }); }); }, 'invalid-search-plan'],
    ['returns without a terminal event', async (calls: Awaited<ReturnType<typeof fixture>>['calls']) => { calls.search.mockImplementationOnce(async () => ({ answer: 'ignored' })); }, 'operation-failed'],
  ])('emits one sequenced safe terminal error when service %s', async (_case, prepare, expectedCode) => {
    const { app, calls } = await fixture(); await prepare(calls);
    const response = await app.inject({ method: 'POST', url: '/api/search/conversation/stream', payload: {} });
    const events = response.body.split('\n').filter(Boolean).map((line) => JSON.parse(line));
    expect(events).toHaveLength(1);expect(events[0]).toMatchObject({ type:'error',sequence:0,code:expectedCode,message:expectedCode });
    expect(response.body).not.toContain('private upstream URL');
    expect(response.body).not.toContain('secret provider body');
    expect(response.body).not.toContain('secret');
  });

  it('ignores events and exceptions after the first terminal event', async () => {
    const { app, calls } = await fixture();
    calls.search.mockImplementationOnce(async (_raw, onEvent) => {
      onEvent?.({ type:'complete',sequence:91,response:{ answer:'done' } });
      onEvent?.({ type:'planning',sequence:92 });
      onEvent?.({ type:'error',sequence:93,code:'private-token',message:'private-token' });
      throw new Error('private exception URL https://private.example/token');
    });
    const response = await app.inject({ method:'POST',url:'/api/search/conversation/stream',payload:{} });
    const events=response.body.split('\n').filter(Boolean).map(line=>JSON.parse(line));
    expect(events).toEqual([{type:'complete',sequence:0,response:{answer:'done'}}]);
    expect(response.body).not.toContain('private');
  });

  it('aborts conversation work after a real TCP stream disconnect, not request-body completion', async () => {
    const { app,calls }=await fixture();
    let release!:()=>void,started!:()=>void,aborted!:()=>void,finished!:()=>void;
    const barrier=new Promise<void>(resolve=>{release=resolve;}),startedPromise=new Promise<void>(resolve=>{started=resolve;}),abortPromise=new Promise<void>(resolve=>{aborted=resolve;}),finishedPromise=new Promise<void>(resolve=>{finished=resolve;});
    let paidWork=0,abortedAfterBarrier=false;
    calls.search.mockImplementation(async(_raw,onEvent,signal)=>{
      signal?.addEventListener('abort',()=>aborted(),{once:true});
      onEvent?.({type:'planning',sequence:44});started();
      await barrier;
      if(signal?.aborted){abortedAfterBarrier=true;finished();return {answer:'cancelled'};}
      paidWork++;onEvent?.({type:'searching',sequence:45,query:'should-not-run',index:1,total:1});finished();return {answer:'done'};
    });
    await app.listen({host:'127.0.0.1',port:0});
    const address=app.server.address() as AddressInfo;
    let request!:ReturnType<typeof httpRequest>;
    const firstData=new Promise<Buffer>(resolve=>{
      request=httpRequest({host:'127.0.0.1',port:address.port,path:'/api/search/conversation/stream',method:'POST',headers:{'content-type':'application/json','content-length':2}},response=>{
        response.once('data',(chunk:Buffer)=>resolve(chunk));response.on('error',()=>{});
      });
      request.on('error',()=>{});request.end('{}');
    });
    const chunk=await firstData;await startedPromise;
    expect(chunk.toString()).toContain('"type":"planning"');
    expect(calls.search.mock.calls[0]?.[2]?.aborted).toBe(false);
    request.destroy();await abortPromise;release();await finishedPromise;
    expect(calls.search.mock.calls[0]?.[2]?.aborted).toBe(true);expect(abortedAfterBarrier).toBe(true);expect(paidWork).toBe(0);
  });

  it('keeps status GET read-only and uses explicit POST operations', async () => {
    const { app, generalSearch } = await fixture();
    const status = await app.inject({ method: 'GET', url: '/api/general-operations/operation-id' });
    expect(status.statusCode).toBe(200);
    expect(generalSearch.operationStatus).toHaveBeenCalledTimes(1);
    expect(generalSearch.stepOperation).not.toHaveBeenCalled();
    const created = await app.inject({ method: 'POST', url: '/api/search/search-id/operations', payload: { operationId: 'id' } });
    expect(created.statusCode).toBe(200);
    expect(generalSearch.createOperation).toHaveBeenCalledTimes(1);
  });

  it('submits an explicit 11-release manifest through the legacy route; configured and transport bounds reject without POST', async () => {
    const state = State.open(':memory:');
    const settings = structuredClone(defaultSettings);
    settings.integrations.prowlarr = { url: 'http://prowlarr.test', apiKey: 'private-key', tvClient: '', movieClient: '', generalClient: 'Download' };
    settings.safety.allowOperatorActions = true;
    settings.safety.dryRun = false;
    state.saveSettings(settings);
    const token = 't'.repeat(64);
    const hash = (value: string) => createHash('sha256').update(value).digest('hex');
    const searchId = randomUUID();
    const releases = Array.from({ length: 11 }, () => ({
      public: { releaseId: randomUUID(), title: 'safe release', indexer: 'Indexer', size: 1, seeders: 1, leechers: 0, age: 1, protocol: 'torrent' as const, selectable: true, unavailableReason: null },
      release: { guid: randomUUID(), indexerId: 7 }, sourceKey: randomUUID(), legacySourceKey: randomUUID(),
    }));
    const fingerprint = hash(JSON.stringify([settings.integrations.prowlarr.url, settings.integrations.prowlarr.apiKey, settings.integrations.prowlarr.generalClient, settings.safety.dryRun, settings.safety.allowOperatorActions]));
    state.saveGeneralSearchSnapshot({ id: searchId, tokenDigest: hash(token), expiresAt: '2026-10-07T00:00:00.000Z', fingerprint, clientName: 'Download', clientProtocol: 'torrent', clientId: 1, routingDigest: 'routing', dryRun: false, payload: { releases } });
    const client = { id: 1, name: 'Download', enable: true, protocol: 'torrent' as const, routingDigest: 'routing', supportsCategories: true, categories: [] };
    const prowlarr = { getDownloadClients: vi.fn(async () => [client]), grabGeneral: vi.fn(async () => {}) };
    const service = () => new GeneralSearchService({ llm: {} as never, prowlarr: prowlarr as never, state, getSettings: () => state.getSettings(), runtimeSettings: state.getSettings(), now: () => new Date('2026-10-06T00:00:00.000Z') });
    const stack = { state, logger: pino({ level: 'silent' }), config: {}, createSnapshot: () => ({ generalSearch: service() }) } as unknown as Stack;
    const app = await buildApp(stack); apps.push({ close: () => app.close(), state });
    const payload = { confirmationToken: token, releaseIds: releases.map(({ public: release }) => release.releaseId), confirmed: true };
    const response = await app.inject({ method: 'POST', url: `/api/search/${searchId}/grab`, payload });
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body).results).toHaveLength(11);
    expect(prowlarr.grabGeneral).toHaveBeenCalledTimes(11);

    const overconfigured = structuredClone(state.getSettings());
    overconfigured.generalSearch!.maxCandidates = 10;
    state.saveSettings(overconfigured);
    const before = prowlarr.grabGeneral.mock.calls.length;
    const configuredReject = await app.inject({ method: 'POST', url: `/api/search/${searchId}/grab`, payload });
    expect(configuredReject.statusCode).toBe(400);
    expect(prowlarr.grabGeneral).toHaveBeenCalledTimes(before);
    const tooMany = { ...payload, releaseIds: Array.from({ length: 1001 }, () => randomUUID()) };
    const transportReject = await app.inject({ method: 'POST', url: `/api/search/${searchId}/grab`, payload: tooMany });
    expect(transportReject.statusCode).toBe(400);
    expect(prowlarr.grabGeneral).toHaveBeenCalledTimes(before);
  });
});
