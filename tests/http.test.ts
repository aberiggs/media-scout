import { afterEach, describe, expect, it, vi } from 'vitest';
import nock from 'nock';
import { ApiError, Http } from '../src/http';

const BASE = 'http://http.test';
const KEY = 'test-key';

/** Capture expected rejections as ApiError without unknown-typed catch clutter (4 call sites). */
const catchAs = async (p: Promise<unknown>): Promise<ApiError> => {
  try {
    await p;
    throw new Error('expected a rejection');
  } catch (e) {
    return e as ApiError;
  }
};

afterEach(() => nock.cleanAll());
afterEach(() => vi.unstubAllGlobals());

describe('Http.getJson', () => {
  it('sends X-Api-Key, repeated-key array params, and parses the JSON body', async () => {
    const scope = nock(BASE)
      .matchHeader('X-Api-Key', KEY)
      .matchHeader('Accept', 'application/json')
      .get('/api/v1/search')
      .query({
        query: 'Frieren',
        type: 'search',
        indexerIds: [1, 2],
        categories: [5070, 5000],
        limit: 100,
      })
      .reply(200, [{ guid: 'g1' }]);
    const http = new Http({ baseUrl: BASE, apiKey: KEY });
    const out = await http.getJson('/api/v1/search', {
      query: 'Frieren',
      type: 'search',
      indexerIds: [1, 2],
      categories: [5070, 5000],
      limit: 100,
    });
    expect(out).toEqual([{ guid: 'g1' }]);
    expect(scope.isDone()).toBe(true);
  });

  it('throws ApiError{status,url,body} on non-2xx', async () => {
    nock(BASE)
      .get('/api/v1/search')
      .query(true)
      .reply(404, "Couldn't find requested release in cache, try searching again");
    const http = new Http({ baseUrl: BASE, apiKey: KEY });
    const err = await catchAs(http.getJson('/api/v1/search', { query: 'x' }));
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(404);
    expect(err.url).toContain('/api/v1/search');
    expect(err.body).toContain("Couldn't find requested release");
    expect(err.retryAfter).toBeUndefined();
  });

  it('extracts retryAfter seconds from a 429 Retry-After header', async () => {
    nock(BASE)
      .get('/api/v1/search')
      .query(true)
      .reply(429, 'Indexer Query Limit reached', { 'Retry-After': '120' });
    const http = new Http({ baseUrl: BASE, apiKey: KEY });
    const err = await catchAs(http.getJson('/api/v1/search', { query: 'x' }));
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(429);
    expect(err.retryAfter).toBe(120);
  });

  it('converts an HTTP-date Retry-After into seconds', async () => {
    const retryDate = new Date(Date.now() + 60_000).toUTCString();
    nock(BASE)
      .get('/api/v1/search')
      .query(true)
      .reply(429, 'slow down', { 'Retry-After': retryDate });
    const http = new Http({ baseUrl: BASE, apiKey: KEY });
    const err = await catchAs(http.getJson('/api/v1/search', { query: 'x' }));
    expect(err.retryAfter).toBeGreaterThanOrEqual(59);
    expect(err.retryAfter).toBeLessThanOrEqual(60);
  });

  it('wraps a mid-body timeout abort in ApiError status 0 (regression: was misclassified as invalid JSON with the response status)', async () => {
    nock(BASE)
      .get('/api/v1/search')
      .query(true)
      .delayBody(500)
      .reply(200, {});
    const http = new Http({ baseUrl: BASE, apiKey: KEY, timeoutMs: 20 });
    const err = await catchAs(http.getJson('/api/v1/search', { query: 'x' }));
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(0);
    expect(err.body.toLowerCase()).toMatch(/abort|timeout/);
  });

  it('wraps a pre-response timeout in ApiError with status 0', async () => {
    nock(BASE)
      .get('/api/v1/search')
      .query(true)
      .delayConnection(500)
      .reply(200, {});
    const http = new Http({ baseUrl: BASE, apiKey: KEY, timeoutMs: 20 });
    const err = await catchAs(http.getJson('/api/v1/search', { query: 'x' }));
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(0);
  });

  it('propagates caller cancellation to an active fetch without disguising it as a timeout ApiError', async () => {
    let entered!:()=>void;const started=new Promise<void>(resolve=>{entered=resolve;});let requestSignal:AbortSignal|undefined;
    vi.stubGlobal('fetch',vi.fn(async(_input:unknown,init:RequestInit)=>new Promise<Response>((_resolve,reject)=>{requestSignal=init.signal as AbortSignal;entered();requestSignal.addEventListener('abort',()=>reject(requestSignal?.reason),{once:true});})));
    const controller=new AbortController(),http=new Http({baseUrl:BASE,apiKey:KEY,timeoutMs:5000});const pending=http.getJson('/api/v1/search',{query:'active'},controller.signal);await started;
    controller.abort(Object.assign(new Error('caller cancelled'),{code:'aborted'}));await expect(pending).rejects.toMatchObject({code:'aborted'});expect(requestSignal?.aborted).toBe(true);
  });
});

describe('Http.postJson', () => {
  it('sends the JSON body with Content-Type and parses the response', async () => {
    const scope = nock(BASE)
      .matchHeader('Content-Type', 'application/json')
      .post('/api/v1/search', { indexerId: 5, guid: 'g1', downloadClientId: 1 })
      .reply(201, { ok: true });
    const http = new Http({ baseUrl: BASE, apiKey: KEY });
    const out = await http.postJson('/api/v1/search', {
      indexerId: 5,
      guid: 'g1',
      downloadClientId: 1,
    });
    expect(out).toEqual({ ok: true });
    expect(scope.isDone()).toBe(true);
  });
});
