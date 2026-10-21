import { describe, expect, it } from 'vitest';
import { evaluateBenchmarkCase } from '../src/benchmarks/evaluate';
import type { DatasetCaseSchema } from '../src/benchmarks/contracts';
import type { LLMClient } from '../src/clients/llm';

const c = {
  id: 'x', partition: 'development', input: { kind: 'tv', title: 'Show', altTitles: [], externalId: 'tvdb:1', year: null, seasonNumber: 1, episodes: [{ episodeNumber: 1, absoluteEpisodeNumber: null, title: 'Pilot' }] },
  candidates: [{ id: 'a', title: 'Show S01E01 1080p', downloadPresent: true, magnetPresent: false, size: 100, seeders: 10, leechers: 0, grabs: 1, age: 1, externalIds: [], protocol: 'torrent', categories: [5070], source: 'ix', review: { identity: 'compatible', coveredEpisodeNumbers: [1], coverageBasis: 'explicit', selection: 'acceptable', reason: 'reviewed' } }],
  queries: [{ query: 'Show S01', categories: [5070], indexers: ['ix'], limit: 10, candidateIds: ['a'], availability: 'success', completeness: 'upstream-completeness-unknown' }],
  label: { identity: 'compatible', coveredEpisodeNumbers: [1], coverageBasis: 'explicit', selection: 'acceptable', acceptableCandidateIds: ['a'], reason: 'reviewed' },
} as import('zod').infer<typeof DatasetCaseSchema>;
const llm: LLMClient = { async json<T>(args: { schema: import('zod').ZodType<T> }) { return args.schema.parse({ verdict: 'grab', releaseIndex: 0, reason: 'best' }); } };

describe('benchmark evaluation', () => {
  it('reports an unrecorded planner query as unsupported instead of treating it as an empty retrieval', async () => {
    const planner: LLMClient = { async json<T>(args: { schema: import('zod').ZodType<T> }) { return args.schema.parse([{ query: 'Show S01 complete', categories: [5070] }]); } };
    const result = await evaluateBenchmarkCase(c, 'replay', planner);
    expect(result.status).toBe('unsupported-retrieval');
    expect(result.unsupportedQueryCount).toBe(1);
    expect(result.selectedIds).toEqual([]);
  });

  it('credits a valid acceptable candidate through the production single picker', async () => {
    const result = await evaluateBenchmarkCase(c, 'pick-single', llm);
    expect(result.status).toBe('correct');
    expect(result.selectedIds).toEqual(['a']);
  });
  it('exercises grouped planner attribution rather than the single planner schema', async () => {
    const group: LLMClient = { async json(args) { return args.schema.parse({ queries: [{ query: 'Show S01', categories: [5070], targetIndices: [0] }] }); } };
    expect((await evaluateBenchmarkCase(c, 'plan-group', group)).status).toBe('correct');
  });
  it('retains unsafe fabricated references even when the production validator rejects them', async () => {
    const bad: LLMClient = { async json(args) { return args.schema.parse({ verdict: 'grab', releaseIndex: 99, reason: 'fabricated' }); } };
    const out = await evaluateBenchmarkCase(c, 'pick-single', bad);
    expect(out.validatorRejected).toBe(true);
    expect(out.unsafe).toBe(true);
    expect(out.rawIndices).toEqual([99]);
  });
  it('exercises group selection validation and blocks overlapping choices', async () => {
    const group: LLMClient = { async json(args) { return args.schema.parse({ selection: { verdict: 'grab', releaseIndices: [0, 0], manualTargetIndices: [], deferredTargetIndices: [], reason: 'duplicate' } }); } };
    const out = await evaluateBenchmarkCase(c, 'pick-group', group);
    expect(out.validatorRejected).toBe(true);
    expect(out.unsafe).toBe(true);
  });
  it('exercises real association references on mixed-provenance synthetic queue context', async () => {
    const association: LLMClient = { async json(args) { return args.schema.parse({ decisions: [{ queueIndex: 0, outcome: 'matched', mediaIndices: [0], targetIndices: [0], reason: 'match' }] }); } };
    expect((await evaluateBenchmarkCase(c, 'association', association)).status).toBe('correct');
  });
  it('does not let a supported query see candidates returned only by another query', async () => {
    const sample = { ...c, queries: [{ ...c.queries[0]!, candidateIds: [] }] };
    const planner: LLMClient = { async json(args) { return args.schema.parse({ queries: [{ query: 'Show S01', categories: [5070] }] }); } };
    const out = await evaluateBenchmarkCase(sample, 'replay', planner);
    expect(out.retrievedIds).toEqual([]);
    expect(out.status).toBe('justified-abstention');
    expect(out.poolRecall).toBe(0);
  });
  it.each(['NotShow S01', 'Show S01E999', 'Show 2099'])('flags fabricated planner identity/scope: %s', async query => {
    const planner: LLMClient = { async json(args) { return args.schema.parse({ queries: [{ query, categories: [5070] }] }); } };
    expect((await evaluateBenchmarkCase(c, 'plan-single', planner)).unsafe).toBe(true);
  });
  it('preserves captured order through replay before stable seeder ties', async () => {
    const sample = { ...c, candidates: [c.candidates[0]!, { ...c.candidates[0]!, id: 'b' }], queries: [{ ...c.queries[0]!, candidateIds: ['b', 'a'] }], label: { ...c.label, acceptableCandidateIds: ['a', 'b'] } };
    const llm: LLMClient = { async json(args) { return args.schema.parse(args.label.startsWith('planner:') ? { queries: [{ query: 'Show S01', categories: [5070] }] } : { verdict: 'grab', releaseIndex: 0, reason: 'first' }); } };
    const out = await evaluateBenchmarkCase(sample, 'replay', llm);
    expect(out.retrievedIds).toEqual(['b', 'a']);
    expect(out.selectedIds).toEqual(['b']);
  });
});
