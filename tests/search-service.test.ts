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
  it('explains when another worker already owns this search id', async () => {
    const { service, store, searches } = setup(() => action({ status: 'no-match' }));
    const now = Date.now();
    store.acquireLease('search:already-running', 'existing-worker', now, 60_000);

    const result = await service.run({ prompt: 'Find' }, {}, undefined, {}, 'already-running');

    expect(result.status).toBe('failed');
    expect(result.message).toMatch(/another search is already running/i);
    expect(result.events.at(-1)?.data).toMatchObject({ code: 'search-busy' });
    expect(searches).toHaveLength(0);
  });
  it('runs independent searches concurrently even while a legacy global worker lease is live', async () => {
    const { service, store } = setup(() => action({ status: 'no-match' }));
    store.acquireLease('search-worker', 'legacy-worker', Date.now(), 60_000);

    const results = await Promise.all([
      service.run({ prompt: 'Find Example A' }),
      service.run({ prompt: 'Find Example B' }),
    ]);

    expect(results.map(result => result.status)).toEqual(['no-match', 'no-match']);
    expect(new Set(results.map(result => result.searchId)).size).toBe(2);
  });
  it('checks a provider cooldown again before each later outbound operation', async () => {
    const store = openSearchStore(':memory:'); stores.push(store);
    let prowlarrCalls = 0;
    const llm = { json: async () => {
      store.setProviderDeadline('prowlarr', Date.now() + 60_000);
      return action({ action: 'search_releases', query: 'Example', categories: [] });
    } } as unknown as LLMClient;
    const service = new SearchService({ llm, store, prowlarr: {
      getIndexers: async () => [{ id: 1, name: 'Index', enable: true }], getIndexerStatuses: async () => [],
      search: async () => { prowlarrCalls++; return []; },
    } });

    const result = await service.run({ prompt: 'Find Example' });

    expect(result.message).toMatch(/temporarily throttled/i);
    expect(prowlarrCalls).toBe(0);
  });
  it('does not make a second initialization call after a peer establishes a provider cooldown', async () => {
    const store = openSearchStore(':memory:'); stores.push(store);
    let statusCalls = 0;
    const service = new SearchService({ llm: { json: async () => action({ status: 'no-match' }) } as unknown as LLMClient, store, prowlarr: {
      getIndexers: async () => { store.setProviderDeadline('prowlarr', Date.now() + 60_000); return [{ id: 1, name: 'Index', enable: true }]; },
      getIndexerStatuses: async () => { statusCalls++; return []; }, search: async () => [],
    } });
    const result = await service.run({ prompt: 'Find Example' });
    expect(result.message).toMatch(/temporarily throttled/i);
    expect(statusCalls).toBe(0);
  });
  it('tells the model that invalid parsed scope evidence must never be selected', async () => {
    const { service } = setup(() => action({ status: 'no-match' }));
    let system = '';
    (service as any).deps.llm.json = async (args: { system: string }) => {
      system = args.system;
      return action({ status: 'no-match' });
    };

    expect((await service.run({ prompt: 'Find Show S02E06' })).status).toBe('no-match');
    expect(system).toMatch(/scope\.kind.*invalid/i);
    expect(system).toMatch(/never select that candidate/i);
    expect(system).toMatch(/selected candidates have usable scope evidence/i);
    expect(system).toMatch(/season-pack queries/i);
    expect(system).toMatch(/never claim inferred packs are verified complete/i);
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
  it('uses the remaining overall budget to bound and abort the Prowlarr search request', async () => {
    vi.useFakeTimers();
    let receivedOptions: any;
    let resolveSearch!: (value: any[]) => void;
    const { service } = setup(() => action({ action: 'search_releases', query: 'Show' }), async () => new Promise(resolve => { resolveSearch = resolve; }), { deadlineMs: 40 });
    const original = (service as any).deps.prowlarr.search;
    (service as any).deps.prowlarr.search = (args: unknown, options: unknown) => {
      receivedOptions = options;
      return original(args);
    };
    const pending = service.run({ prompt: 'Find' });
    await vi.advanceTimersByTimeAsync(41);
    expect(receivedOptions.timeoutMs).toBeLessThanOrEqual(40);
    expect(receivedOptions.signal.aborted).toBe(true);
    expect((await pending).status).toBe('budget-exhausted');
    resolveSearch([]);
  });
  it('reports a Prowlarr timeout without exposing upstream locators or credentials', async () => {
    const { service } = setup(() => action({ action: 'search_releases', query: 'private query' }), async () => {
      throw new ApiError(0, 'https://private.test/?apikey=secret', 'private query secret', undefined, true);
    });
    const result = await service.run({ prompt: 'Find' });
    expect(result.message).toMatch(/Prowlarr search timed out.*check.*indexer/i);
    expect(JSON.stringify(result)).not.toMatch(/private\.test|apikey=|secret/);
  });
  it('reports Prowlarr network failure safely without exposing upstream details', async () => {
    const { service } = setup(() => action({ action: 'search_releases', query: 'private query' }), async () => {
      throw new ApiError(0, 'https://private.test/?apikey=secret', 'socket refused private query secret');
    });
    const result = await service.run({ prompt: 'Find' });
    expect(result.message).toMatch(/Prowlarr search.*network.*check.*Prowlarr/i);
    expect(JSON.stringify(result)).not.toMatch(/private\.test|apikey=|secret|socket refused/);
  });
  it('keeps caller cancellation as interrupted and aborts the search signal', async () => {
    const controller = new AbortController();
    let requestSignal!: AbortSignal;
    const { service } = setup(() => action({ action: 'search_releases', query: 'Show' }), async () => {
      controller.abort();
      return new Promise(() => {});
    });
    const original = (service as any).deps.prowlarr.search;
    (service as any).deps.prowlarr.search = (args: unknown, options: any) => {
      requestSignal = options.signal;
      return original(args);
    };
    const result = await service.run({ prompt: 'Find' }, {}, controller.signal);
    expect(result.status).toBe('interrupted');
    expect(requestSignal.aborted).toBe(true);
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
