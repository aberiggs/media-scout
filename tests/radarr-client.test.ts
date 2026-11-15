import { afterEach, describe, expect, it } from 'vitest';
import nock from 'nock';
import { ApiError, Http } from '../src/http';
import { RadarrClient } from '../src/clients/radarr';
import { movieListSchema } from '../src/types/radarr';
import movieFixture from './fixtures/radarr-movie.json';

const BASE = 'http://radarr.test';
const KEY = 'test-key';

afterEach(() => nock.cleanAll());

describe('RadarrClient.getMovies', () => {
  it('preserves allowlisted descriptive metadata needed by search automation', () => {
    const [movie] = movieListSchema.parse([{ id: 1, tmdbId: 2, title: 'Example', titleSlug: 'example', year: 2024, monitored: true, hasFile: false, isAvailable: true, sizeOnDisk: 0, overview: 'Safe synopsis', originalLanguage: { id: 8, name: 'Japanese' }, qualityProfileId: 4 }]);
    expect(movie).toMatchObject({ overview: 'Safe synopsis', originalLanguage: { id: 8, name: 'Japanese' }, qualityProfileId: 4 });
  });
  it('GETs /api/v3/movie and parses the movie list', async () => {
    const scope = nock(BASE)
      .matchHeader('X-Api-Key', KEY)
      .get('/api/v3/movie')
      .reply(200, [movieFixture]);
    const client = new RadarrClient(new Http({ baseUrl: BASE, apiKey: KEY }));
    const movies = await client.getMovies();
    expect(movies).toHaveLength(1);
    expect(movies[0]!.tmdbId).toBe(671);
    expect(movies[0]!.year).toBe(2001);
    expect(movies[0]!.hasFile).toBe(false);
    expect(scope.isDone()).toBe(true);
  });

  it('rejects with ApiError status 503 on server error', async () => {
    nock(BASE).get('/api/v3/movie').reply(503, 'starting up');
    const client = new RadarrClient(new Http({ baseUrl: BASE, apiKey: KEY }));
    try {
      await client.getMovies();
      throw new Error('expected a rejection');
    } catch (e) {
      expect(e).toBeInstanceOf(ApiError);
      expect((e as ApiError).status).toBe(503);
    }
  });
});
