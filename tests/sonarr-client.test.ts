import { afterEach, describe, expect, it } from 'vitest';
import nock from 'nock';
import { readFileSync } from 'node:fs';
import { ApiError, Http } from '../src/http';
import { SonarrClient } from '../src/clients/sonarr';

const BASE = 'http://sonarr.test';
const KEY = 'test-key';

const seriesFixture = JSON.parse(
  readFileSync(new URL('./fixtures/sonarr-series.json', import.meta.url), 'utf8'),
) as unknown[];
const episodesFixture = JSON.parse(
  readFileSync(new URL('./fixtures/sonarr-episodes.json', import.meta.url), 'utf8'),
) as unknown[];

const catchAs = async (p: Promise<unknown>): Promise<ApiError> => {
  try {
    await p;
    throw new Error('expected a rejection');
  } catch (e) {
    return e as ApiError;
  }
};

afterEach(() => nock.cleanAll());

describe('SonarrClient.getSeries', () => {
  it('GETs /api/v3/series and parses the fixture through seriesListSchema', async () => {
    const scope = nock(BASE)
      .matchHeader('X-Api-Key', KEY)
      .get('/api/v3/series')
      .reply(200, [seriesFixture]);
    const out = await new SonarrClient(new Http({ baseUrl: BASE, apiKey: KEY })).getSeries();
    expect(scope.isDone()).toBe(true);
    expect(out).toHaveLength(1);
    expect(out[0]!.id).toBe(1);
    expect(out[0]!.tvdbId).toBe(368013);
    expect(out[0]!.seriesType).toBe('anime');
  });
});

describe('SonarrClient.getEpisodes', () => {
  it('GETs /api/v3/episode with seriesId query and parses through episodeListSchema', async () => {
    const scope = nock(BASE)
      .matchHeader('X-Api-Key', KEY)
      .get('/api/v3/episode')
      .query({ seriesId: 1 })
      .reply(200, episodesFixture);
    const out = await new SonarrClient(new Http({ baseUrl: BASE, apiKey: KEY })).getEpisodes(1);
    expect(scope.isDone()).toBe(true);
    expect(out).toHaveLength(3);
    const unmapped = out.find((e) => e.id === 103);
    expect(unmapped?.absoluteEpisodeNumber).toBeNull();
    expect(out.find((e) => e.id === 101)?.absoluteEpisodeNumber).toBe(7);
  });

  it('throws ApiError with status 500 on server error', async () => {
    nock(BASE).get('/api/v3/episode').query(true).reply(500, 'boom');
    const err = await catchAs(new SonarrClient(new Http({ baseUrl: BASE, apiKey: KEY })).getEpisodes(1));
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(500);
  });
});
