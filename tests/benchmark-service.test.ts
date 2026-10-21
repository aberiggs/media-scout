import { expect, it } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BenchmarkService } from '../src/benchmarks/service';
import { DatasetSchema } from '../src/benchmarks/contracts';
import nock from 'nock';

const dataset = DatasetSchema.parse(JSON.parse(readFileSync(new URL('../benchmarks/datasets/issue6-pilot-subset-v1.json', import.meta.url), 'utf8')));
const config = { requestId: 'launch-1', datasetId: dataset.id, datasetRevision: 1, profileId: 'configured', model: 'test', prompt: 'production-v1', tracks: ['plan-single'], split: 'development', repeats: 1, maxAttempts: 10, maxTokens: 100000, maxOutputTokens: 128, maxSeconds: 10, maxDollars: 2, disclosureApproved: true };
it('deduplicates paid starts, rejects concurrent different starts and persists cancellation', async () => {
  const root = mkdtempSync(join(tmpdir(), 'benchmark-service-'));
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  let calls = 0;
  try {
    const service = new BenchmarkService({ root, datasets: [dataset], profiles: () => [{ id: 'configured', label: 'Test', model: 'test', baseUrl: 'http://model.invalid', apiKey: 'canary-secret' }], quote: async () => ({ contextTokens: 1000, promptPerMillion: 1, completionPerMillion: 1, request: 0, observedAt: '2026-01-01T00:00:00.000Z' }), llmFactory: () => ({ async json(args) { calls++; await blocked; return args.schema.parse({ queries: [{ query: 'Blue Box S02', categories: [5000] }] }); } }) });
    const first = await service.start(config);
    expect((await service.start(config)).id).toBe(first.id);
    await expect(service.start({ ...config, requestId: 'launch-2' })).rejects.toThrow(/active/);
    service.cancel(first.id); release(); await service.settled();
    expect(service.get(first.id)?.status).toBe('cancelled');
    expect(calls).toBe(1);
    expect(JSON.stringify(service.list())).not.toContain('canary-secret');
    const restarted = new BenchmarkService({ root, datasets: [dataset], profiles: () => [] });
    expect(restarted.get(first.id)?.status).toBe('cancelled');
  } finally { release?.(); rmSync(root, { recursive: true, force: true }); }
});
it('requires disclosure and registered model choices before starting work', async () => {
  const root = mkdtempSync(join(tmpdir(), 'benchmark-validation-'));
  try {
    const service = new BenchmarkService({ root, datasets: [dataset], profiles: () => [] });
    await expect(service.start({ ...config, disclosureApproved: false })).rejects.toThrow();
    await expect(service.start(config)).rejects.toThrow(/profile/);
    expect(service.list()).toEqual([]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
it('reserves before real SDK transport and stops corrections at the global attempt ceiling', async () => {
  const root = mkdtempSync(join(tmpdir(), 'benchmark-bounded-'));
  const first = nock('http://benchmark-bounded.test').post('/chat/completions', body => body.max_tokens === 128 && body.provider.max_price.prompt === '1' && body.provider.max_price.request === '0').reply(200, { id: 'one', created: 1, object: 'chat.completion', model: 'test', system_fingerprint: null, choices: [{ index: 0, message: { role: 'assistant', content: 'bad' }, finish_reason: 'stop' }] });
  try {
    const service = new BenchmarkService({ root, datasets: [{ ...dataset, cases: [dataset.cases[0]!] }], profiles: () => [{ id: 'configured', label: 'Test', model: 'test', baseUrl: 'http://benchmark-bounded.test', apiKey: 'canary-secret' }], quote: async () => ({ contextTokens: 1000, promptPerMillion: 1, completionPerMillion: 1, request: 0, observedAt: '2026-01-01T00:00:00.000Z' }) });
    const run = await service.start({ ...config, maxAttempts: 1 });
    await service.settled();
    const final = service.get(run.id)!;
    expect(first.isDone()).toBe(true);
    expect(final.status).toBe('budget-exhausted');
    expect(final.attempts).toHaveLength(1);
    expect(final.attempts[0]!.cost).toBeNull();
    expect(final.attempts[0]!.failure).toBe('invalid-json');
    expect(final.stopReason).toBe('allowance');
  } finally { nock.cleanAll(); rmSync(root, { recursive: true, force: true }); }
});
it('persists malformed numeric proposals as rejected evidence and reaches a terminal state', async () => {
  const root = mkdtempSync(join(tmpdir(), 'benchmark-malformed-'));
  try {
    const service = new BenchmarkService({ root, datasets: [{ ...dataset, cases: [dataset.cases[8]!] }], profiles: () => [{ id: 'configured', label: 'Test', model: 'test', baseUrl: 'http://model.invalid', apiKey: 'canary' }], quote: async () => ({ contextTokens: 1000, promptPerMillion: 1, completionPerMillion: 1, request: 0, observedAt: '2026-01-01T00:00:00.000Z' }), llmFactory: () => ({ async json(args) { return args.schema.parse({ verdict: 'grab', releaseIndex: 1.5, reason: 'malformed reference' }); } }) });
    const run = await service.start({ ...config, tracks: ['pick-single'], split: 'all' });
    await service.settled();
    expect(service.get(run.id)?.status).toBe('completed');
    expect(service.get(run.id)?.results?.[0]?.validatorRejected).toBe(true);
    expect(service.get(run.id)?.results?.[0]?.unsafe).toBe(true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
it('requires explicit local call/token mode and never invents a zero local compute cost', async () => {
  const root = mkdtempSync(join(tmpdir(), 'benchmark-local-'));
  nock('http://127.0.0.1:9876').post('/v1/chat/completions').reply(200, { id: 'local', created: 1, object: 'chat.completion', model: 'test', system_fingerprint: null, choices: [{ index: 0, message: { role: 'assistant', content: '{"queries":[{"query":"Blue Box S02","categories":[5000]}]}' }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30, cost: 0 } });
  try {
    const service = new BenchmarkService({ root, datasets: [{ ...dataset, cases: [dataset.cases[0]!] }], profiles: () => [{ id: 'configured', label: 'Local', model: 'test', baseUrl: 'http://127.0.0.1:9876/v1', apiKey: 'local', local: { contextTokens: 2048, structuredOutput: true, seedSupported: false } }] });
    await expect(service.start(config)).rejects.toThrow(/spend policy/);
    const run = await service.start({ ...config, spendPolicy: 'local-call-token' });
    await service.settled();
    expect(service.get(run.id)?.status).toBe('completed');
    expect(service.get(run.id)?.attempts[0]?.cost).toBeNull();
    expect(service.get(run.id)?.priceBound?.accounting).toBe('local-unknown');
  } finally { nock.cleanAll(); rmSync(root, { recursive: true, force: true }); }
});
it.each([1, 3])('persists validated grouped attribution for %i supplied episodes', async count => {
  const root = mkdtempSync(join(tmpdir(), 'benchmark-group-persist-'));
  const input = dataset.cases[0]!;
  const sample = { ...input, input: { ...input.input, episodes: input.input.episodes.slice(0, count) }, candidates: [], queries: [], label: { ...input.label, acceptableCandidateIds: [], coveredEpisodeNumbers: input.input.episodes.slice(0, count).map(e => e.episodeNumber) } };
  const query = { query: count === 1 ? 'Blue Box S02E01' : 'Blue Box S02', categories: [5000], targetIndices: [0], ...(count === 1 ? { episodeTargets: [{ targetIndex: 0, episodeIndices: [0] }] } : {}) };
  try {
    const service = new BenchmarkService({ root, datasets: [{ ...dataset, cases: [sample] }], profiles: () => [{ id: 'configured', label: 'Test', model: 'test', baseUrl: 'http://model.invalid', apiKey: 'canary' }], quote: async () => ({ contextTokens: 1000, promptPerMillion: 1, completionPerMillion: 1, request: 0, observedAt: '2026-01-01T00:00:00.000Z' }), llmFactory: () => ({ async json(args) { return args.schema.parse({ queries: [query] }); } }) });
    const run = await service.start({ ...config, tracks: ['plan-group'], split: 'all' });
    await service.settled();
    const final = service.get(run.id)!;
    expect(final.status).toBe('completed');
    expect(final.results?.[0]?.status).toBe('correct');
    expect(final.results?.[0]?.queries).toEqual([query]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
it('persists all six real decision paths including a supported replay through the service', async () => {
  const root = mkdtempSync(join(tmpdir(), 'benchmark-six-tracks-'));
  try {
    const service = new BenchmarkService({ root, datasets: [{ ...dataset, cases: [dataset.cases[0]!] }], profiles: () => [{ id: 'configured', label: 'Test', model: 'test', baseUrl: 'http://model.invalid', apiKey: 'canary' }], quote: async () => ({ contextTokens: 1000, promptPerMillion: 1, completionPerMillion: 1, request: 0, observedAt: '2026-01-01T00:00:00.000Z' }), llmFactory: () => ({ async json(args) {
      if (args.label.startsWith('planner:')) return args.schema.parse({ queries: [{ query: 'Blue Box', categories: [5000, 6000], ...(args.label.startsWith('planner:group:') ? { targetIndices: [0] } : {}) }] });
      if (args.label.startsWith('picker:group:')) return args.schema.parse({ selection: { verdict: 'grab', releaseIndices: [0], manualTargetIndices: [], deferredTargetIndices: [], reason: 'acceptable' } });
      if (args.label.startsWith('picker:')) return args.schema.parse({ verdict: 'grab', releaseIndex: 0, reason: 'acceptable' });
      return args.schema.parse({ decisions: [{ queueIndex: 0, outcome: 'matched', mediaIndices: [0], targetIndices: [0], reason: 'synthetic match' }] });
    } }) });
    const run = await service.start({ ...config, tracks: ['plan-single', 'plan-group', 'pick-single', 'pick-group', 'association', 'replay'], split: 'all' });
    await service.settled();
    const final = service.get(run.id)!;
    expect(final.status).toBe('completed');
    expect(final.results?.map(r => [r.track, r.status])).toEqual([['plan-single', 'correct'], ['plan-group', 'correct'], ['pick-single', 'correct'], ['pick-group', 'correct'], ['association', 'correct'], ['replay', 'correct']]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
