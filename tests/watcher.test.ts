import { afterEach, describe, expect, it, vi } from 'vitest';
import nock from 'nock';
import { readFileSync } from 'node:fs';
import { ApiError, Http } from '../src/http';
import { SonarrClient } from '../src/clients/sonarr';
import { RadarrClient } from '../src/clients/radarr';
import { Watcher } from '../src/core/watcher';

const SONARR = 'http://sonarr.test';
const RADARR = 'http://radarr.test';
const KEY = 'test-key';

const seriesFixture = JSON.parse(
  readFileSync(new URL('./fixtures/sonarr-series.json', import.meta.url), 'utf8'),
) as Record<string, unknown>;
const episodesFixture = JSON.parse(
  readFileSync(new URL('./fixtures/sonarr-episodes.json', import.meta.url), 'utf8'),
) as unknown[];
const movieFixture = JSON.parse(
  readFileSync(new URL('./fixtures/radarr-movie.json', import.meta.url), 'utf8'),
) as Record<string, unknown>;

const NOW = new Date('2026-09-29T00:00:00Z');

const episode = (overrides: Record<string, unknown>) => ({
  id: 0,
  seriesId: 1,
  seasonNumber: 1,
  episodeNumber: 1,
  title: 'Episode',
  airDate: '2023-10-20',
  monitored: true,
  hasFile: false,
  ...overrides,
});

const makeWatcher = (
  opts: { now?: Date; onError?: (error: unknown, context: string) => void } = {},
) =>
  new Watcher({
    sonarr: new SonarrClient(new Http({ baseUrl: SONARR, apiKey: KEY })),
    radarr: new RadarrClient(new Http({ baseUrl: RADARR, apiKey: KEY })),
    now: () => opts.now ?? NOW,
    onError: opts.onError ?? ((error) => { throw error; }),
  });

const errorCalls = (onError: { mock: { calls: unknown[][] } }) =>
  onError.mock.calls.map(
    ([error, context]) => [error as unknown, context as string] as const,
  );

const mockEmptyMovies = () => nock(RADARR).get('/api/v3/movie').reply(200, []);
const mockEmptySeries = () => nock(SONARR).get('/api/v3/series').reply(200, []);

afterEach(() => nock.cleanAll());

describe('Watcher.getWorkUnits — happy paths', () => {
  it('builds one TV unit per season with missing aired monitored episodes', async () => {
    const seriesScope = nock(SONARR)
      .matchHeader('X-Api-Key', KEY)
      .get('/api/v3/series')
      .reply(200, [seriesFixture]);
    const episodeScope = nock(SONARR)
      .get('/api/v3/episode')
      .query({ seriesId: 1 })
      .reply(200, episodesFixture);
    const movieScope = nock(RADARR).get('/api/v3/movie').reply(200, []);

    const units = await makeWatcher().getWorkUnits();

    expect(seriesScope.isDone()).toBe(true);
    expect(episodeScope.isDone()).toBe(true);
    expect(movieScope.isDone()).toBe(true);
    expect(units).toHaveLength(1);
    const unit = units[0]!;
    expect(unit.key).toBe('sonarr:1:s1');
    expect(unit.kind).toBe('tv');
    expect(unit.arr).toBe('sonarr');
    expect(unit.serviceId).toBe(1);
    expect(unit.externalId).toBe(368013);
    expect(unit.title).toBe("Frieren: Beyond Journey's End");
    expect(unit.altTitles).toEqual(['Sousou no Frieren']);
    expect(unit.seriesType).toBe('anime');
    expect(unit.season).toEqual({
      seasonNumber: 1,
      missing: [
        {
          episodeId: 101,
          episodeNumber: 7,
          absoluteEpisodeNumber: 7,
          title: 'Like a Fairy Tale',
        },
      ],
    });
  });

  it('passes through multiple alternateTitles and non-anime series types', async () => {
    const standard = {
      ...seriesFixture,
      id: 2,
      tvdbId: 42,
      title: 'Standard Show',
      seriesType: 'standard',
      alternateTitles: [
        { title: 'Alt A', seasonNumber: -1 },
        { title: 'Alt B', seasonNumber: -1 },
      ],
      seasons: [],
      statistics: { episodeFileCount: 0, totalEpisodeCount: 1, sizeOnDisk: 0, percentOfEpisodes: 0 },
    };
    const daily = { ...seriesFixture, id: 3, tvdbId: 43, title: 'Daily Show', seriesType: 'daily', alternateTitles: [], seasons: [] };
    nock(SONARR).get('/api/v3/series').reply(200, [standard, daily]);
    nock(SONARR)
      .get('/api/v3/episode')
      .query({ seriesId: 2 })
      .reply(200, [episode({ id: 201, seriesId: 2, episodeNumber: 1 })]);
    nock(SONARR)
      .get('/api/v3/episode')
      .query({ seriesId: 3 })
      .reply(200, [episode({ id: 301, seriesId: 3, episodeNumber: 1 })]);
    mockEmptyMovies();

    const units = await makeWatcher().getWorkUnits();
    expect(units).toHaveLength(2);
    expect(units[0]).toMatchObject({ key: 'sonarr:2:s1', title: 'Standard Show', seriesType: 'standard' });
    expect(units[0]!.altTitles).toEqual(['Alt A', 'Alt B']);
    expect(units[1]).toMatchObject({ key: 'sonarr:3:s1', title: 'Daily Show', seriesType: 'daily' });
    expect(units[1]!.altTitles).toEqual([]);
  });

  it('creates one unit per missing available monitored movie', async () => {
    mockEmptySeries();
    nock(RADARR).get('/api/v3/movie').reply(200, [movieFixture]);

    const units = await makeWatcher().getWorkUnits();
    expect(units).toEqual([
      {
        key: 'radarr:3',
        kind: 'movie',
        arr: 'radarr',
        serviceId: 3,
        externalId: 671,
        title: "Harry Potter and the Philosopher's Stone",
        year: 2001,
        altTitles: [],
      },
    ]);
  });

  it('groups missing episodes of multiple series into separate units', async () => {
    const seriesB = {
      ...seriesFixture,
      id: 2,
      tvdbId: 42,
      title: 'Second Show',
      seriesType: 'standard',
      alternateTitles: [],
      seasons: [],
      statistics: { episodeFileCount: 0, totalEpisodeCount: 1, sizeOnDisk: 0, percentOfEpisodes: 0 },
    };
    nock(SONARR).get('/api/v3/series').reply(200, [seriesFixture, seriesB]);
    nock(SONARR)
      .get('/api/v3/episode')
      .query({ seriesId: 1 })
      .reply(200, episodesFixture);
    nock(SONARR)
      .get('/api/v3/episode')
      .query({ seriesId: 2 })
      .reply(200, [
        episode({
          id: 201,
          seriesId: 2,
          seasonNumber: 2,
          absoluteEpisodeNumber: null,
          title: 'Pilot',
        }),
      ]);
    nock(RADARR).get('/api/v3/movie').reply(200, [movieFixture]);

    const units = await makeWatcher().getWorkUnits();
    expect(units.map((u) => u.key)).toEqual(['sonarr:1:s1', 'sonarr:2:s2', 'radarr:3']);
    expect(units[1]!.season?.missing).toEqual([
      {
        episodeId: 201,
        episodeNumber: 1,
        absoluteEpisodeNumber: null,
        title: 'Pilot',
      },
    ]);
  });

  it('emits two distinct units for one series with two qualifying seasons', async () => {
    nock(SONARR).get('/api/v3/series').reply(200, [seriesFixture]);
    nock(SONARR)
      .get('/api/v3/episode')
      .query({ seriesId: 1 })
      .reply(200, [
        episode({ id: 101, episodeNumber: 7, absoluteEpisodeNumber: 7, title: 'S1 Ep' }),
        episode({
          id: 202,
          seasonNumber: 2,
          episodeNumber: 1,
          absoluteEpisodeNumber: 8,
          title: 'S2 Ep',
        }),
      ]);
    mockEmptyMovies();

    const units = await makeWatcher().getWorkUnits();
    expect(units.map((u) => u.key)).toEqual(['sonarr:1:s1', 'sonarr:1:s2']);
    expect(units[0]!.season?.missing).toEqual([
      { episodeId: 101, episodeNumber: 7, absoluteEpisodeNumber: 7, title: 'S1 Ep' },
    ]);
    expect(units[1]!.season?.missing).toEqual([
      { episodeId: 202, episodeNumber: 1, absoluteEpisodeNumber: 8, title: 'S2 Ep' },
    ]);
  });
});

describe('Watcher.getWorkUnits — filters', () => {
  it('excludes hasFile, unaired, future-aired, and unmonitored episodes while keeping mixed survivors', async () => {
    nock(SONARR).get('/api/v3/series').reply(200, [seriesFixture]);
    nock(SONARR)
      .get('/api/v3/episode')
      .query({ seriesId: 1 })
      .reply(200, [
        episode({ id: 101, episodeNumber: 7, absoluteEpisodeNumber: 7, title: 'Valid' }),
        episode({ id: 102, episodeNumber: 8, hasFile: true, title: 'Has File' }),
        episode({ id: 103, episodeNumber: 9, airDate: null, title: 'Unaired' }),
        episode({ id: 104, episodeNumber: 10, airDate: '2026-09-30', title: 'Future' }),
        episode({ id: 105, episodeNumber: 11, monitored: false, title: 'Unmonitored' }),
        episode({ id: 106, episodeNumber: 12, airDate: NOW.toISOString(), title: 'Boundary' }),
      ]);
    mockEmptyMovies();

    const units = await makeWatcher().getWorkUnits();
    expect(units).toHaveLength(1);
    expect(units[0]!.key).toBe('sonarr:1:s1');
    expect(units[0]!.season?.missing).toEqual([
      { episodeId: 101, episodeNumber: 7, absoluteEpisodeNumber: 7, title: 'Valid' },
      { episodeId: 106, episodeNumber: 12, absoluteEpisodeNumber: null, title: 'Boundary' },
    ]);
  });

  it('skips unmonitored series without fetching their episodes, while a monitored series still emits', async () => {
    const unmonitored = { ...seriesFixture, id: 9, tvdbId: 999, monitored: false };
    nock(SONARR).get('/api/v3/series').reply(200, [unmonitored, seriesFixture]);
    nock(SONARR).get('/api/v3/episode').query({ seriesId: 9 }).reply(200, []);
    nock(SONARR)
      .get('/api/v3/episode')
      .query({ seriesId: 1 })
      .reply(200, [episode({ id: 101, episodeNumber: 7, absoluteEpisodeNumber: 7, title: 'Valid' })]);
    mockEmptyMovies();
    const sonarr = new SonarrClient(new Http({ baseUrl: SONARR, apiKey: KEY }));
    const getEpisodes = vi.spyOn(sonarr, 'getEpisodes');
    const onError = vi.fn();

    const units = await new Watcher({
      sonarr,
      radarr: new RadarrClient(new Http({ baseUrl: RADARR, apiKey: KEY })),
      now: () => NOW,
      onError,
    }).getWorkUnits();

    expect(getEpisodes.mock.calls).toEqual([[9], [1]]);
    expect(errorCalls(onError)).toEqual([]);
    expect(units.map((u) => u.key)).toEqual(['sonarr:1:s1']);
  });

  it('emits no unit for a fully-filed season while another season of the same series still emits', async () => {
    nock(SONARR).get('/api/v3/series').reply(200, [seriesFixture]);
    nock(SONARR)
      .get('/api/v3/episode')
      .query({ seriesId: 1 })
      .reply(200, [
        episode({ id: 101, episodeNumber: 7, hasFile: true, title: 'Filed' }),
        episode({ id: 102, episodeNumber: 8, hasFile: true, title: 'Filed 2' }),
        episode({
          id: 202,
          seasonNumber: 2,
          episodeNumber: 1,
          title: 'S2 Missing',
        }),
      ]);
    mockEmptyMovies();

    const units = await makeWatcher().getWorkUnits();
    expect(units.map((u) => u.key)).toEqual(['sonarr:1:s2']);
  });

  it('keeps only the valid movies from a mixed movie library', async () => {
    const hasFile = { ...movieFixture, id: 4, hasFile: true };
    const unavailable = { ...movieFixture, id: 5, isAvailable: false };
    const unmonitored = { ...movieFixture, id: 6, monitored: false };
    const valid2 = { ...movieFixture, id: 7, tmdbId: 700, title: 'Second Movie' };
    mockEmptySeries();
    nock(RADARR).get('/api/v3/movie').reply(200, [hasFile, unavailable, unmonitored, movieFixture, valid2]);

    const units = await makeWatcher().getWorkUnits();
    expect(units.map((u) => u.key)).toEqual(['radarr:3', 'radarr:7']);
    expect(units[1]!.externalId).toBe(700);
    expect(units[1]!.title).toBe('Second Movie');
  });
});

describe('Watcher.getWorkUnits — fault tolerance', () => {
  it('returns movie units when the Sonarr library read fails', async () => {
    nock(SONARR).get('/api/v3/series').reply(500, 'boom');
    nock(RADARR).get('/api/v3/movie').reply(200, [movieFixture]);
    const onError = vi.fn();

    const units = await makeWatcher({ onError }).getWorkUnits();
    const calls = errorCalls(onError);
    expect(calls).toHaveLength(1);
    expect(calls[0]![0]).toBeInstanceOf(ApiError);
    expect((calls[0]![0] as ApiError).status).toBe(500);
    expect(calls[0]![1]).toBe('sonarr.getSeries');
    expect(units.map((u) => u.key)).toEqual(['radarr:3']);
  });

  it('returns TV units when the Radarr library read fails', async () => {
    nock(SONARR).get('/api/v3/series').reply(200, [seriesFixture]);
    nock(SONARR)
      .get('/api/v3/episode')
      .query({ seriesId: 1 })
      .reply(200, [episode({ id: 101, episodeNumber: 7, absoluteEpisodeNumber: 7, title: 'Valid' })]);
    nock(RADARR).get('/api/v3/movie').reply(500, 'boom');
    const onError = vi.fn();

    const units = await makeWatcher({ onError }).getWorkUnits();
    const calls = errorCalls(onError);
    expect(calls).toHaveLength(1);
    expect(calls[0]![0]).toBeInstanceOf(ApiError);
    expect(calls[0]![1]).toBe('radarr.getMovies');
    expect(units.map((u) => u.key)).toEqual(['sonarr:1:s1']);
  });

  it('skips a series whose episode fetch fails while keeping healthy series units', async () => {
    const seriesB = {
      ...seriesFixture,
      id: 2,
      tvdbId: 42,
      title: 'Healthy Show',
      seriesType: 'standard',
      alternateTitles: [],
      seasons: [],
      statistics: { episodeFileCount: 0, totalEpisodeCount: 1, sizeOnDisk: 0, percentOfEpisodes: 0 },
    };
    nock(SONARR).get('/api/v3/series').reply(200, [seriesFixture, seriesB]);
    nock(SONARR).get('/api/v3/episode').query({ seriesId: 1 }).reply(500, 'boom');
    nock(SONARR)
      .get('/api/v3/episode')
      .query({ seriesId: 2 })
      .reply(200, [episode({ id: 201, seriesId: 2, episodeNumber: 1, title: 'Pilot' })]);
    mockEmptyMovies();
    const onError = vi.fn();

    const units = await makeWatcher({ onError }).getWorkUnits();
    const calls = errorCalls(onError);
    expect(calls).toHaveLength(1);
    expect(calls[0]![0]).toBeInstanceOf(ApiError);
    expect(calls[0]![1]).toBe('sonarr.getEpisodes(1)');
    expect(units.map((u) => u.key)).toEqual(['sonarr:2:s1']);
    expect(units[0]!.season?.missing[0]!.title).toBe('Pilot');
  });

  it('reports two distinct notifications when both libraries fail', async () => {
    nock(SONARR).get('/api/v3/series').reply(500, 'boom');
    nock(RADARR).get('/api/v3/movie').reply(500, 'boom');
    const onError = vi.fn();

    const units = await makeWatcher({ onError }).getWorkUnits();
    const calls = errorCalls(onError);
    expect(calls.map(([, context]) => context)).toEqual([
      'sonarr.getSeries',
      'radarr.getMovies',
    ]);
    for (const [error] of calls) {
      expect(error).toBeInstanceOf(ApiError);
    }
    expect(units).toEqual([]);
  });
});

describe('Watcher.getSnapshot', () => {
  it('retains unavailable and unaired missing inventory plus positive library observations', async () => {
    nock(SONARR).get('/api/v3/series').reply(200, [seriesFixture]);
    nock(SONARR).get('/api/v3/episode').query({ seriesId: 1 }).reply(200, [
      episode({ id: 101, episodeNumber: 7, hasFile: false, airDate: null }),
      episode({ id: 102, episodeNumber: 8, hasFile: true, airDate: '2023-10-20' }),
    ]);
    nock(RADARR).get('/api/v3/movie').reply(200, [
      { ...movieFixture, id: 3, hasFile: false, isAvailable: false },
      { ...movieFixture, id: 4, hasFile: true, isAvailable: true },
    ]);
    const snapshot = await makeWatcher().getSnapshot();

    expect(snapshot.sonarr).toMatchObject({ known: true, series: [{ known: true }] });
    expect(snapshot.sonarr.series[0]?.episodes?.map((ep) => [ep.id, ep.hasFile])).toEqual([[101, false], [102, true]]);
    expect(snapshot.radarr).toMatchObject({ known: true, movies: [{ id: 3, hasFile: false, isAvailable: false }, { id: 4, hasFile: true }] });
    expect(snapshot.observedAt).toBe(NOW.toISOString());
  });

  it('marks failed source and per-series reads unknown without converting them to empty observations', async () => {
    nock(SONARR).get('/api/v3/series').reply(200, [seriesFixture]);
    nock(SONARR).get('/api/v3/episode').query({ seriesId: 1 }).reply(500, 'private backend text');
    nock(RADARR).get('/api/v3/movie').reply(500, 'private backend text');
    const onError = vi.fn();
    const snapshot = await makeWatcher({ onError }).getSnapshot();

    expect(snapshot.sonarr).toMatchObject({ known: true, series: [{ known: false, episodes: null }] });
    expect(snapshot.radarr).toMatchObject({ known: false, movies: [] });
    expect(onError).toHaveBeenCalledTimes(2);
  });
});
