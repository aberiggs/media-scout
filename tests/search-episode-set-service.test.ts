import { afterEach, describe, expect, it } from 'vitest';
import { SearchService, physicalRelease } from '../src/search/service';
import { openSearchStore } from '../src/search/store';
import { releaseSchema } from '../src/types/prowlarr';
import type { LLMClient } from '../src/clients/llm';

const stores: ReturnType<typeof openSearchStore>[] = [];
const envelope = (action: string, values: Record<string, unknown>) => ({
  action, query: null, categories: null, indexerIds: null, status: null, options: null, message: null, ...values,
});
afterEach(() => stores.splice(0).forEach(s => s.close()));

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
});
