import { afterEach, describe, expect, it } from 'vitest';
import { ArrAutomation } from '../src/search/automation';
import { SearchService } from '../src/search/service';
import { SubmissionService } from '../src/search/submission';
import { openSearchStore } from '../src/search/store';
import { releaseSchema } from '../src/types/prowlarr';
import type { SearchRequest } from '../src/search/contracts';
import type { LLMClient } from '../src/clients/llm';
import type { ArrSnapshot, ArrTarget } from '../src/search/arr';

const stores: ReturnType<typeof openSearchStore>[] = [];
afterEach(() => { for (const store of stores.splice(0)) store.close(); });

function makeRun(opts: { episodes?: number[]; abs?: number[]; selectedTitle?: string; candidateCount?: number; multiReleaseOption?: boolean; externalId?: number; releaseTvdbId?: number; sharedPhysical?: boolean } = {}) {
  let now = Date.parse('2026-01-01T00:00:00Z');
  const store = openSearchStore(':memory:'); stores.push(store);
  const ids = opts.episodes ?? [1];
  const targets: ArrTarget[] = ids.map((episode, i) => ({
    key: `sonarr:fp:1:${opts.externalId ?? 20}:${episode}`, provider: 'sonarr', sourceFingerprint: 'fp', serviceId: 1, externalId: opts.externalId ?? 20,
    episodeId: episode, monitored: true, hasFile: false, available: true, eligible: true, airAt: i,
    context: { title: 'Anime', titles: ['Anime'], seasonNumber: 1, episodeNumber: episode,
      ...(opts.abs?.[i] !== undefined ? { absoluteEpisodeNumber: opts.abs[i] } : {}), episodeTitle: `Episode ${episode}`, seriesType: 'anime' },
  }));
  const observer = {
    observe: async (): Promise<ArrSnapshot> => ({ observedAt: now,
      sonarr: { known: true, observedAt: now, targets, queue: [], diagnostics: { unidentifiedQueueRows: 0 } },
      radarr: { known: false, observedAt: now, targets: [], queue: [], diagnostics: { unidentifiedQueueRows: 0 } }, targets }),
    validateTarget: async () => true, sourceFingerprint: () => 'fp',
  };
  let request: SearchRequest | undefined;
  const grabs: string[] = [];
  const prowlarr = {
    getIndexers: async () => [{ id: 1, name: 'Index', enable: true }],
    getIndexerStatuses: async () => [],
    search: async () => Array.from({ length: opts.candidateCount ?? 1 }, (_, i) => releaseSchema.parse({
      guid: `g${i}`, infoHash: opts.sharedPhysical ? 'shared-physical-pack' : `physical-${i}`, indexerId: 1, indexer: 'Index', title: opts.selectedTitle ?? 'Anime S01 1080p',
      ...(opts.releaseTvdbId !== undefined ? { tvdbId: opts.releaseTvdbId } : {}),
      publishDate: '', protocol: 'torrent', downloadUrl: `http://unused/${i}`,
    })),
    getDownloadClients: async () => [{ id: 1, name: 'TV', enable: true, protocol: 'torrent' as const, supportsCategories: false, categories: [] }],
    grab: async () => { grabs.push('grabbed'); },
  };
  const llm = { json: async ({ user }: { user: string }) => {
    const input = JSON.parse(user);
    if (input.request) request = input.request as SearchRequest;
    if (!input.candidates.length) return { action: 'search_releases', query: 'Anime', categories: [], indexerIds: [1], status: null, options: null, message: null };
    const chosen = input.candidates[(opts.candidateCount ?? 1) - 1];
    const releases = opts.multiReleaseOption ? input.candidates.slice(0, 2) : [chosen];
    const covers = [input.request.context.targets[0].targetId];
    return { action: 'finish', query: null, categories: null, indexerIds: null, status: 'matched',
      options: [{ optionId: 'picked', rank: 1, releases: releases.map((candidate: { candidateId: string }) => ({ candidateId: candidate.candidateId })), coveredTargetIds: covers, reason: 'model claims coverage', uncertainty: '' }], message: null };
  } };
  const search = new SearchService({ llm: llm as unknown as LLMClient, prowlarr, store, clock: () => now });
  const realSubmission = new SubmissionService({ store, prowlarr,
    getPolicy: () => ({ dryRun: false, enabled: true, tvClient: 'TV', movieClient: '', queueGraceMinutes: 30 }), clock: () => now });
  const automation = new ArrAutomation({ store, observer, search, submission: realSubmission, getPolicy: () => ({ enabled: true, dryRun: false }), clock: () => now });
  return { run: () => automation.runPass(), search, advance: (ms: number) => { now += ms; }, store, get request() { return request; }, grabs };
}

// Seerr ingestion is assumed; the fixture begins at the observed Arr target boundary.
// GAP tests deliberately document current defects, not behavior future fixes must preserve.
describe('Arr automation product audit (current behavior characterization)', () => {
  it('searches one episode target from a many-episode missing season; an evidenced same-season pack is accepted', async () => {
    const app = makeRun({ episodes: [1, 2, 3, 4], selectedTitle: 'Anime S01 1080p' });
    const pass = await app.run();
    expect(app.request?.context?.scope).toMatchObject({ type: 'episode', seasonNumber: 1, episodeNumber: 1 });
    expect(app.request?.context?.targets).toHaveLength(1);
    expect(pass.search?.status).toBe('matched');
    expect(pass.submission?.outcome).toBe('submitted');
    expect(app.grabs).toHaveLength(1);
  });

  it.each(['Anime S02E01 1080p', 'Anime S02 1080p'])('rejects collapsed anime episode S01E26 against %s, even when model claims target coverage', async title => {
    const app = makeRun({ episodes: [26], abs: [26], selectedTitle: title });
    const pass = await app.run();
    expect(app.request?.context?.scope).toMatchObject({ type: 'episode', seasonNumber: 1, episodeNumber: 26, absoluteEpisodeNumber: 26 });
    expect(pass.search?.status).toBe('failed');
    expect(pass.search?.events).toContainEqual(expect.objectContaining({ type: 'selection-rejected', data: { code: 'explicit wrong season' } }));
    expect(pass.submission).toBeUndefined();
    expect(app.grabs).toHaveLength(0);
  });

  it('rejects an episode option containing multiple physical releases', async () => {
    const app = makeRun({ candidateCount: 2, multiReleaseOption: true });
    const pass = await app.run();
    expect(pass.search?.status).not.toBe('matched');
    expect(pass.submission).toBeUndefined();
    expect(app.grabs).toHaveLength(0);
  });

  it('GAP (should change when fixed): actual SearchService matches explicit wrong TVDB identity if scripted model selects it', async () => {
    const app = makeRun({ externalId: 100, releaseTvdbId: 999, selectedTitle: 'Anime S01E01 1080p' });
    const pass = await app.run();
    expect(app.request?.context?.externalIds).toMatchObject({ tvdb: 100 });
    expect(pass.search?.status).toBe('matched');
    expect(pass.submission?.outcome).toBe('submitted');
    expect(app.grabs).toHaveLength(1);
  });

  it('GAP (should change when fixed): actual SearchService matches unscoped Complete candidate for episode request', async () => {
    const app = makeRun({ selectedTitle: 'Anime Complete 1080p' });
    const pass = await app.run();
    expect(app.request?.context?.scope).toMatchObject({ type: 'episode', seasonNumber: 1, episodeNumber: 1 });
    expect(pass.search?.candidates[0]?.observations[0]?.scope.kind).toBe('none');
    expect(pass.search?.status).toBe('matched');
    expect(pass.submission?.outcome).toBe('submitted');
  });

  it('GAP (should change when fixed): season search accepts E01-only evidence claiming a target bound to E14', async () => {
    const app = makeRun({ selectedTitle: 'Anime S01E01 1080p' });
    const result = await app.search.run({
      prompt: 'Find the missing episode 14 within season 1',
      context: { kind: 'tv', scope: { type: 'season', seasonNumber: 1 },
        targets: [{ targetId: 'later-episode', seasonNumber: 1, episodeNumber: 14 }] },
    });
    expect(result.status).toBe('matched');
    expect(result.options[0]?.coveredTargetIds).toEqual(['later-episode']);
    expect(result.candidates[0]?.observations[0]?.scope).toMatchObject({
      kind: 'claims', seasonClaims: [{ seasonNumber: 1, episodes: [1] }],
    });
  });

  it('defers a sibling target using the same physical pack during real submission grace', async () => {
    const app = makeRun({ episodes: [1, 2], selectedTitle: 'Anime S01 1080p', sharedPhysical: true });
    const first = await app.run();
    expect(first.submission?.outcome).toBe('submitted');
    expect(app.grabs).toHaveLength(1);
    app.advance(5 * 60_000); // show cooldown elapsed; submission grace remains active
    const second = await app.run();
    expect(second.targetKey).not.toBe(first.targetKey);
    expect(second.search?.status).toBe('matched');
    expect(second.submission?.outcome).toBe('deferred');
    expect(app.grabs).toHaveLength(1);
  });
});
