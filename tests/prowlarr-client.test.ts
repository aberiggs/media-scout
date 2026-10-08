import { afterEach, describe, expect, it, vi } from 'vitest';
import nock from 'nock';
import { ApiError, Http } from '../src/http';
import { ProwlarrClient } from '../src/clients/prowlarr';
import type { Release } from '../src/types/prowlarr';
import releaseFixture from './fixtures/prowlarr-release.json';
import indexersFixture from './fixtures/prowlarr-indexers.json';
import indexerStatusFixture from './fixtures/prowlarr-indexerstatus.json';
import downloadClientsFixture from './fixtures/prowlarr-downloadclients.json';

const BASE = 'http://prowlarr.test';
const KEY = 'test-key';

const makeClient = (): ProwlarrClient =>
  new ProwlarrClient(new Http({ baseUrl: BASE, apiKey: KEY }));

afterEach(() => nock.cleanAll());

describe('ProwlarrClient.search', () => {
  it('passes caller cancellation through to the active HTTP search', async () => {
    let entered!:()=>void;const started=new Promise<void>(resolve=>{entered=resolve;});let requestSignal:AbortSignal|undefined;
    const http={getJson:vi.fn((_path:string,_params:unknown,signal?:AbortSignal)=>{requestSignal=signal;entered();return new Promise<unknown>((_resolve,reject)=>signal?.addEventListener('abort',()=>reject(signal.reason),{once:true}));})};
    const controller=new AbortController(),client=new ProwlarrClient(http as never);const pending=client.search({query:'active',categories:[]},controller.signal);await started;controller.abort(Object.assign(new Error('caller cancelled'),{code:'aborted'}));
    await expect(pending).rejects.toMatchObject({code:'aborted'});expect(http.getJson).toHaveBeenCalledWith('/api/v1/search',expect.any(Object),controller.signal);expect(requestSignal?.aborted).toBe(true);
  });
  it('GETs /api/v1/search with repeated-key array params and parses releases', async () => {
    const scope = nock(BASE)
      .get('/api/v1/search')
      .query({
        query: 'Frieren',
        type: 'search',
        categories: [5070, 5000],
        limit: 100,
      })
      .reply(200, [releaseFixture]);

    const releases = await makeClient().search({
      query: 'Frieren',
      categories: [5070, 5000],
      limit: 100,
    });

    expect(scope.isDone()).toBe(true);
    expect(releases).toHaveLength(1);
    expect(releases[0]!.guid).toBe('a1b2c3d4-e5f6-7890-abcd-ef0123456789');
    expect(releases[0]!.protocol).toBe('torrent');
    expect(releases[0]!.categories.map((c) => c.id)).toEqual([5070]);
  });

  it('sends indexerIds as repeated plain keys when given', async () => {
    const scope = nock(BASE)
      .get('/api/v1/search')
      .query((q) => {
        const ids = [...new URLSearchParams(q as unknown as string).getAll('indexerIds')]; // nock hands this matcher the raw query string; its types disagree
        return (
          ids.join(',') === '1,2' &&
          (q as Record<string, unknown>).type === 'search' &&
          !(q as Record<string, unknown>).sortKey
        );
      })
      .reply(200, []);

    const out = await makeClient().search({
      query: 'x',
      categories: [5070],
      indexerIds: [1, 2],
    });

    expect(out).toEqual([]);
    expect(scope.isDone()).toBe(true);
  });
});

describe('ProwlarrClient.getIndexerStatuses', () => {
  it('parses indexerstatus rows including null disabledTill', async () => {
    const scope = nock(BASE)
      .get('/api/v1/indexerstatus')
      .reply(200, indexerStatusFixture);

    const rows = await makeClient().getIndexerStatuses();

    expect(scope.isDone()).toBe(true);
    expect(rows).toHaveLength(2);
    expect(rows[0]!.disabledTill).toBe('2026-09-29T21:00:00Z');
    expect(rows[1]!.disabledTill).toBeNull();
  });
});

describe('ProwlarrClient.getIndexers', () => {
  it('parses configured indexer entries with their enabled state', async () => {
    const scope = nock(BASE)
      .get('/api/v1/indexer')
      .reply(200, indexersFixture);

    const indexers = await makeClient().getIndexers();

    expect(scope.isDone()).toBe(true);
    expect(indexers.map((i) => i.name)).toEqual(['Nyaa.si', 'PrivateTracker', 'AnimeTosho']);
    expect(indexers.filter((i) => i.enable).map((i) => i.id)).toEqual([5, 7]);
  });
});

describe('ProwlarrClient.getDownloadClients', () => {
  it('parses download-client entries with their categories', async () => {
    const scope = nock(BASE)
      .get('/api/v1/downloadclient')
      .reply(200, downloadClientsFixture);

    const clients = await makeClient().getDownloadClients();

    expect(scope.isDone()).toBe(true);
    expect(clients.map((c) => c.name)).toEqual(['qBit-TV', 'qBit-Movies']);
    expect(clients[0]!.categories[0]!.clientCategory).toBe('tv-sonarr');
    expect(clients[1]!.categories[0]!.clientCategory).toBe('radarr');
  });
});

describe('ProwlarrClient.grab', () => {
  it('POSTs the exact grab body with downloadClientId override', async () => {
    const scope = nock(BASE)
      .post(
        '/api/v1/search',
        { indexerId: 5, guid: releaseFixture.guid, downloadClientId: 1 },
      )
      .reply(200, {});

    await makeClient().grab(releaseFixture as never, 1);

    expect(scope.isDone()).toBe(true);
  });

  it('rejects a 404 stale-cache grab as ApiError{status:404}', async () => {
    nock(BASE)
      .post('/api/v1/search')
      .reply(404, {
        message: "Couldn't find requested release in cache",
      });

    let err: ApiError | undefined;
    try {
      // fixture approximates the wire shape; grab only reads indexerId/guid (zod-parsed in prod)
      await makeClient().grab(releaseFixture as unknown as Release, 1);
    } catch (e) {
      err = e as ApiError;
    }
    expect(err).toBeInstanceOf(ApiError);
    expect(err!.status).toBe(404);
    expect(err!.body).toContain('cache');
  });
});
