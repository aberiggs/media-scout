import { afterEach, describe, expect, it } from 'vitest';
import { SearchService, physicalRelease } from '../src/search/service';
import { openSearchStore } from '../src/search/store';
import { releaseSchema } from '../src/types/prowlarr';
import type { LLMClient } from '../src/clients/llm';
import { ArrObserver } from '../src/search/arr';
import { buildEpisodeSetRequest } from '../src/search/workload';
import { SubmissionService } from '../src/search/submission';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { vi } from 'vitest';

const stores: ReturnType<typeof openSearchStore>[] = [];
const tempDirs: string[] = [];
const envelope = (action: string, values: Record<string, unknown>) => ({
  action, query: null, categories: null, indexerIds: null, status: null, options: null, message: null, ...values,
});
afterEach(() => { stores.splice(0).forEach(s => s.close()); tempDirs.splice(0).forEach(d => rmSync(d, { recursive: true, force: true })); });

describe('episode-set SearchService', () => {
  it('searches with batch wire schema and derives partial coverage despite parsed season mismatch', async () => {
    const store = openSearchStore(':memory:'); stores.push(store);
    const seen: any[] = [];
    const release = releaseSchema.parse({ guid: 'guid1', indexerId: 1, indexer: 'Index', title: 'Show S01 Complete 1080p', publishDate: '', protocol: 'torrent', seeders: 20, downloadUrl: 'http://private' });
    let calls = 0;
    const llm = { json: async (input: any) => {
      seen.push(input); calls++;
      return calls === 1 ? envelope('search_releases', { query: 'Show episodes', categories: [5000] }) :
        envelope('finish', { status: 'matched', options: [{ optionId: 'plan', rank: 1, releases: [
          { candidateId: input.user && JSON.parse(input.user).candidates[0].candidateId, coveredTargetIds: ['a'], coverageReason: 'Alternate numbering fits', uncertainty: 'Inferred' },
        ], reason: 'Useful partial coverage', uncertainty: '' }] });
    } } as unknown as LLMClient;
    const service = new SearchService({ llm, prowlarr: { getIndexers: async () => [{ id: 1, name: 'I', enable: true }], getIndexerStatuses: async () => [], search: async () => [release] } as any, store });
    const result = await service.run({ prompt: 'Plan episodes', context: { kind: 'tv', scope: { type: 'episode-set' }, externalIds: { tvdb: 10 }, targets: [{ targetId: 'a', seasonNumber: 2, episodeNumber: 1 }, { targetId: 'b', seasonNumber: 2, episodeNumber: 2 }] } });
    expect(result.status).toBe('matched');
    expect(result.options[0]).toMatchObject({ coverage: 'partial', coveredTargetIds: ['a'], uncoveredTargetIds: ['b'] });
    expect((result.options[0] as any).releases[0].coveredTargetIds).toEqual(['a']);
    expect(seen[0].system).not.toContain('Never choose a wrong season');
    expect(seen[0].system).toContain('search_releases');
    expect(seen[0].system).toContain('query');
    expect(seen[0].system).toContain('A year or bare show title alone does not establish all-season coverage');
    expect(seen[0].system).toContain('specials, recaps, unrelated spin-offs, and manga/print releases');
    expect(seen[0].system).toContain('one strong useful plan is enough');
    expect(seen[0].system).not.toMatch(/Re:Zero|Kaiju No\. 8/);
    expect(result.promptVersion).toBe('episode-set-2');
    expect(seen[0].jsonSchema.name).toBe('episode_set_action');
    expect(store.getSearch(result.searchId)?.status).toBe('matched');
  });

  it.each([null, 0])('rejects explicit conflicting identity and allows unknown candidate ID %s', async unknownId => {
    const store = openSearchStore(':memory:'); stores.push(store);
    const makeService = (id: number | null) => new SearchService({ llm: { json: async (input: any) => {
      const current = JSON.parse(input.user);
      if (!current.candidates.length) return envelope('search_releases', { query: 'Show', categories: [5000] });
      return envelope('finish', { status: 'matched', options: [{ optionId: 'p', rank: 1, releases: [{ candidateId: current.candidates[0].candidateId, coveredTargetIds: ['a'], coverageReason: 'matches', uncertainty: '' }], reason: 'ok', uncertainty: '' }] });
    } } as unknown as LLMClient, prowlarr: { getIndexers: async () => [{ id: 1, name: 'I', enable: true }], getIndexerStatuses: async () => [], search: async () => [releaseSchema.parse({ guid: `g${id}`, indexerId: 1, indexer: 'I', title: 'Show S99 pack', publishDate: '', protocol: 'torrent', tvdbId: id, downloadUrl: '' })] } as any, store });
    const request: any = { prompt: 'Find', context: { scope: { type: 'episode-set' }, externalIds: { tvdb: 10 }, targets: [{ targetId: 'a' }] } };
    const bad = await makeService(11).run(request);
    expect(bad.status).not.toBe('matched');
    const unknown = await makeService(unknownId).run(request);
    expect(unknown.status).toBe('matched');
  });
  it('maps batch exclusions to target refs rather than excluding a release for the entire batch', async () => {
    const store = openSearchStore(':memory:'); stores.push(store);
    const release = releaseSchema.parse({ guid: 'exclude-guid', indexerId: 1, indexer: 'I', title: 'Show S01 pack', publishDate: '', protocol: 'torrent', downloadUrl: '' });
    store.saveExclusion('arr-a', physicalRelease(release), Date.now() + 60_000, 'prior target failure');
    let calls = 0;
    const llm = { json: async (input: any) => {
      const state = JSON.parse(input.user);
      if (!state.candidates.length) return envelope('search_releases', { query: 'Show', categories: [5000] });
      expect(state.candidates[0].excludedTargetIds).toEqual(['a']);
      calls++;
      return envelope('finish', { status: 'matched', options: [{ optionId: 'p', rank: 1, releases: [{ candidateId: state.candidates[0].candidateId, coveredTargetIds: ['b'], coverageReason: 'fits target b', uncertainty: '' }], reason: 'Alternative target remains usable', uncertainty: '' }] });
    } } as unknown as LLMClient;
    const service = new SearchService({ llm, prowlarr: { getIndexers: async () => [{ id: 1, name: 'I', enable: true }], getIndexerStatuses: async () => [], search: async () => [release] } as any, store });
    const result = await service.run({ prompt: 'Find', context: { scope: { type: 'episode-set' }, targets: [{ targetId: 'a' }, { targetId: 'b' }] } }, {}, undefined, { targetRefs: [{ targetId: 'a', key: 'arr-a' }, { targetId: 'b', key: 'arr-b' }] });
    expect(result.status).toBe('matched');
    expect(calls).toBe(1);
  });
  it('returns an explicit context budget result rather than sending an oversized target view', async () => {
    const store = openSearchStore(':memory:'); stores.push(store);
    let modelCalls = 0;
    const service = new SearchService({ llm: { json: async () => { modelCalls++; return envelope('finish', {}); } } as unknown as LLMClient,
      prowlarr: {} as any, store });
    const result = await service.run({ prompt: 'Find', context: { scope: { type: 'episode-set' }, targets: [{ targetId: 'a', title: 'x'.repeat(50_000) }] } });
    expect(result.status).toBe('budget-exhausted');
    expect(result.message).toMatch(/context budget/);
    expect(modelCalls).toBe(0);
  });
  it.each([['a', 'failed'], ['b', 'matched']] as const)('enforces an exclusion on assigned target %s', async (assigned, status) => {
    const store = openSearchStore(':memory:'); stores.push(store);
    const release = releaseSchema.parse({ guid: 'excluded', indexerId: 1, indexer: 'I', title: 'Show S01 pack', publishDate: '', protocol: 'torrent' });
    store.saveExclusion('arr-a', physicalRelease(release), Date.now() + 60_000, 'prior failure');
    const service = new SearchService({ store, llm: { json: async (args: { user: string }) => {
      const state = JSON.parse(args.user);
      return state.candidates.length ? envelope('finish', { status: 'matched', options: [{ optionId: 'p', rank: 1, releases: [{ candidateId: state.candidates[0].candidateId, coveredTargetIds: [assigned], coverageReason: 'Inferred coverage', uncertainty: '' }], reason: 'Plan', uncertainty: '' }] }) : envelope('search_releases', { query: 'Show' });
    } } as unknown as LLMClient, prowlarr: { getIndexers: async () => [{ id: 1, name: 'I', enable: true }], getIndexerStatuses: async () => [], search: async () => [release] } });
    const result = await service.run({ prompt: 'Plan', context: { scope: { type: 'episode-set' }, targets: [{ targetId: 'a' }, { targetId: 'b' }] } }, {}, undefined, { targetKeys: ['arr-a', 'arr-b'], targetRefs: [{ targetId: 'a', key: 'arr-a' }, { targetId: 'b', key: 'arr-b' }] });
    expect(result.status).toBe(status);
    if (assigned === 'a') expect(result.events).toContainEqual({ type: 'selection-rejected', data: { code: 'temporarily-excluded-release' } });
  });
  it.each([[302, 80, 'matched'], [600, 1000, 'budget-exhausted']] as const)('keeps %i observed candidates within a separate evidence bound', async (count, titleLength, status) => {
    const store = openSearchStore(':memory:'); stores.push(store);
    const releases = Array.from({ length: count }, (_, i) => releaseSchema.parse({ guid: `g${i}`, indexerId: 1, indexer: 'I', title: `${'Show'.padEnd(titleLength, 'x')} S01 pack ${i}`, publishDate: '', protocol: 'torrent' }));
    let modelCalls = 0;
    const service = new SearchService({ store, llm: { json: async (args: { user: string }) => {
      modelCalls++;
      const state = JSON.parse(args.user);
      if (!state.candidates.length) return envelope('search_releases', { query: 'Show' });
      expect(state.candidates).toHaveLength(count);
      return envelope('finish', { status: 'matched', options: [{ optionId: 'p', rank: 1, releases: [{ candidateId: state.candidates[0].candidateId, coveredTargetIds: ['a'], coverageReason: 'Inferred pack', uncertainty: '' }], reason: 'Plan', uncertainty: '' }] });
    } } as unknown as LLMClient, prowlarr: { getIndexers: async () => [{ id: 1, name: 'I', enable: true }], getIndexerStatuses: async () => [], search: async () => releases } });
    const result = await service.run({ prompt: 'Plan', context: { scope: { type: 'episode-set' }, targets: [{ targetId: 'a' }] } });
    expect(result.status).toBe(status);
    expect(store.listCandidates(result.searchId)).toHaveLength(count);
    expect(modelCalls).toBe(status === 'matched' ? 2 : 1);
  });

  it.each([
    { show: 'Synthetic Re Zero', alias: 'Synthetic Re:Zero alias', releaseSeasons: [1, 2, 3, 4], targetsBySeason: [['target-1'], ['target-2'], ['target-3'], ['target-4']], uncovered: ['target-5'] },
    { show: 'Synthetic Kaiju No. 8', alias: 'Synthetic Kaiju Eight alias', releaseSeasons: [1, 2], targetsBySeason: [['target-1', 'target-2'], ['target-3', 'target-4']], uncovered: ['target-5'] },
    { show: 'Synthetic Re Zero partial', alias: 'Synthetic Re:Zero partial alias', releaseSeasons: [1, 2, 4], targetsBySeason: [['target-1'], ['target-2'], ['target-4']], uncovered: ['target-3', 'target-5'] },
  ])('characterizes $show collapsed S1 with explicit synthetic later-season mappings', async fixture => {
    const dir = mkdtempSync(join(tmpdir(), 'media-scout-episode-set-')); tempDirs.push(dir);
    const dbPath = join(dir, 'search.sqlite');
    let store = openSearchStore(dbPath); stores.push(store);
    const episodes = [26, 27, 28, 29, 30, 31, 32, 33, 34].map(n => ({
      id: n, seriesId: 7, seasonNumber: 1, episodeNumber: n, absoluteEpisodeNumber: n,
      title: `Synthetic episode ${n}`, airDate: '2020-01-01', airDateUtc: null,
      monitored: n !== 33, hasFile: n === 32,
    }));
    episodes.find(e => e.id === 34)!.airDate = '2035-01-01';
    // Synthetic editions/number ranges only; these are not claims about public episode metadata.
    const queue = [{ seriesId: 7, episodeId: 29, status: 'downloading' }];
    const observer = new ArrObserver({ sonarr: {
      getSeries: async () => [{ id: 7, tvdbId: 77, title: fixture.show, titleSlug: 'synthetic',
        seriesType: 'anime', monitored: true, alternateTitles: [{ title: fixture.alias }],
        overview: 'Synthetic fixture', seasons: [], originalLanguage: { name: 'Japanese' } }],
      getEpisodes: async () => episodes, getQueue: async () => queue,
    } as any, source: { sonarr: { id: 'test', url: 'http://fake', apiKey: 'not-a-secret' } as any },
    clock: () => Date.parse('2026-01-01') });
    const snapshot = await observer.observe();
    const showTargets = snapshot.sonarr.targets;
    const built = buildEpisodeSetRequest({
      targets: showTargets.filter(t => t.eligible),
      related: showTargets.filter(t => !t.eligible),
      observedAt: snapshot.observedAt,
    });
    expect(built.request.context?.targets).toHaveLength(5);
    expect(built.request.context?.relatedEpisodes).toHaveLength(4);
    expect(built.request.context?.relatedEpisodes?.map(e => e.contextReason)).toEqual([
      'observed-in-queue', 'already-owned', 'unmonitored', 'not-yet-available',
    ]);
    expect(built.request.context?.targets?.map(t => t.targetId)).toEqual(['target-1', 'target-2', 'target-3', 'target-4', 'target-5']);
    const released = fixture.releaseSeasons.map(season => releaseSchema.parse({
      guid: `${fixture.show}-synthetic-season-${season}`, indexerId: 1, indexer: 'I',
      title: `${fixture.alias} S${String(season).padStart(2, '0')} 1080p`, publishDate: '', protocol: 'torrent',
      downloadUrl: `http://private/synthetic-${season}`,
    }));
    const queries: string[] = [];
    let calls = 0;
    const llm = { json: async ({ user }: { user: string }) => {
      const input = JSON.parse(user);
      if (calls++ === 0) return envelope('search_releases', { query: fixture.show, categories: [5000] });
      if (calls === 2) return envelope('search_releases', { query: `${fixture.alias} ${fixture.releaseSeasons.map(s => `S${s}`).join(' ')}`, categories: [5000] });
      return envelope('finish', { status: 'matched', options: [{ optionId: 'synthetic-plan', rank: 1, releases: [
        ...fixture.targetsBySeason.map((targets, i) => ({
          candidateId: input.candidates.find((candidate: any) => candidate.observations.some((o: any) => o.title.includes(`S${String(fixture.releaseSeasons[i]).padStart(2, '0')}`))).candidateId,
          coveredTargetIds: targets, coverageReason: 'Synthetic hand-authored fixture mapping', uncertainty: 'Inferred from labels; files not inspected',
        })),
      ], reason: 'Synthetic pack plan leaves target-5 uncovered', uncertainty: 'Fixture-only mapping' }] });
    } } as unknown as LLMClient;
    const service = new SearchService({ llm, store, prowlarr: {
      getIndexers: async () => [{ id: 1, name: 'I', enable: true }], getIndexerStatuses: async () => [],
      search: async ({ query }: { query: string }) => { queries.push(query); return query === fixture.show ? [released.at(-1)!] : released; },
    } as any });
    const result = await service.run(built.request, {}, undefined, { targetRefs: built.targetRefs });
    expect(queries).toEqual([fixture.show, `${fixture.alias} ${fixture.releaseSeasons.map(s => `S${s}`).join(' ')}`]);
    expect(result.status).toBe('matched');
    expect(result.candidates.some(c => c.observations.some(o => o.title.includes(`S${String(fixture.releaseSeasons.at(-1)).padStart(2, '0')}`)))).toBe(true);
    expect(result.candidates.some(c => c.observations.some(o => o.title.includes(`S${String(fixture.releaseSeasons[0]).padStart(2, '0')}`)))).toBe(true);
    expect(result.options[0]).toMatchObject({ coverage: 'partial', uncoveredTargetIds: fixture.uncovered });
    const releaseCandidateBySeason = new Map(result.candidates.flatMap(candidate => candidate.observations.flatMap(observation => {
      const season = /S(\d{2})/u.exec(observation.title)?.[1];
      return season ? [[Number(season), candidate.candidateId] as const] : [];
    })));
    const expectedAssignments = fixture.targetsBySeason.map((coveredTargetIds, i) => ({
      candidateId: releaseCandidateBySeason.get(fixture.releaseSeasons[i]!), coveredTargetIds,
      coverageReason: 'Synthetic hand-authored fixture mapping', uncertainty: 'Inferred from labels; files not inspected',
    }));
    expect((result.options[0] as any).releases).toEqual(expectedAssignments);
    store.close();
    stores.splice(stores.indexOf(store), 1);
    store = openSearchStore(dbPath); stores.push(store);
    expect((store.getSearch(result.searchId)?.result as any).options[0].releases).toEqual(expectedAssignments);
    const grab = vi.fn(async () => { throw new Error('must not be called'); });
    const submission = new SubmissionService({ store, prowlarr: {
      getDownloadClients: async () => [{ id: 1, name: 'TV', enable: true, protocol: 'torrent' }],
      grab,
    } as any, getPolicy: () => ({ dryRun: false, enabled: true, tvClient: 'TV', movieClient: '', queueGraceMinutes: 30 }) });
    const blocked = await submission.submit({ searchId: result.searchId, optionId: 'synthetic-plan', idempotencyKey: 'offline-test' });
    expect(blocked.outcome).toBe('rejected');
    expect(blocked.message).toMatch(/not enabled/);
    expect(grab).not.toHaveBeenCalled();
  });

  it('rejects an actual future context episode reference as acquisition coverage', async () => {
    const store = openSearchStore(':memory:'); stores.push(store);
    const release = releaseSchema.parse({ guid: 'negative', indexerId: 1, indexer: 'I', title: 'Synthetic Kaiju S02 pack', publishDate: '', protocol: 'torrent' });
    const makeService = (candidate: typeof release) => new SearchService({ store, prowlarr: { getIndexers: async () => [{ id: 1, name: 'I', enable: true }], getIndexerStatuses: async () => [], search: async () => [candidate] } as any,
      llm: { json: async ({ user }: { user: string }) => {
        const state = JSON.parse(user);
        return state.candidates.length ? envelope('finish', { status: 'matched', options: [{ optionId: 'bad', rank: 1, releases: [{ candidateId: state.candidates[0].candidateId, coveredTargetIds: ['later-episode'], coverageReason: 'wrong', uncertainty: '' }], reason: 'bad', uncertainty: '' }] }) :
          envelope('search_releases', { query: 'Synthetic Kaiju', categories: [5000] });
      } } as unknown as LLMClient });
    const request = { prompt: 'Synthetic', context: { scope: { type: 'episode-set' as const },
      targets: [{ targetId: 'requested', seasonNumber: 1, episodeNumber: 1 }],
      relatedEpisodes: [{ episodeRef: 'later-episode', seasonNumber: 2, episodeNumber: 1, hasFile: false, queued: false, monitored: true, available: false, contextReason: 'not-yet-available' }] } };
    const related = await makeService(release).run(request);
    expect(related.status).not.toBe('matched');
    expect(related.events).toContainEqual(expect.objectContaining({ type: 'selection-rejected', data: { code: 'invalid target reference' } }));
  });
});
