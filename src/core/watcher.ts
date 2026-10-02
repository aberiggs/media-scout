import type { RadarrClient } from '../clients/radarr';
import type { SonarrClient } from '../clients/sonarr';
import type { Episode, Series } from '../types/sonarr';
import type { Movie } from '../types/radarr';

export interface WorkUnit {
  key: string;
  kind: 'tv' | 'movie';
  arr: 'sonarr' | 'radarr';
  serviceId: number;
  externalId: number;
  title: string;
  year?: number;
  altTitles: string[];
  seriesType?: 'standard' | 'anime' | 'daily';
  season?: {
    seasonNumber: number;
    missing: { episodeId: number; episodeNumber: number; absoluteEpisodeNumber: number | null; title: string }[];
  };
}

export interface SeriesLibraryObservation {
  series: Series;
  known: boolean;
  episodes: Episode[] | null;
  errorCode?: string;
}

export interface LibrarySnapshot {
  observedAt: string;
  sonarr: { known: boolean; series: SeriesLibraryObservation[]; errorCode?: string };
  radarr: { known: boolean; movies: Movie[]; errorCode?: string };
}

function errorCode(error: unknown): string {
  const status = typeof error === 'object' && error !== null && 'status' in error ? (error as { status?: unknown }).status : undefined;
  return typeof status === 'number' ? `http-${status}` : 'read-failed';
}

/** Computes complete source observations, keeping unknown reads distinct from known empty inventory. */
export class Watcher {
  private readonly now: () => Date;
  private readonly onError: (error: unknown, context: string) => void;

  constructor(deps: {
    sonarr: SonarrClient;
    radarr: RadarrClient;
    now?: () => Date;
    onError: (error: unknown, context: string) => void;
  }) {
    this.sonarr = deps.sonarr;
    this.radarr = deps.radarr;
    this.now = deps.now ?? (() => new Date());
    this.onError = deps.onError;
  }

  private readonly sonarr: SonarrClient;
  private readonly radarr: RadarrClient;

  /** Reads both libraries and retains per-series completeness and positive file observations. */
  async getSnapshot(): Promise<LibrarySnapshot> {
    const observedAt = this.now().toISOString();
    const [seriesResult, movieResult] = await Promise.all([
      this.sonarr.getSeries().then((series) => ({ known: true as const, series })).catch((error: unknown) => {
        this.onError(error, 'sonarr.getSeries');
        return { known: false as const, series: [] as Series[], errorCode: errorCode(error) };
      }),
      this.radarr.getMovies().then((movies) => ({ known: true as const, movies })).catch((error: unknown) => {
        this.onError(error, 'radarr.getMovies');
        return { known: false as const, movies: [] as Movie[], errorCode: errorCode(error) };
      }),
    ]);
    const observations = await Promise.all(seriesResult.series.map(async (series): Promise<SeriesLibraryObservation> => {
      try {
        return { series, known: true, episodes: await this.sonarr.getEpisodes(series.id) };
      } catch (error) {
        this.onError(error, `sonarr.getEpisodes(${series.id})`);
        return { series, known: false, episodes: null, errorCode: errorCode(error) };
      }
    }));
    return {
      observedAt,
      sonarr: { known: seriesResult.known, series: observations, ...(seriesResult.known ? {} : { errorCode: seriesResult.errorCode }) },
      radarr: { known: movieResult.known, movies: movieResult.movies, ...(movieResult.known ? {} : { errorCode: movieResult.errorCode }) },
    };
  }

  /** Eligible compatibility projection: aired missing monitored episodes and available missing movies only. */
  async getWorkUnits(): Promise<WorkUnit[]> {
    const snapshot = await this.getSnapshot();
    return eligibleWorkUnits(snapshot);
  }
}

export function eligibleWorkUnits(snapshot: LibrarySnapshot): WorkUnit[] {
  const nowIso = snapshot.observedAt;
  const tvUnits = snapshot.sonarr.series.flatMap(({ series, known, episodes }) => {
    if (!known || !series.monitored || episodes === null) return [];
    const bySeason = new Map<number, NonNullable<WorkUnit['season']>>();
    for (const episode of episodes) {
      if (!(episode.monitored && !episode.hasFile && episode.airDate !== null && episode.airDate <= nowIso)) continue;
      const season = bySeason.get(episode.seasonNumber) ?? { seasonNumber: episode.seasonNumber, missing: [] };
      season.missing.push({ episodeId: episode.id, episodeNumber: episode.episodeNumber, absoluteEpisodeNumber: episode.absoluteEpisodeNumber ?? null, title: episode.title });
      bySeason.set(episode.seasonNumber, season);
    }
    return [...bySeason.values()].map((season) => ({
      key: `sonarr:${series.id}:s${season.seasonNumber}`, kind: 'tv' as const, arr: 'sonarr' as const,
      serviceId: series.id, externalId: series.tvdbId, title: series.title,
      altTitles: series.alternateTitles.map((alt) => alt.title), seriesType: series.seriesType, season,
    }));
  });
  const movieUnits: WorkUnit[] = snapshot.radarr.movies
    .filter((movie) => movie.monitored && !movie.hasFile && movie.isAvailable)
    .map((movie) => ({ key: `radarr:${movie.id}`, kind: 'movie', arr: 'radarr', serviceId: movie.id, externalId: movie.tmdbId, title: movie.title, year: movie.year, altTitles: [] }));
  return [...tvUnits, ...movieUnits];
}
