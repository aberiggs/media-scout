import { createHash } from 'node:crypto';
import type { SonarrClient } from '../clients/sonarr';
import type { RadarrClient } from '../clients/radarr';
import { episodeEligibilityTime } from '../core/episode-timing';
import type { Episode, SonarrQueueRecord } from '../types/sonarr';
import type { Movie } from '../types/radarr';
import { safeText } from './service';
import type { SearchStore } from './store';
import { summarizeProfile } from '../types/quality-profile';

export type ArrProvider = 'sonarr' | 'radarr';
export interface ArrTarget {
  key: string; provider: ArrProvider; sourceFingerprint: string; serviceId: number; externalId: number;
  episodeId?: number; movieId?: number; monitored: boolean; hasFile: boolean; eligible: boolean;
  available: boolean; airAt?: number; queued?: boolean; queueReason?: string; context: Record<string, unknown>;
  showContext?: Record<string, unknown>; episodeContext?: Record<string, unknown>;
}
export interface SafeQueueRecord { serviceId?: number; itemId?: number; seasonNumber?: number; status?: string; trackedStatus?: string; trackedState?: string }
export interface ProviderObservation {
  known: boolean; observedAt: number; error?: string; targets: ArrTarget[]; queue: SafeQueueRecord[];
  diagnostics: { unidentifiedQueueRows: number; unknownSeriesIds?: number[] };
}
export interface ArrSnapshot {
  observedAt: number; sonarr: ProviderObservation; radarr: ProviderObservation;
  targets: ArrTarget[];
}
export interface ArrObserverDeps {
  sonarr?: Pick<SonarrClient, 'getSeries' | 'getEpisodes' | 'getQueue'> & Partial<Pick<SonarrClient, 'getQualityProfiles'>>;
  radarr?: Pick<RadarrClient, 'getMovies' | 'getQueue'> & Partial<Pick<RadarrClient, 'getQualityProfiles'>>;
  source: { sonarr?: { id: string; url: string; apiKey: string }; radarr?: { id: string; url: string; apiKey: string } } | (() => { sonarr?: { id: string; url: string; apiKey: string }; radarr?: { id: string; url: string; apiKey: string } });
  onRetryAfter?: (source: ArrProvider, seconds: number) => void;
  store?: Pick<SearchStore, 'saveObservation' | 'getProviderDeadline'>;
  clock?: () => number;
}

const fingerprint = (p: ArrProvider, source: { id: string; url: string; apiKey: string }): string =>
  createHash('sha256').update(`${p}\0${source.id}\0${source.url}\0${source.apiKey}`).digest('hex');
const targetKey = (provider: ArrProvider, fp: string, serviceId: number, externalId: number, itemId: number): string =>
  `${provider}:${fp}:${serviceId}:${externalId}:${itemId}`;
const unknown = (at: number, error = 'source-unavailable'): ProviderObservation => ({ known: false, observedAt: at, error, targets: [], queue: [], diagnostics: { unidentifiedQueueRows: 0 } });
const languageName = (value: unknown): string | undefined => value && typeof value === 'object' && 'name' in value && typeof value.name === 'string' ? value.name : undefined;
function queuedEpisodeIds(rows: SonarrQueueRecord[], seriesId: number, seasonNumber: number): { direct: Set<number>; season: boolean; series: boolean } {
  const direct = new Set<number>(); let season = false, series = false;
  for (const row of rows) {
    if (row.seriesId !== seriesId || isTerminal(row)) continue;
    if (row.episodeId != null) direct.add(row.episodeId);
    else if (row.seasonNumber === seasonNumber) season = true;
    else if (row.seasonNumber == null) series = true;
  }
  return { direct, season, series };
}
function isTerminal(row: { trackedDownloadStatus?: string | null; trackedDownloadState?: string | null; status?: string | null }): boolean {
  const status = `${row.trackedDownloadStatus ?? ''} ${row.trackedDownloadState ?? ''} ${row.status ?? ''}`.toLowerCase();
  return /(^|\W)(failed|removed)(\W|$)/.test(status);
}
function safeContext(input: Record<string, unknown>): Record<string, unknown> {
  const allowed = new Set(['title','titles','year','seasonNumber','episodeNumber','absoluteEpisodeNumber','episodeTitle','overview','originalLanguage','seriesType','profileContext','externalIds']);
  const sanitize = (value: unknown): unknown => typeof value === 'string' ? safeText(value) : Array.isArray(value) ? value.map(sanitize) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([k,v]) => [k,sanitize(v)])) : value;
  return Object.fromEntries(Object.entries(input).filter(([key, value]) => allowed.has(key) && value !== undefined).map(([key,value])=>[key,sanitize(value)]));
}

/** Read-only current-state adapter. Failed sources are unknown, never empty. */
export class ArrObserver {
  private readonly throttledUntil: Partial<Record<ArrProvider, number>> = {};
  constructor(private readonly deps: ArrObserverDeps) {}

  sourceFingerprint(provider: ArrProvider): string | null {
    const sources = typeof this.deps.source === 'function' ? this.deps.source() : this.deps.source;
    return sources[provider] ? fingerprint(provider, sources[provider]!) : null;
  }

  async observe(): Promise<ArrSnapshot> {
    const now = (this.deps.clock ?? Date.now)();
    const [sonarr, radarr] = await Promise.all([this.readSonarr(now), this.readRadarr(now)]);
    const snapshot = { observedAt: now, sonarr, radarr, targets: [...sonarr.targets, ...radarr.targets] };
    for (const [source, observation] of [['sonarr', sonarr], ['radarr', radarr]] as const) {
      // Cache is private. Public projections explicitly omit keys/fingerprints and use opaque IDs.
      this.deps.store?.saveObservation(source, { observedAt: now, complete: observation.known, payload: observation });
    }
    return snapshot;
  }

  async fingerprintFor(target: ArrTarget): Promise<string | null> {
    const snapshot = await this.observe();
    return snapshot.targets.find(current => current.key === target.key)?.sourceFingerprint ?? null;
  }

  async validateTarget(target: ArrTarget): Promise<boolean> {
    const snapshot = await this.observe();
    if (!snapshot[target.provider].known) return false;
    return snapshot.targets.some(current => current.key === target.key && current.eligible && current.available && current.monitored && !current.hasFile);
  }

  private async readSonarr(at: number): Promise<ProviderObservation> {
    const client = this.deps.sonarr, sources = typeof this.deps.source === 'function' ? this.deps.source() : this.deps.source, src = sources.sonarr;
    if (!client || !src) return unknown(at, 'not-configured');
    if (Math.max(this.throttledUntil.sonarr ?? 0, this.deps.store?.getProviderDeadline('sonarr') ?? 0) > at) return unknown(at, 'source-throttled');
    const fp = fingerprint('sonarr', src);
    try {
      const [seriesList, queue] = await Promise.all([client.getSeries(), client.getQueue()]);
      const profiles = client.getQualityProfiles ? await client.getQualityProfiles().catch(error => { this.reportRetry('sonarr', error); return null; }) : null;
      const targets: ArrTarget[] = [], unknownSeriesIds: number[] = [];
      for (const series of seriesList) {
        if ((this.throttledUntil.sonarr ?? 0) > at) { unknownSeriesIds.push(series.id); continue; }
        let episodes: Episode[];
        try { episodes = await client.getEpisodes(series.id); } catch (error) { this.reportRetry('sonarr', error); unknownSeriesIds.push(series.id); continue; }
        const episodeIds = queuedEpisodeIds(queue, series.id, -1);
        for (const episode of episodes) {
          const airing = episodeEligibilityTime(episode)?.getTime();
          const seasonQueue = queue.some(row => row.seriesId === series.id && row.seasonNumber === episode.seasonNumber && row.episodeId == null && !isTerminal(row));
          const queueCovered = episodeIds.direct.has(episode.id) || seasonQueue || episodeIds.series;
          const available = airing !== undefined && airing <= at;
          const eligible = series.monitored && episode.monitored && !episode.hasFile && available && !queueCovered;
          const key = targetKey('sonarr', fp, series.id, series.tvdbId, episode.id);
          const profile = profiles?.find(p => p.id === series.qualityProfileId);
          const showContext = safeContext({ title: series.title, titles: [series.title, ...series.alternateTitles.map(t => t.title)], overview: series.overview ?? undefined, originalLanguage: languageName(series.originalLanguage), seriesType: series.seriesType, profileContext: summarizeProfile(client.getQualityProfiles ? profile : series.qualityProfile), externalIds: { tvdb: series.tvdbId } });
          const episodeContext = safeContext({ seasonNumber: episode.seasonNumber, episodeNumber: episode.episodeNumber, absoluteEpisodeNumber: episode.absoluteEpisodeNumber, episodeTitle: episode.title, episodeOverview: episode.overview ?? undefined });
          targets.push({ key, provider: 'sonarr', sourceFingerprint: fp, serviceId: series.id, externalId: series.tvdbId, episodeId: episode.id, monitored: series.monitored && episode.monitored, hasFile: episode.hasFile, available, queued: queueCovered, ...(queueCovered ? { queueReason: 'observed-in-queue' } : {}), eligible,
            ...(airing === undefined ? {} : { airAt: airing }), showContext, episodeContext, context: safeContext({ ...showContext, ...episodeContext, overview: episode.overview ?? series.overview ?? undefined }) });
        }
      }
      if (this.sourceFingerprint('sonarr') !== fp) return unknown(at, 'source-changed');
      return { known: true, observedAt: at, targets, queue: queue.map(row => ({ ...(row.seriesId == null ? {} : { serviceId: row.seriesId }), ...(row.episodeId == null ? {} : { itemId: row.episodeId }), ...(row.seasonNumber == null ? {} : { seasonNumber: row.seasonNumber }), ...(row.status ? { status: safeText(row.status) } : {}), ...(row.trackedDownloadStatus ? { trackedStatus: safeText(row.trackedDownloadStatus) } : {}), ...(row.trackedDownloadState ? { trackedState: safeText(row.trackedDownloadState) } : {}) })), diagnostics: { unidentifiedQueueRows: queue.filter(row => row.seriesId == null).length, ...(unknownSeriesIds.length ? { unknownSeriesIds } : {}) } };
    } catch (error) { this.reportRetry('sonarr', error); return unknown(at); }
  }

  private async readRadarr(at: number): Promise<ProviderObservation> {
    const client = this.deps.radarr, sources = typeof this.deps.source === 'function' ? this.deps.source() : this.deps.source, src = sources.radarr;
    if (!client || !src) return unknown(at, 'not-configured');
    if (Math.max(this.throttledUntil.radarr ?? 0, this.deps.store?.getProviderDeadline('radarr') ?? 0) > at) return unknown(at, 'source-throttled');
    const fp = fingerprint('radarr', src);
    try {
      const [movies, queue] = await Promise.all([client.getMovies(), client.getQueue()]);
      const profiles = client.getQualityProfiles ? await client.getQualityProfiles().catch(error => { this.reportRetry('radarr', error); return null; }) : null;
      const targets = movies.map((movie: Movie): ArrTarget => {
        const covered = queue.some(row => row.movieId === movie.id && !isTerminal(row));
        const available = movie.isAvailable;
        const key = targetKey('radarr', fp, movie.id, movie.tmdbId, movie.id);
        return { key, provider: 'radarr', sourceFingerprint: fp, serviceId: movie.id, externalId: movie.tmdbId, movieId: movie.id, monitored: movie.monitored, hasFile: movie.hasFile, available, eligible: movie.monitored && !movie.hasFile && available && !covered,
          context: safeContext({ title: movie.title, titles: [movie.title], year: movie.year, overview: movie.overview ?? undefined, originalLanguage: languageName(movie.originalLanguage), profileContext: summarizeProfile(client.getQualityProfiles ? profiles?.find(p => p.id === movie.qualityProfileId) : movie.qualityProfile), externalIds: { tmdb: movie.tmdbId } }) };
      });
      if (this.sourceFingerprint('radarr') !== fp) return unknown(at, 'source-changed');
      return { known: true, observedAt: at, targets, queue: queue.map(row => ({ ...(row.movieId == null ? {} : { itemId: row.movieId }), ...(row.status ? { status: safeText(row.status) } : {}), ...(row.trackedDownloadStatus ? { trackedStatus: safeText(row.trackedDownloadStatus) } : {}), ...(row.trackedDownloadState ? { trackedState: safeText(row.trackedDownloadState) } : {}) })), diagnostics: { unidentifiedQueueRows: queue.filter(row => row.movieId == null).length } };
    } catch (error) { this.reportRetry('radarr', error); return unknown(at); }
  }

  private reportRetry(source: ArrProvider, error: unknown): void {
    if (error && typeof error === 'object' && 'retryAfter' in error && typeof error.retryAfter === 'number') {
      this.throttledUntil[source] = (this.deps.clock ?? Date.now)() + error.retryAfter * 1000;
      this.deps.onRetryAfter?.(source, error.retryAfter);
    }
  }
}
