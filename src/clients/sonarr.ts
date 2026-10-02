import { Http } from '../http';
import { getAllQueueRecords } from './arr-queue';
import {
  type Episode,
  episodeListSchema,
  type Series,
  seriesListSchema,
  sonarrQueuePageSchema,
  type SonarrQueueRecord,
} from '../types/sonarr';

/** Thin Sonarr /api/v3 adapter — auth and wire parsing via Http + zod schemas. */
export class SonarrClient {
  constructor(private readonly http: Http) {}

  /** Full series library (watcher filters; client stays thin). */
  getSeries(): Promise<Series[]> {
    return this.http.getJson('/api/v3/series').then(seriesListSchema.parse);
  }

  /** All episodes of one series (watcher computes missing from hasFile). */
  async getEpisodes(seriesId: number): Promise<Episode[]> {
    const body = await this.http.getJson('/api/v3/episode', { seriesId });
    return episodeListSchema.parse(body);
  }

  /** Complete paginated tracked queue, including downloads with unknown series/episode associations. */
  getQueue(): Promise<SonarrQueueRecord[]> {
    return getAllQueueRecords(this.http, {
      path: '/api/v3/queue',
      params: { includeUnknownSeriesItems: true, includeSeries: false, includeEpisode: false },
      schema: sonarrQueuePageSchema,
    });
  }
}
