import { describe, expect, it, vi } from 'vitest';
import { ArrObserver } from '../src/search/arr';
import type { RadarrClient } from '../src/clients/radarr';
import { SonarrClient } from '../src/clients/sonarr';
import { ApiError, Http } from '../src/http';
import { createServer } from 'node:http';

const series = { id: 1, tvdbId: 10, title: 'Show', titleSlug: 'show', seriesType: 'standard' as const, monitored: true, seasons: [], alternateTitles: [], overview: 'overview', originalLanguage: { id: 1, name: 'English' } };
const episodes = [1,2].map(id => ({ id, seriesId: 1, seasonNumber: 1, episodeNumber: id, absoluteEpisodeNumber: null, title: `E${id}`, airDate: '2020-01-01', airDateUtc: null, finaleType: null, monitored: true, hasFile: false }));
const sources = { radarr: { id: 'r', url: 'http://r', apiKey: 'k' } };

describe('ArrObserver', () => {
  it('keeps scheduled observation sanitized but exposes typed focused HTTP failures and records Arr cooldown', async () => {
    let status = 503, calls = 0, retry = 0;
    const server = createServer((_request,response) => { calls++; response.writeHead(status, status===429?{'retry-after':'37'}:{}); response.end('private upstream body'); });
    await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
    const address=server.address(); if(!address || typeof address==='string') throw new Error('fixture listener unavailable');
    const url=`http://127.0.0.1:${address.port}`;
    const observer=new ArrObserver({sonarr:new SonarrClient(new Http({baseUrl:url,apiKey:'fixture'})),source:{sonarr:{id:'s',url,apiKey:'fixture'}},onRetryAfter:(_provider,seconds)=>{retry=seconds;}});
    try {
      const scheduled=await observer.observe();
      expect(scheduled.sonarr).toMatchObject({known:false,error:'source-unavailable'});
      expect(JSON.stringify(scheduled)).not.toContain('private upstream');
      await expect(observer.observeMedia('sonarr',1)).rejects.toMatchObject({status:503});
      await expect(observer.queueStillClear('sonarr',1,[],()=>false)).rejects.toBeInstanceOf(ApiError);
      status=429;
      await expect(observer.observeMedia('sonarr',1)).rejects.toMatchObject({status:429,retryAfter:37});
      expect(retry).toBe(37);
      expect(calls).toBe(4);
    } finally { await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve())); }
  });
  it.each([
    ['date-only before UTC midnight', '2020-01-01', null, Date.parse('2020-01-01T23:59:59Z'), false],
    ['date-only at following UTC midnight', '2020-01-01', null, Date.parse('2020-01-02T00:00:00Z'), true],
    ['precise airtime', '2020-01-01', '2020-01-01T12:00:00Z', Date.parse('2020-01-01T12:00:00Z'), true],
    ['unknown invalid timing', 'bad-date', null, Date.parse('2026-01-01'), false],
  ])('ArrObserver handles %s eligibility', async (_name, airDate, airDateUtc, now, eligible) => {
    const episode = { ...episodes[0], airDate, airDateUtc };
    const observer = new ArrObserver({ sonarr: { getSeries: async () => [series], getEpisodes: async () => [episode], getQueue: async () => [] } as any, source: { sonarr: { id: 's', url: 'http://s', apiKey: 'k' } }, clock: () => now });
    expect((await observer.observe()).targets[0]?.eligible).toBe(eligible);
  });
  it.each([
    ['available monitored missing', true, true, false, true, true],
    ['unavailable', false, true, false, false, false],
    ['unmonitored', true, false, false, true, false],
    ['already has file', true, true, true, true, false],
  ])('Radarr %s movie eligibility', async (_name, isAvailable, monitored, hasFile, expectedAvailable, eligible) => {
    const movie = { id: 7, tmdbId: 70, title: 'Film', year: 2024, monitored, hasFile, isAvailable };
    const observer = new ArrObserver({ radarr: { getMovies: async () => [movie], getQueue: async () => [] } as any, source: sources, clock: () => Date.parse('2026-01-01') });
    const target = (await observer.observe()).targets[0]!;
    expect([target.available, target.eligible]).toEqual([expectedAvailable, eligible]);
  });
  it('suppresses direct movie queues and scopes coarse TV rows to season or series', async () => {
    const movieObserver = new ArrObserver({ radarr: { getMovies: async () => [{ id: 7, tmdbId: 70, title: 'Film', monitored: true, hasFile: false, isAvailable: true }], getQueue: async () => [{ movieId: 7, status: 'downloading' }] } as any, source: sources });
    expect((await movieObserver.observe()).targets[0]?.eligible).toBe(false);
    const seasonEpisodes = [1, 2].map(id => ({ ...episodes[0], id, seasonNumber: id }));
    const queue: Array<{ seriesId: number; seasonNumber?: number; status: string }> = [{ seriesId: 1, seasonNumber: 1, status: 'downloading' }];
    const observer = new ArrObserver({ sonarr: { getSeries: async () => [series], getEpisodes: async () => seasonEpisodes, getQueue: async () => queue } as any, source: { sonarr: { id: 's', url: 'http://s', apiKey: 'k' } }, clock: () => Date.parse('2021-01-01') });
    expect((await observer.observe()).targets.map(t => t.eligible)).toEqual([false, true]);
    queue[0] = { seriesId: 1, status: 'warning' };
    expect((await observer.observe()).targets.map(t => t.eligible)).toEqual([false, false]);
    queue.splice(0);
    expect((await observer.observe()).targets.map(t => t.eligible)).toEqual([true, true]);
  });
  it.each(['failed', 'removed', 'warning', 'importPending'])('treats queue state %s according to terminal/import policy', async status => {
    const observer = new ArrObserver({ sonarr: { getSeries: async () => [series], getEpisodes: async () => episodes, getQueue: async () => [{ seriesId: 1, episodeId: 1, status }] } as any, source: { sonarr: { id: 's', url: 'http://s', apiKey: 'k' } }, clock: () => Date.parse('2021-01-01') });
    const target = (await observer.observe()).targets.find(t => t.episodeId === 1)!;
    expect(target.eligible).toBe(status === 'failed' || status === 'removed');
  });
  it('invalidates observed targets when source or external identity changes', async () => {
    let source = { sonarr: { id: 's', url: 'http://s', apiKey: 'k' } }, tvdbId = 10;
    const observer = new ArrObserver({ sonarr: { getSeries: async () => [{ ...series, tvdbId }], getEpisodes: async () => episodes, getQueue: async () => [] } as any, source: () => source, clock: () => Date.parse('2021-01-01') });
    const original = (await observer.observe()).targets[0]!;
    tvdbId++;
    expect(await observer.validateTarget(original)).toBe(false);
    const next = (await observer.observe()).targets[0]!;
    source = { sonarr: { id: 's', url: 'http://different', apiKey: 'k' } };
    expect(await observer.validateTarget(next)).toBe(false);
  });
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
