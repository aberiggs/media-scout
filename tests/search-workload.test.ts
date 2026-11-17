import { describe, expect, it } from 'vitest';
import { buildEpisodeSetRequest } from '../src/search/workload';
import { ArrObserver } from '../src/search/arr';
import type { ArrTarget } from '../src/search/arr';

const target = (episodeId: number, airAt: number, context: Record<string, unknown> = {}): ArrTarget => ({
  key: `sonarr:fp:show:${episodeId}`, provider: 'sonarr', sourceFingerprint: 'fp', serviceId: 7, externalId: 77,
  episodeId, monitored: true, hasFile: false, eligible: true, available: true, airAt, context: { seasonNumber: 3, episodeNumber: episodeId, ...context },
});
describe('episode-set workload', () => {
  it('orders requested targets oldest first, retains show overview once, and labels contextual episodes', () => {
    const result = buildEpisodeSetRequest({ show: { titles: ['Show'], overview: 'Series synopsis' },
      targets: [target(2, 20), target(1, 10)], related: [{ ...target(3, 30), eligible: false, available: false }],
      observedAt: 40 });
    expect(result.targetRefs.map(r => r.key)).toEqual(['sonarr:fp:show:1', 'sonarr:fp:show:2']);
    expect(result.request.context?.overview).toBe('Series synopsis');
    expect(result.request.context?.targets).toHaveLength(2);
    expect(result.request.context?.relatedEpisodes?.[0]).toMatchObject({ available: false, contextReason: 'not-yet-available' });
  });
  it('rejects mixed-show targets and bounds selected work', () => {
    const targets = Array.from({ length: 201 }, (_, i) => target(i + 1, i));
    const result = buildEpisodeSetRequest({ show: {}, targets, related: [], observedAt: 1 });
    expect(result.targetRefs).toHaveLength(200);
    expect(() => buildEpisodeSetRequest({ show: {}, targets: [target(1, 0), { ...target(2, 1), serviceId: 8 }], related: [], observedAt: 1 })).toThrow(/one observed show/);
    expect(() => buildEpisodeSetRequest({ show: {}, targets: [target(1, 0)], related: [{ ...target(2, 1), serviceId: 8 }], observedAt: 1 })).toThrow(/related episodes/);
  });
  it('renders real Arr target context through the strict episode schema without calling series title an episode title', async () => {
    const episodes = [
      { id: 1, seriesId: 7, seasonNumber: 1, episodeNumber: 1, absoluteEpisodeNumber: null, title: 'Pilot', airDate: '2020-01-01', airDateUtc: null, monitored: true, hasFile: false },
      { id: 2, seriesId: 7, seasonNumber: 1, episodeNumber: 2, absoluteEpisodeNumber: 2, title: 'Owned', airDate: '2020-01-01', airDateUtc: null, monitored: true, hasFile: true },
      { id: 3, seriesId: 7, seasonNumber: 1, episodeNumber: 3, absoluteEpisodeNumber: null, title: 'Unmonitored', airDate: '2020-01-01', airDateUtc: null, monitored: false, hasFile: false },
      { id: 4, seriesId: 7, seasonNumber: 1, episodeNumber: 4, absoluteEpisodeNumber: null, title: 'Future', airDate: '2030-01-01', airDateUtc: null, monitored: true, hasFile: false },
      { id: 5, seriesId: 7, seasonNumber: 1, episodeNumber: 5, absoluteEpisodeNumber: null, title: 'Queued', airDate: '2020-01-01', airDateUtc: null, monitored: true, hasFile: false },
    ];
    const snapshot = await new ArrObserver({ sonarr: {
      getSeries: async () => [{ id: 7, tvdbId: 77, title: 'A Show', titleSlug: 'a-show', seriesType: 'standard', monitored: true, alternateTitles: [], overview: 'Show synopsis', seasons: [], originalLanguage: { name: 'English' } }],
      getEpisodes: async () => episodes, getQueue: async () => [{ seriesId: 7, episodeId: 5, status: 'downloading' }],
    } as any, source: { sonarr: { id: 's', url: 'http://local', apiKey: 'k' } as any }, clock: () => Date.parse('2026-01-01') }).observe();
    const targets = snapshot.sonarr.targets;
    const built = buildEpisodeSetRequest({
      targets: targets.filter(t => t.eligible), related: targets.filter(t => !t.eligible), observedAt: snapshot.observedAt });
    expect(built.request.context?.titles).toEqual(['A Show']);
    expect(built.request.context?.overview).toBe('Show synopsis');
    expect(built.request.context?.targets?.[0]).toMatchObject({ title: 'Pilot' });
    expect(built.request.context?.targets?.[0]).not.toHaveProperty('absoluteEpisodeNumber');
    expect(built.request.context?.relatedEpisodes?.map(r => r.contextReason)).toEqual(['already-owned', 'unmonitored', 'not-yet-available', 'observed-in-queue']);
    expect(built.request.context?.relatedEpisodes?.[1]?.queued).toBe(false);
    expect(built.request.context?.relatedEpisodes?.[3]?.queued).toBe(true);
    expect(JSON.stringify(built.request)).not.toContain('episodeTitle');
  });
  it('reports omitted related context and returns a clear error when targets cannot fit faithfully', () => {
    const one = target(1, 1);
    const result = buildEpisodeSetRequest({ show: {}, targets: [one], related: Array.from({ length: 100 }, (_, i) => target(i + 10, i + 10)), observedAt: 1, maxContextBytes: 2_000 });
    expect(result.omittedRelatedEpisodes).toBeGreaterThan(0);
    expect(result.request.context?.relatedEpisodesOmitted).toBe(result.omittedRelatedEpisodes);
    expect(() => buildEpisodeSetRequest({ show: {}, targets: [target(1, 1, { episodeTitle: 'x'.repeat(5_000) })], related: [], observedAt: 1, maxContextBytes: 1_000 })).toThrow(/cannot fit/);
  });
  it('bounds very long related inventories before strict schema validation', () => {
    const built = buildEpisodeSetRequest({ targets: [target(1, 1)], related: Array.from({ length: 5001 }, (_, i) => target(i + 2, i + 2)), observedAt: 1 });
    expect(built.omittedRelatedEpisodes).toBeGreaterThan(0);
    expect((built.request.context?.relatedEpisodes?.length ?? 0) + built.omittedRelatedEpisodes).toBe(5001);
    expect(Buffer.byteLength(JSON.stringify(built.request))).toBeLessThanOrEqual(48_000);
  });
  it('includes omission metadata when deciding whether the minimum request fits', () => {
    const base = { targets: [target(1, 1)], related: [], observedAt: 1 };
    const targetOnlyBytes = Buffer.byteLength(JSON.stringify(buildEpisodeSetRequest(base).request));
    expect(() => buildEpisodeSetRequest({ ...base, related: [target(2, 2)], maxContextBytes: targetOnlyBytes })).toThrow(/context budget/);
  });
});
