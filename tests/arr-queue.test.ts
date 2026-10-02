import { afterEach, describe, expect, it } from 'vitest';
import nock from 'nock';
import { ApiError, Http } from '../src/http';
import { SonarrClient } from '../src/clients/sonarr';
import { RadarrClient } from '../src/clients/radarr';
import {
  sonarrQueuePageSchema,
  sonarrQueueRecordSchema,
} from '../src/types/sonarr';
import {
  radarrQueuePageSchema,
  radarrQueueRecordSchema,
} from '../src/types/radarr';

const SONARR = 'http://sonarr.test';
const RADARR = 'http://radarr.test';
const KEY = 'test-key';
const PAGE_SIZE = 100;

// Synthetic contract samples exercise queue response fields and nullability;
// these are not recordings of real download rows.
function sonarrRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    seriesId: null,
    episodeId: null,
    seasonNumber: null,
    downloadId: null,
    title: 'Synthetic Series S01',
    status: 'future-status',
    trackedDownloadStatus: null,
    trackedDownloadState: 'future-tracking-state',
    protocol: 'future-protocol',
    size: null,
    sizeleft: 0,
    timeleft: null,
    statusMessages: [{ title: null, messages: null }],
    errorMessage: null,
    futureField: { retained: true },
    ...overrides,
  };
}

function radarrRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 11,
    movieId: null,
    downloadId: null,
    title: 'Synthetic Movie (2026)',
    status: 'queued',
    trackedDownloadStatus: 'warning',
    trackedDownloadState: 'importBlocked',
    protocol: 'torrent',
    size: 1234,
    sizeleft: null,
    timeleft: null,
    statusMessages: null,
    errorMessage: null,
    futureField: 'kept',
    ...overrides,
  };
}

function page(pageNumber: number, records: unknown[], totalRecords: number, overrides: Record<string, unknown> = {}) {
  return {
    page: pageNumber,
    pageSize: PAGE_SIZE,
    totalRecords,
    records,
    sortKey: 'timeleft',
    sortDirection: 'ascending',
    ...overrides,
  };
}

const sonarrParams = (pageNumber: number) => ({
  includeUnknownSeriesItems: 'true',
  includeSeries: 'false',
  includeEpisode: 'false',
  page: String(pageNumber),
  pageSize: String(PAGE_SIZE),
});

const radarrParams = (pageNumber: number) => ({
  includeUnknownMovieItems: 'true',
  includeMovie: 'false',
  page: String(pageNumber),
  pageSize: String(PAGE_SIZE),
});

afterEach(() => nock.cleanAll());

describe('Arr queue wire schemas', () => {
  it('preserves nullable associations, future status/protocol values, and extension fields', () => {
    const sonarr = sonarrQueueRecordSchema.parse(sonarrRow());
    expect(sonarr.seriesId).toBeNull();
    expect(sonarr.episodeId).toBeNull();
    expect(sonarr.seasonNumber).toBeNull();
    expect(sonarr.status).toBe('future-status');
    expect(sonarr.trackedDownloadState).toBe('future-tracking-state');
    expect(sonarr.protocol).toBe('future-protocol');
    expect(sonarr.futureField).toEqual({ retained: true });

    const radarr = radarrQueueRecordSchema.parse(radarrRow());
    expect(radarr.movieId).toBeNull();
    expect(radarr.status).toBe('queued');
    expect(radarr.futureField).toBe('kept');

    const ancillary = sonarrQueueRecordSchema.parse(sonarrRow({ id: null, size: 'unavailable', sizeleft: 'unknown' }));
    expect(ancillary.id).toBeNull();
    expect(ancillary.size).toBeNull();
    expect(ancillary.sizeleft).toBeNull();
  });

  it('requires positive page metadata, nonnegative totalRecords, and records arrays', () => {
    expect(sonarrQueuePageSchema.parse(page(1, [], 0)).records).toEqual([]);
    expect(radarrQueuePageSchema.parse(page(1, [], 0)).totalRecords).toBe(0);
    for (const invalid of [
      page(0, [], 0),
      page(1, [], 0, { pageSize: 0 }),
      page(1, [], -1),
      { page: 1, pageSize: PAGE_SIZE, totalRecords: 0 },
      { ...page(1, [], 0), records: null },
    ]) {
      expect(() => sonarrQueuePageSchema.parse(invalid)).toThrow();
      expect(() => radarrQueuePageSchema.parse(invalid)).toThrow();
    }
  });
});

describe('SonarrClient.getQueue', () => {
  it('uses the complete-query flags and accepts the valid empty first page', async () => {
    const scope = nock(SONARR)
      .matchHeader('X-Api-Key', KEY)
      .get('/api/v3/queue')
      .query(sonarrParams(1))
      .reply(200, page(1, [], 0));
    await expect(new SonarrClient(new Http({ baseUrl: SONARR, apiKey: KEY })).getQueue()).resolves.toEqual([]);
    expect(scope.isDone()).toBe(true);
  });

  it('fetches every page and preserves nullable fields and future values', async () => {
    const firstPage = Array.from({ length: PAGE_SIZE }, (_, index) => sonarrRow({ id: index + 1 }));
    const secondPage = [sonarrRow({ id: PAGE_SIZE + 1, seriesId: 22, episodeId: 301, seasonNumber: 1 })];
    const scope = nock(SONARR)
      .matchHeader('X-Api-Key', KEY)
      .get('/api/v3/queue').query(sonarrParams(1)).reply(200, page(1, firstPage, 101))
      .get('/api/v3/queue').query(sonarrParams(2)).reply(200, page(2, secondPage, 101));
    const rows = await new SonarrClient(new Http({ baseUrl: SONARR, apiKey: KEY })).getQueue();
    expect(rows).toHaveLength(101);
    expect(rows[0]!.status).toBe('future-status');
    expect(rows[0]!.seriesId).toBeNull();
    expect(rows[100]!.episodeId).toBe(301);
    expect(rows[0]!.futureField).toEqual({ retained: true });
    expect(scope.isDone()).toBe(true);
  });

  it('rejects rather than returning partial rows when a later page fails', async () => {
    const scope = nock(SONARR)
      .get('/api/v3/queue').query(sonarrParams(1)).reply(200, page(1, [sonarrRow()], 2))
      .get('/api/v3/queue').query(sonarrParams(2)).reply(503, 'synthetic server failure');
    await expect(new SonarrClient(new Http({ baseUrl: SONARR, apiKey: KEY })).getQueue()).rejects.toBeInstanceOf(ApiError);
    expect(scope.isDone()).toBe(true);
  });

  it.each([
    ['premature empty page', page(2, [], 2)],
    ['changed total count', page(2, [sonarrRow({ id: 2 })], 3)],
    ['wrong page metadata', page(3, [sonarrRow({ id: 2 })], 2)],
    ['wrong page size metadata', page(2, [sonarrRow({ id: 2 })], 2, { pageSize: 50 })],
  ])('rejects %s without returning the first page', async (_label, secondPage) => {
    nock(SONARR)
      .get('/api/v3/queue').query(sonarrParams(1)).reply(200, page(1, [sonarrRow({ id: 1 })], 2))
      .get('/api/v3/queue').query(sonarrParams(2)).reply(200, secondPage);
    await expect(new SonarrClient(new Http({ baseUrl: SONARR, apiKey: KEY })).getQueue()).rejects.toThrow();
  });

  it('rejects duplicate row IDs across pages when row IDs are present', async () => {
    nock(SONARR)
      .get('/api/v3/queue').query(sonarrParams(1)).reply(200, page(1, [sonarrRow({ id: 7 })], 2))
      .get('/api/v3/queue').query(sonarrParams(2)).reply(200, page(2, [sonarrRow({ id: 7 })], 2));
    await expect(new SonarrClient(new Http({ baseUrl: SONARR, apiKey: KEY })).getQueue()).rejects.toThrow();
  });

  it('rejects a page containing more rows than its requested pageSize', async () => {
    const rows = Array.from({ length: PAGE_SIZE + 1 }, (_, index) => sonarrRow({ id: index + 1 }));
    nock(SONARR)
      .get('/api/v3/queue').query(sonarrParams(1)).reply(200, page(1, rows, rows.length));
    await expect(new SonarrClient(new Http({ baseUrl: SONARR, apiKey: KEY })).getQueue()).rejects.toThrow();
  });

  it('rejects an incomplete walk after the 100-page safety bound', async () => {
    let calls = 0;
    const scope = nock(SONARR)
      .persist()
      .get('/api/v3/queue')
      .query((query) => query.includeUnknownSeriesItems === 'true' && query.includeSeries === 'false' && query.includeEpisode === 'false' && query.pageSize === String(PAGE_SIZE))
      .reply(200, (uri) => {
        calls += 1;
        const request = new URL(uri, SONARR);
        const pageNumber = Number(request.searchParams.get('page'));
        return page(pageNumber, [sonarrRow({ id: pageNumber })], 10_001);
      });
    await expect(new SonarrClient(new Http({ baseUrl: SONARR, apiKey: KEY })).getQueue()).rejects.toThrow(/100-page safety bound/);
    expect(calls).toBe(100);
    scope.persist(false);
  });
});

describe('RadarrClient.getQueue', () => {
  it('uses Radarr unknown-movie flags and preserves nullable IDs and future status strings', async () => {
    const scope = nock(RADARR)
      .matchHeader('X-Api-Key', KEY)
      .get('/api/v3/queue')
      .query(radarrParams(1))
      .reply(200, page(1, [radarrRow()], 1));
    const rows = await new RadarrClient(new Http({ baseUrl: RADARR, apiKey: KEY })).getQueue();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.movieId).toBeNull();
    expect(rows[0]!.status).toBe('queued');
    expect(rows[0]!.futureField).toBe('kept');
    expect(scope.isDone()).toBe(true);
  });
});
