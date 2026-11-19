import { describe, expect, it } from 'vitest';
import { coverageReport, finalizationSchema, inputFromArtifact, inputHash, safeTelemetry } from '../scripts/compare-anime-models';

const fixture = (user: unknown = { request: { prompt: 'find', context: { scope: { type: 'episode-set' }, targets: [{ targetId: 't1' }] } }, candidates: [{ candidateId: 'c1', observations: [{ title: 'Observed', tvdbId: null, tmdbId: null }] }] }) =>
  ({ decisions: [{ input: { system: 'older', user: {} } }, { input: { system: 'last', user }, error: { message: 'failed final call' } }] });

describe('bounded anime model comparison helpers', () => {
  it('uses the last decision input even when that historical call failed', () => {
    expect(inputFromArtifact(fixture())).toMatchObject({ system: 'last' });
  });
  it('hashes the exact frozen input deterministically', () => {
    const x = { system: 's', user: { b: 2, a: 1 } };
    expect(inputHash(x)).toBe(inputHash(x));
    expect(inputHash(x)).toMatch(/^[a-f0-9]{64}$/);
    expect(inputHash({ ...x, system: 'different' })).not.toBe(inputHash(x));
    expect(inputHash({ ...x, user: { b: 2, a: 3 } })).not.toBe(inputHash(x));
  });
  it('requires exactly one final plan and rejects two alternatives', () => {
    const base = { action: 'finish', query: null, categories: null, indexerIds: null, status: 'matched', message: null, options: [{ optionId: 'o', rank: 1, releases: [{ candidateId: 'c1', coveredTargetIds: ['t1'], coverageReason: 'evidence', uncertainty: 'uncertain' }], reason: 'best', uncertainty: 'uncertain' }] };
    expect(finalizationSchema.parse(base).options).toHaveLength(1);
    expect(() => finalizationSchema.parse({ ...base, options: [...base.options, ...base.options] })).toThrow();
  });
  it('accepts production-bound long concise rationales but rejects an empty plan reason', () => {
    const base = { action:'finish',query:null,categories:null,indexerIds:null,status:'matched',message:'m'.repeat(2000),options:[{optionId:'o',rank:1,releases:[{candidateId:'c1',coveredTargetIds:['t1'],coverageReason:'c'.repeat(1000),uncertainty:'u'.repeat(1000)}],reason:'r'.repeat(2000),uncertainty:'p'.repeat(2000)}] };
    expect(finalizationSchema.parse(base).options?.[0]?.reason).toHaveLength(2000);
    expect(() => finalizationSchema.parse({...base,options:[{...base.options[0],reason:''}]})).toThrow();
  });
  it('preserves the production contract allowing empty uncertainty fields', () => {
    const value = { action:'finish',query:null,categories:null,indexerIds:null,status:'matched',message:null,options:[
      {optionId:'o',rank:1,releases:[{candidateId:'c1',coveredTargetIds:['t1'],coverageReason:'observed',uncertainty:''}],reason:'best',uncertainty:''},
    ] };
    expect(finalizationSchema.parse(value).options?.[0]?.uncertainty).toBe('');
  });
  it('validates references against observed candidates and targets, then reports mapped coverage', () => {
    const user = (fixture() as any).decisions[1].input.user;
    const options = finalizationSchema.parse({ action:'finish',query:null,categories:null,indexerIds:null,status:'matched',message:null,options:[{ optionId:'o',rank:1,releases:[{candidateId:'c1',coveredTargetIds:['t1'],coverageReason:'observed',uncertainty:'uncertain'}],reason:'best',uncertainty:'uncertain'}] }).options!;
    const report = coverageReport(user, options);
    expect(report.valid).toBe(true);
    expect(report.selected[0]).toMatchObject({ candidateId: 'c1', titles: ['Observed'], coveredTargetIds: ['t1'] });
    expect(coverageReport(user, [{ ...options[0]!, releases: [{ ...options[0]!.releases[0]!, candidateId: 'future' }] }]).valid).toBe(false);
    expect(coverageReport(user, [{ ...options[0]!, releases: [{ ...options[0]!.releases[0]!, coveredTargetIds: ['future'] }] }]).valid).toBe(false);
  });
  it('honors assigned-target exclusions without treating the legacy blanket flag as authoritative', () => {
    const user = { request: { prompt:'x', context:{ scope:{type:'episode-set'},targets:[{targetId:'a'},{targetId:'b'}] } }, candidates:[
      {candidateId:'held',excluded:true,excludedTargetIds:[],observations:[{title:'Held'}]},
      {candidateId:'usable',excluded:true,excludedTargetIds:['a'],observations:[{title:'Usable'}]},
    ] };
    const plan = [{ optionId:'o',rank:1 as const,reason:'best',uncertainty:'uncertain',releases:[{candidateId:'usable',coveredTargetIds:['b'],coverageReason:'observed',uncertainty:'uncertain'}]}];
    expect(coverageReport(user, plan).valid).toBe(true);
    expect(coverageReport(user, [{...plan[0]!,releases:[{candidateId:'usable',coveredTargetIds:['a'],coverageReason:'excluded target',uncertainty:'uncertain'}]}]).valid).toBe(false);
  });
  it('redacts credential-like fields while retaining token count telemetry and null unknowns', () => {
    expect(safeTelemetry({ apiKey: 'secret', reasoning: 'private', usage: { promptTokens: 20, completionTokens: null, cost: undefined } }))
      .toEqual({ usage: { promptTokens: 20, completionTokens: null, reasoningTokens: null, cachedTokens: null, totalTokens: null, cost: null } });
  });
  it('reads reasoning and cache counts from the actual SDK nested usage shape', () => {
    expect(safeTelemetry({ usage: { promptTokens: 40, completionTokens: 30, totalTokens: 70, cost: 0,
      completionTokensDetails: { reasoningTokens: 20 }, promptTokensDetails: { cachedTokens: 10 },
      reasoning: 'must not be retained', apiKey: 'secret' } })).toEqual({
      usage: { promptTokens: 40, completionTokens: 30, reasoningTokens: 20, cachedTokens: 10, totalTokens: 70, cost: 0 },
    });
  });
});
