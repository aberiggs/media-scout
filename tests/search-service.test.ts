import { afterEach, describe, expect, it, vi } from 'vitest';
import { SearchService } from '../src/search/service';
import { openSearchStore } from '../src/search/store';
import type { LLMClient } from '../src/clients/llm';
import { ApiError } from '../src/http';
import { releaseSchema } from '../src/types/prowlarr';

const action = (values: Record<string, unknown>) => ({ action: 'finish', query: null, categories: null, indexerIds: null, status: null, options: null, message: null, ...values });
const release = (n = 0, title = `Show S02E01 release ${n}`) => releaseSchema.parse({ guid: `g${n}`, indexerId: 1, indexer: 'Index', title, publishDate: '', protocol: 'torrent', seeders: n, downloadUrl: `http://private/api?apikey=secret${n}` });
const stores: ReturnType<typeof openSearchStore>[] = [];
function setup(respond: (input: any) => unknown, search = async (_: unknown) => [release()], limits = {}) {
  const store = openSearchStore(':memory:'); stores.push(store);
  const inputs: any[] = [], searches: any[] = [];
  const llm = { json: async (args: any) => { const input = JSON.parse(args.user); inputs.push(input); return respond(input); } } as LLMClient;
  const prowlarr = { getIndexers: async () => [{ id: 1, name: 'Index', enable: true }, { id: 2, name: 'Off', enable: false }], getIndexerStatuses: async () => [], search: async (args: unknown) => { searches.push(args); return search(args); } };
  const service = new SearchService({ llm, prowlarr: prowlarr as any, store, limits });
  return { service, store, inputs, searches, prowlarr };
}
afterEach(() => { for (const store of stores.splice(0)) store.close(); vi.useRealTimers(); });

describe('bounded neutral search', () => {
  it.each([100, 200])('delivers all %s candidates and can select the last without leaking private locators', async (count) => {
    const { service, inputs, searches } = setup(input => {
      if (!input.candidates.length) return action({ action: 'search_releases', query: 'Show S02E01', indexerIds: [1, 2] });
      const last = input.candidates.at(-1);
      return action({ status: 'matched', options: [{ optionId: 'best', rank: 1, releases: [{ candidateId: last.candidateId }], coveredTargetIds: [], reason: 'Best suitable release', uncertainty: 'Language unspecified' }] });
    }, async () => Array.from({ length: count }, (_, i) => release(i)));
    const result = await service.run({ prompt: 'Find Show episode' });
    expect(result.status).toBe('matched');
    expect(result.counts.candidates).toBe(count);
    expect(inputs[1].candidates).toHaveLength(count);
    expect(JSON.stringify(inputs)).not.toContain('apikey=');
    expect(searches[0].indexerIds).toEqual([1]);
  });
  it('allows a final decision after the search-call budget is used', async () => {
    const { service } = setup(input => !input.candidates.length ? action({ action: 'search_releases', query: 'Show' }) : action({ status: 'no-match', message: 'No suitable release' }), undefined, { searches: 1 });
    expect((await service.run({ prompt: 'Find' })).status).toBe('no-match');
  });
  it('rejects matched output without any actual option', async () => {
    const { service } = setup(() => action({ status: 'matched' }));
    expect((await service.run({ prompt: 'Find' })).status).toBe('failed');
  });
  it('permits one evidence-based correction of an invalid final selection', async () => {
    const { service } = setup(input => {
      if (!input.candidates.length) return action({ action: 'search_releases', query: 'Show' });
      if (!input.transcript.some((e: any) => e.type === 'selection-rejected')) return action({ status: 'matched', options: [] });
      return action({ status: 'matched', options: [{ optionId: 'fixed', rank: 1, releases: [{ candidateId: input.candidates[0].candidateId }], coveredTargetIds: [], reason: 'Observed release', uncertainty: '' }] });
    });
    const result = await service.run({ prompt: 'Find Show' });
    expect(result.status).toBe('matched');
    expect(result.counts.decisions).toBe(3);
  });
  it('rejects explicit wrong-season evidence from real observed titles', async () => {
    const { service } = setup(input => !input.candidates.length ? action({ action: 'search_releases', query: 'Show' }) : action({ status: 'matched', options: [{ optionId: 'wrong', rank: 1, releases: [{ candidateId: input.candidates[0].candidateId }], coveredTargetIds: ['e1'], reason: 'looks similar', uncertainty: '' }] }), async () => [release(1, 'Show S01E01')]);
    expect((await service.run({ prompt: 'Find Show S02E01', context: { kind: 'tv', scope: { type: 'episode', seasonNumber: 2, episodeNumber: 1 }, targets: [{ targetId: 'e1', seasonNumber: 2, episodeNumber: 1 }] } })).status).toBe('failed');
  });
  it.each(['Show E02', 'Show - 27'])('rejects contradictory observed numbering: %s', async title => {
    const { service } = setup(input => !input.candidates.length ? action({ action: 'search_releases', query: 'Show' }) : action({ status: 'matched', options: [{ optionId: 'wrong', rank: 1, releases: [{ candidateId: input.candidates[0].candidateId }], coveredTargetIds: ['e1'], reason: 'similar', uncertainty: '' }] }), async () => [release(1, title)]);
    const result = await service.run({ prompt: 'Find Show S02E01 absolute26', context: { kind: 'tv', scope: { type: 'episode', seasonNumber: 2, episodeNumber: 1, absoluteEpisodeNumber: 26 }, targets: [{ targetId: 'e1', seasonNumber: 2, episodeNumber: 1 }] } });
    expect(result.status).toBe('failed');
  });
  it('bounds repeated list actions and search attempts separately', async () => {
    const listing = setup(() => action({ action: 'list_indexers' }), undefined, { decisions: 2 });
    expect((await listing.service.run({ prompt: 'Find' })).status).toBe('budget-exhausted');
    expect(listing.inputs).toHaveLength(2);
    const searching = setup(() => action({ action: 'search_releases', query: 'Show' }), undefined, { searches: 1 });
    expect((await searching.service.run({ prompt: 'Find' })).status).toBe('budget-exhausted');
    expect(searching.searches).toHaveLength(1);
  });
  it('never broadcasts an empty healthy allowlist', async () => {
    const { service, searches } = setup(() => action({ action: 'search_releases', query: 'Show', indexerIds: [2] }));
    expect((await service.run({ prompt: 'Find' })).status).toBe('failed');
    expect(searches).toHaveLength(0);
  });
  it('records source Retry-After and prevents a subsequent paid search', async () => {
    const { service, store, inputs } = setup(() => action({ action: 'search_releases', query: 'Show' }), async () => { throw new ApiError(429, 'prowlarr', '', 600); });
    expect((await service.run({ prompt: 'Find' })).status).toBe('failed');
    expect(store.getProviderDeadline('prowlarr')).toBeGreaterThan(Date.now() + 590_000);
    const before = inputs.length;
    expect((await service.run({ prompt: 'Find again' })).status).toBe('failed');
    expect(inputs).toHaveLength(before);
  });
  it('honors Retry-After during initialization without recontacting the provider', async () => {
    const { service, store, prowlarr, inputs } = setup(() => action({ status: 'no-match' }));
    let calls = 0;
    prowlarr.getIndexers = async () => { calls++; throw new ApiError(429, 'prowlarr', '', 600); };
    await service.run({ prompt: 'Find' });
    expect(store.getProviderDeadline('prowlarr')).toBeGreaterThan(Date.now() + 590_000);
    await service.run({ prompt: 'Find again' });
    expect(calls).toBe(1);
    expect(inputs).toHaveLength(0);
  });
  it('times out initialization and cannot later change the terminal result', async () => {
    vi.useFakeTimers();
    const { service, store, prowlarr } = setup(() => action({ status: 'no-match' }), undefined, { deadlineMs: 10 });
    prowlarr.getIndexers = () => new Promise(() => {});
    const pending = service.run({ prompt: 'Find' });
    await vi.advanceTimersByTimeAsync(11);
    const result = await pending;
    expect(result.status).toBe('budget-exhausted');
    expect(store.getSearch(result.searchId)?.status).toBe('budget-exhausted');
  });
  it('aborts a pending model call at the service deadline and ignores a late match', async () => {
    vi.useFakeTimers();
    let resolveModel!: (value: unknown) => void;
    let callArgs: any;
    const { service, store } = setup(() => action({ status: 'no-match' }), undefined, { deadlineMs: 10 });
    (service as any).deps.llm.json = (args: any) => { callArgs = args; return new Promise(resolve => { resolveModel = resolve; }); };
    const pending = service.run({ prompt: 'Find' });
    await vi.advanceTimersByTimeAsync(11);
    const result = await pending;
    expect(result.status).toBe('budget-exhausted');
    expect(callArgs).toMatchObject({ maxAttempts: 1, retryTransport: false });
    expect(callArgs.signal.aborted).toBe(true);
    resolveModel(action({ status: 'matched' }));
    await vi.advanceTimersByTimeAsync(0);
    expect(store.getSearch(result.searchId)?.status).toBe('budget-exhausted');
  });
  it('retains conflicting observations for the same physical release', async () => {
    const { service, inputs } = setup(input => !input.candidates.length ? action({ action: 'search_releases', query: 'Show' }) : action({ status: 'no-match' }), async () => [{ ...release(1, 'Show S01E01'), infoHash: 'same' }, { ...release(2, 'Show S02E01'), infoHash: 'same' }]);
    await service.run({ prompt: 'Find' });
    expect(inputs[1].candidates).toHaveLength(1);
    expect(inputs[1].candidates[0].observations).toHaveLength(2);
  });
});
