import { Http } from '../http';
import { getAllQueueRecords } from './arr-queue';
import { type Movie, movieListSchema, radarrQueuePageSchema, type RadarrQueueRecord } from '../types/radarr';
import { qualityProfileListSchema, type QualityProfile } from '../types/quality-profile';

/** Thin Radarr adapter: reads the movie library. All mutations are out of scope (I6). */
export class RadarrClient {
  constructor(private readonly http: Http) {}

  /** Full movie library (watcher filters monitored && !hasFile). */
  async getMovies(): Promise<Movie[]> {
    return movieListSchema.parse(await this.http.getJson('/api/v3/movie'));
  }

  /** Complete paginated tracked queue, including downloads with unknown movie associations. */
  getQueue(): Promise<RadarrQueueRecord[]> {
    return getAllQueueRecords(this.http, {
      path: '/api/v3/queue',
      params: { includeUnknownMovieItems: true, includeMovie: false },
      schema: radarrQueuePageSchema,
    });
  }

  getQualityProfiles(): Promise<QualityProfile[]> {
    return this.http.getJson('/api/v3/qualityprofile').then(qualityProfileListSchema.parse);
  }
}
