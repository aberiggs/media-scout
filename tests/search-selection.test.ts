import { describe, expect, it } from 'vitest';
import { validateRankedOptions } from '../src/search/selection';
import { parseReleaseCoverage } from '../src/core/parser';

describe('ranked option evidence validation', () => {
  it('rejects fabricated candidates and overlapping target plans', () => {
    const base = { rank: 1, releases: [{ candidateId: 'x' }], coveredTargetIds: ['e1'], reason: 'fit', uncertainty: '' };
    expect(validateRankedOptions([{ ...base, optionId: 'o1' }], new Set(['c1']), new Set(['e1']), { type: 'season' })).toMatchObject({ valid: false });
    expect(validateRankedOptions([{ ...base, optionId: 'o1', releases: [{ candidateId: 'c1' }] }, { ...base, optionId: 'o2', rank: 2, releases: [{ candidateId: 'c1' }] }], new Set(['c1']), new Set(['e1']), { type: 'season' })).toMatchObject({ valid: true });
  });
  it('rejects explicit wrong season and allows at most three non-overlapping season releases', () => {
    const options = [{ optionId: 'o', rank: 1, releases: [{ candidateId: 'c1' }], coveredTargetIds: ['e2'], reason: 'fit', uncertainty: '' }];
    expect(validateRankedOptions(options, new Set(['c1']), new Set(['e1']), { type: 'season', seasonNumber: 2, candidateSeasons: { c1: [1] } }).valid).toBe(false);
  });
  it.each([
    ['seasonal numbering', 'Example S02E01 1080p', 26, true],
    ['absolute numbering', '[Group] Example - 26 MULTI 1080p', 26, true],
    ['missing absolute metadata', '[Group] Example - 26', undefined, true],
    ['split cour supplied mapping', '[Group] Alternate - 13', 13, true],
    ['unknown language', 'Example S02E01 1080p', 26, true],
    ['wrong explicit season', 'Example S01E01 MULTI', 26, false],
    ['wrong absolute number', 'Example - 27', 26, false],
  ])('guards scope without inventing metadata: %s', (_label, title, absoluteEpisodeNumber, expected) => {
    const result = validateRankedOptions([{ optionId: 'one', rank: 1, releases: [{ candidateId: 'c' }], coveredTargetIds: ['target'], reason: 'Evidence supplied', uncertainty: 'Contents unverified' }], new Set(['c']), new Set(['target']), { type: 'episode', seasonNumber: 2, episodeNumber: 1, absoluteEpisodeNumber: absoluteEpisodeNumber as number | undefined, candidateScopes: { c: [parseReleaseCoverage(title as string)] } });
    expect(result.valid).toBe(expected);
  });
  it('allows an evidenced same-season pack for an episode and rejects a wrong-season pack', () => {
    const option = { optionId: 'pack', rank: 1, releases: [{ candidateId: 'pack' }], coveredTargetIds: ['target'], reason: 'S02 pack covers requested episode', uncertainty: 'Completeness not independently verified' };
    const check = (title: string) => validateRankedOptions([option], new Set(['pack']), new Set(['target']), { type: 'episode', seasonNumber: 2, episodeNumber: 3, candidateScopes: { pack: [parseReleaseCoverage(title)] } });
    expect(check('Example S02 1080p').valid).toBe(true);
    expect(check('Example S01 1080p').valid).toBe(false);
  });
  it('accepts partial inferred season coverage but rejects overlapping physical plans', () => {
    const option = { optionId: 'one', rank: 1, releases: [{ candidateId: 'a' }], coveredTargetIds: ['e1'], reason: 'Inferred pack', uncertainty: 'May be incomplete' };
    expect(validateRankedOptions([option], new Set(['a']), new Set(['e1', 'e2']), { type: 'season', seasonNumber: 2, candidateScopes: { a: [parseReleaseCoverage('Example S02')] } }).valid).toBe(true);
    const combined = { ...option, releases: [{ candidateId: 'a' }, { candidateId: 'b' }] };
    expect(validateRankedOptions([combined], new Set(['a', 'b']), new Set(['e1']), { type: 'season', seasonNumber: 2, candidateScopes: { a: [parseReleaseCoverage('Example S02E01')], b: [parseReleaseCoverage('Example S02E01-E02')] } }).valid).toBe(false);
    expect(validateRankedOptions([combined], new Set(['a', 'b']), new Set(['e1']), { type: 'season', seasonNumber: 2, candidateScopes: { a: [parseReleaseCoverage('Example S02E01')], b: [parseReleaseCoverage('Example S02E02')] } }).valid).toBe(true);
  });
  it('does not let ambiguous bare numbers override explicit seasonal numbering', () => {
    const option = { optionId: 'one', rank: 1, releases: [{ candidateId: 'a' }], coveredTargetIds: [], reason: 'S02E01 is explicit', uncertainty: '' };
    expect(validateRankedOptions([option], new Set(['a']), new Set(), { type: 'episode', seasonNumber: 2, episodeNumber: 1, absoluteEpisodeNumber: 26, candidateScopes: { a: [parseReleaseCoverage('Example S02E01 1 264')] } }).valid).toBe(true);
  });
  it('uses a valid same-release observation without treating an unparseable alias as a contradiction', () => {
    const option = { optionId: 'one', rank: 1, releases: [{ candidateId: 'a' }], coveredTargetIds: [], reason: 'Explicit evidence', uncertainty: 'One alias is unparseable' };
    const context = { type: 'episode', seasonNumber: 2, episodeNumber: 1, candidateScopes: { a: [parseReleaseCoverage('Example S02E01'), { kind: 'invalid' as const }] } };
    expect(validateRankedOptions([option], new Set(['a']), new Set(), context).valid).toBe(true);
    context.candidateScopes.a.push(parseReleaseCoverage('Example S01E01'));
    expect(validateRankedOptions([option], new Set(['a']), new Set(), context).valid).toBe(false);
  });
  it('validates episode-set assignments by requested target, not parsed season overlap', () => {
    const option = { optionId: 'plan', rank: 1, releases: [
      { candidateId: 'pack', coveredTargetIds: ['e1', 'e2'], coverageReason: 'Alternate numbering aligns', uncertainty: 'Inferred' },
      { candidateId: 'single', coveredTargetIds: ['e3'], coverageReason: 'Title matches', uncertainty: '' },
    ], reason: 'Useful partial plan', uncertainty: '' };
    expect(validateRankedOptions([option], new Set(['pack', 'single']), new Set(['e1', 'e2', 'e3', 'e4']), { type: 'episode-set' }).valid).toBe(true);
    expect(validateRankedOptions([{ ...option, releases: [option.releases[0], { ...option.releases[1], coveredTargetIds: ['e2'] }] }], new Set(['pack', 'single']), new Set(['e1', 'e2', 'e3']), { type: 'episode-set' })).toMatchObject({ valid: false, error: 'duplicate target assignment' });
  });
});
