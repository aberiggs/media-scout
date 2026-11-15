import { describe, expect, it, vi } from 'vitest';
import { ArrObserver } from '../src/search/arr';
import type { SonarrClient } from '../src/clients/sonarr';
import type { RadarrClient } from '../src/clients/radarr';

const series = { id: 1, tvdbId: 10, title: 'Show', titleSlug: 'show', seriesType: 'standard' as const, monitored: true, seasons: [], alternateTitles: [], overview: 'overview', originalLanguage: { id: 1, name: 'English' } };
const episodes = [1,2].map(id => ({ id, seriesId: 1, seasonNumber: 1, episodeNumber: id, absoluteEpisodeNumber: null, title: `E${id}`, airDate: '2020-01-01', airDateUtc: null, finaleType: null, monitored: true, hasFile: false }));

describe('ArrObserver', () => {
  it('provides allowed nested qualities separately from scored custom formats', async () => {
    const sonarr = { getSeries: async () => [{ ...series, qualityProfileId: 5 }], getEpisodes: async () => episodes, getQueue: async () => [], getQualityProfiles: async () => [{ id: 5, name: 'HD', items: [{ name: 'HD group', allowed: true, items: [{ quality: { name: 'WEB 1080p' }, allowed: true }, { quality: { name: 'SDTV' }, allowed: false }] }], formatItems: [{ format: 1, name: 'Multi subs', score: 100 }] }] };
    const observer = new ArrObserver({ sonarr: sonarr as any, source: { sonarr: { id: 'a', url: 'http://s', apiKey: 'key' } }, clock: () => Date.parse('2026-01-01') });
    expect((await observer.observe()).targets[0]?.context.profileContext).toEqual({ qualities: ['WEB 1080p'], customFormats: ['Multi subs (100)'], unknown: false });
  });
  it('holds a completed download while Arr is still waiting to import its file', async () => {
    const sonarr = { getSeries: async () => [series], getEpisodes: async () => episodes, getQueue: async () => [{ seriesId: 1, episodeId: 1, status: 'completed', trackedDownloadState: 'importPending' }] };
    const observer = new ArrObserver({ sonarr: sonarr as any, source: { sonarr: { id: 'a', url: 'http://s', apiKey: 'key' } }, clock: () => Date.parse('2021-01-01') });
    const snapshot = await observer.observe();
    expect(snapshot.targets.find(t => t.episodeId === 1)?.eligible).toBe(false);
    expect(snapshot.targets.find(t => t.episodeId === 2)?.eligible).toBe(true);
  });
  it('includes the primary title when no aliases exist', async () => {
    const sonarr = { getSeries: async () => [series], getEpisodes: async () => episodes, getQueue: async () => [] };
    const observer = new ArrObserver({ sonarr: sonarr as any, source: { sonarr: { id: 'a', url: 'http://s', apiKey: 'key' } }, clock: () => Date.parse('2021-01-01') });
    expect((await observer.observe()).targets[0]?.context.titles).toContain('Show');
  });
  it('persists episode-fetch Retry-After and avoids further source reads while throttled', async () => {
    const retry = vi.fn();
    let reads = 0;
    const sonarr = { getSeries: async () => { reads++; return [series]; }, getEpisodes: async () => { throw Object.assign(new Error('private'), { retryAfter: 3600 }); }, getQueue: async () => [] };
    const observer = new ArrObserver({ sonarr: sonarr as any, source: { sonarr: { id: 'a', url: 'http://s', apiKey: 'key' } }, onRetryAfter: retry, clock: () => Date.parse('2026-01-01') });
    await observer.observe();
    expect(retry).toHaveBeenCalledWith('sonarr', 3600);
    await observer.observe();
    expect(reads).toBe(1);
  });
  it('keeps failed episode and profile reads as scoped unknown context without blocking other providers', async () => {
    const sonarr = {
      getSeries: async () => [series], getQueue: async () => [{ title: 'unidentified', downloadId: 'private', statusMessages: [{ messages: ['private error'] }] }],
      getEpisodes: async () => { throw new Error('private series error'); }, getQualityProfiles: async () => { throw Object.assign(new Error('rate limited'), { retryAfter: 17 }); },
    };
    let retry: [string, number] | undefined;
    const snapshot = await new ArrObserver({ sonarr: sonarr as any, source: { sonarr: { id: 'a', url: 'http://s', apiKey: 'key' } }, onRetryAfter: (source, seconds) => { retry = [source, seconds]; }, clock: () => Date.parse('2021-01-01') }).observe();
    expect(snapshot.sonarr.known).toBe(true);
    expect(snapshot.sonarr.diagnostics.unknownSeriesIds).toEqual([1]);
    expect(snapshot.sonarr.targets).toEqual([]);
    expect(snapshot.sonarr.diagnostics.unidentifiedQueueRows).toBe(1);
    expect(retry).toEqual(['sonarr', 17]);
    expect(JSON.stringify(snapshot)).not.toContain('private');
  });
  it('keeps future episodes visible but not eligible, with allowlisted context metadata', async () => {
    const future = { ...episodes[0], airDate: '2030-01-01', overview: 'Synopsis https://private.test/path' };
    const richSeries = { ...series, qualityProfileId: 4, qualityProfile: { quality: { name: 'HD-1080p' }, formatItems: [{ name: 'Anime', score: 10 }] } };
    const sonarr = { getSeries: async () => [richSeries], getEpisodes: async () => [future], getQueue: async () => [] };
    const target = (await new ArrObserver({ sonarr: sonarr as any, source: { sonarr: { id: 'a', url: 'http://s', apiKey: 'key' } }, clock: () => Date.parse('2026-01-01') }).observe()).targets[0]!;
    expect(target.eligible).toBe(false);
    expect(target.context.profileContext).toEqual({ qualities: ['HD-1080p'], customFormats: ['Anime (10)'], unknown: false });
    expect(JSON.stringify(target.context)).not.toContain('private.test');
  });
  it('isolates provider errors and suppresses only directly identified episodes', async () => {
    const sonarr = { getSeries: vi.fn(async () => [series]), getEpisodes: vi.fn(async () => episodes), getQueue: vi.fn(async () => [{ seriesId: 1, episodeId: 1, seasonNumber: 1, status: 'downloading' }]) } as unknown as SonarrClient;
    const radarr = { getMovies: vi.fn(async () => { throw Error('private upstream details'); }), getQueue: vi.fn() } as unknown as RadarrClient;
    const snapshot = await new ArrObserver({ sonarr, radarr, source: { sonarr: { id: 'a', url: 'http://s', apiKey: 'secret' }, radarr: { id: 'b', url: 'http://r', apiKey: 'secret' } }, clock: () => Date.parse('2021-01-01T00:00:00Z') }).observe();
    expect(snapshot.sonarr.known).toBe(true);
    expect(snapshot.sonarr.targets.find(t => t.episodeId === 1)?.eligible).toBe(false);
    expect(snapshot.sonarr.targets.find(t => t.episodeId === 2)?.eligible).toBe(true);
    expect(snapshot.radarr.known).toBe(false);
    expect(JSON.stringify(snapshot)).not.toContain('secret');
    expect(JSON.stringify(snapshot)).not.toContain('private upstream details');
  });
});
