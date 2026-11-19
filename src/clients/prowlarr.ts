import { Http, type HttpRequestOptions } from '../http';
import {
  type DownloadClient,
  downloadClientListSchema,
  type Indexer,
  indexerListSchema,
  type IndexerStatus,
  indexerStatusListSchema,
  type Release,
  releaseListSchema,
} from '../types/prowlarr';

/** Thin Prowlarr v1 adapter: search, indexer status, download-client entries, single-release grab (D6). */
export class ProwlarrClient {
  constructor(private readonly http: Http) {}

  /** Multi-indexer search. Arrays serialize as repeated plain keys via Http. */
  async search(params: {
    query: string;
    categories: number[];
    indexerIds?: number[];
    limit?: number;
    offset?: number;
    type?: 'search' | 'tvsearch' | 'moviesearch' | 'musicsearch' | 'booksearch';
  }, options?: HttpRequestOptions): Promise<Release[]> {
    const query: Record<string, string | number | (string | number)[]> = {
      query: params.query,
      type: params.type ?? 'search',
      categories: params.categories,
    };
    if (params.indexerIds !== undefined) query.indexerIds = params.indexerIds;
    if (params.limit !== undefined) query.limit = params.limit;
    if (params.offset !== undefined) query.offset = params.offset;
    return releaseListSchema.parse(
      await this.http.getJson('/api/v1/search', query, options),
    );
  }

  /** Per-indexer backoff signal (I5): non-null `disabledTill` means the indexer is cooling down. */
  async getIndexerStatuses(options?: HttpRequestOptions): Promise<IndexerStatus[]> {
    return indexerStatusListSchema.parse(
      await this.http.getJson('/api/v1/indexerstatus', undefined, options),
    );
  }

  /** Configured indexer entries (I5 allowlist source; healthy set = enabled minus cooling). */
  async getIndexers(options?: HttpRequestOptions): Promise<Indexer[]> {
    return indexerListSchema.parse(await this.http.getJson('/api/v1/indexer', undefined, options));
  }

  /** Download-client entries resolved by name to route grabs (D6). */
  async getDownloadClients(): Promise<DownloadClient[]> {
    return downloadClientListSchema.parse(
      await this.http.getJson('/api/v1/downloadclient'),
    );
  }

  /** Pushes one cached release via Prowlarr to the given download-client entry (D6). Throws ApiError on failure (404 cache-miss, 429 limit). */
  async grab(release: Release, downloadClientId: number): Promise<void> {
    await this.http.postJson('/api/v1/search', {
      indexerId: release.indexerId,
      guid: release.guid,
      downloadClientId,
    });
  }
}
