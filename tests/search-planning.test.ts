import { describe, expect, it } from 'vitest';
import { compileSearchPlan, hasMeaningfulClarification } from '../src/core/search-planning';

function plan(query: string, overrides: Record<string, unknown> = {}): any {
  return {
    mode: 'search', question: '',
    searchSpace: { focus: 'unique-title', identityAnchors: ['Spider-Man 2 (2004)'], medium: { value: 'film', provenance: 'explicit' }, positives: [], negatives: [], expansionScope: 'identity-preserving' },
    proposals: [{ query, purpose: 'Find the named film', branch: 'title', strategy: 'identity-preserving', preserves: ['Spider Man 2 (2004)'] }],
    ...overrides,
  };
}

describe('search plan compilation', () => {
  it('preserves literal title/year and meaningful Unicode punctuation', () => {
    expect(compileSearchPlan(plan('Spider-Man 2 (2004), the film')).proposals[0]?.query).toBe('Spider-Man 2 (2004), the film');
    const named = plan('Amélie: Le Fabuleux Destin');
    named.searchSpace.identityAnchors = ['Amélie: Le Fabuleux Destin'];
    (named.proposals[0] as { preserves: string[] }).preserves = ['Amélie: Le Fabuleux Destin'];
    expect(compileSearchPlan(named).proposals[0]?.query).toBe('Amélie: Le Fabuleux Destin');
  });
  it('deduplicates normalized whitespace and case while preserving the first query', () => {
    const raw = plan('Spider-Man 2 (2004)');
    (raw.proposals as unknown[]).push({ query: ' spider-man   2 (2004) ', purpose: 'duplicate', branch: 'title', strategy: 'identity-preserving', preserves: ['Spider-Man 2 (2004)'] });
    expect(compileSearchPlan(raw).proposals).toHaveLength(1);
  });
  it('preserves entity anchors across spelling variants and rejects generic substitutions', () => {
    const raw = plan('Spider-Man films');
    raw.searchSpace.identityAnchors = ['Spider-Man'];
    (raw.proposals[0] as { preserves: string[] }).preserves = ['Spider Man'];
    expect(compileSearchPlan(raw).proposals[0]?.query).toBe('Spider-Man films');
    (raw.proposals[0] as { preserves: string[] }).preserves = ['superhero films'];
    expect(() => compileSearchPlan(raw)).toThrow();
  });
  it('accepts joined, hyphenated, and spaced whole-name variants without substring matches', () => {
    for (const [anchor, preserved, query] of [
      ['Spider-Man', 'spiderman', 'spiderman films'],
      ['spiderman', 'Spider Man', 'Spider-Man films'],
      ['Spider Man', 'Spider-Man', 'Spiderman films'],
    ] as const) {
      const raw=plan(query);raw.searchSpace.identityAnchors=[anchor];
      (raw.proposals[0] as {preserves:string[]}).preserves=[preserved];
      expect(compileSearchPlan(raw).proposals[0]?.query).toBe(query);
    }
    const up=plan('Jupiter films');up.searchSpace.identityAnchors=['Up'];
    (up.proposals[0] as {preserves:string[]}).preserves=['Up'];
    expect(()=>compileSearchPlan(up)).toThrow();
    const generic=plan('superhero films');generic.searchSpace.identityAnchors=['Spider-Man'];
    (generic.proposals[0] as {preserves:string[]}).preserves=['superhero'];
    expect(()=>compileSearchPlan(generic)).toThrow();
  });
  it('matches identity on token boundaries and checks anchors in mixed focus too', () => {
    const raw = plan('Jupiter videogames');
    raw.searchSpace = { ...raw.searchSpace, focus: 'mixed', identityAnchors: ['Up'] };
    (raw.proposals[0] as { preserves: string[] }).preserves = ['Up'];
    expect(() => compileSearchPlan(raw)).toThrow();
    (raw.proposals[0] as { query: string; preserves: string[] }).query = 'Up videogames';
    expect(compileSearchPlan(raw).proposals[0]?.query).toBe('Up videogames');
  });
  it('rejects malformed mode, empty query, multiline/prose and URLs', () => {
    expect(() => compileSearchPlan(plan(''))).toThrow();
    expect(() => compileSearchPlan(plan('sports games\nwhy this works'))).toThrow();
    expect(() => compileSearchPlan(plan('https://indexer.invalid/search'))).toThrow();
    expect(() => compileSearchPlan({ ...plan('term'), mode: 'clarify' })).toThrow();
  });
  it('limits exploratory terms but allows longer identity-preserving terms', () => {
    expect(() => compileSearchPlan(plan('x'.repeat(81), { searchSpace: { ...plan('x').searchSpace, focus: 'category', identityAnchors: [], expansionScope: 'subcategories' }, proposals: [{ ...plan('x').proposals[0], query: 'x'.repeat(81), strategy: 'subcategory' }] }))).toThrow();
    const exact = plan('x'.repeat(120), { searchSpace: { ...plan('x').searchSpace, identityAnchors: ['x'.repeat(120)] }, proposals: [{ ...plan('x').proposals[0], query: 'x'.repeat(120), preserves: ['x'.repeat(120)] }] });
    expect(compileSearchPlan(exact).proposals[0]?.query).toHaveLength(120);
    const spoof = plan('a'.repeat(81), { searchSpace: { ...plan('x').searchSpace, focus: 'category', identityAnchors: [] }, proposals: [{ ...plan('x').proposals[0], query: 'a'.repeat(81), strategy: 'identity-preserving', preserves: [] }] });
    expect(() => compileSearchPlan(spoof)).toThrow();
  });
  it('requires meaningful clarification without proposals', () => {
    const clarify = { ...plan('x'), mode: 'clarify', proposals: [], question: 'Which season do you mean?' };
    expect(compileSearchPlan(clarify).question).toContain('season');
    expect(() => compileSearchPlan({ ...clarify, question: ' ' })).toThrow();
  });
  it('retains multidimensional intent, medium provenance, and hard/soft negative constraints', () => {
    const value = plan('basketball videogames');
    value.searchSpace = { focus: 'mixed', identityAnchors: [], medium: { value: 'videogame', provenance: 'context' }, positives: [{ text: 'Basketball', strength: 'soft' }, { text: 'cooperative play', strength: 'soft' }], negatives: [{ text: 'real match recordings', strength: 'hard' }], expansionScope: 'subcategories' };
    (value.proposals as unknown[]).push({ query: 'soccer videogames', purpose: 'Cover another sport category', branch: 'soccer games', strategy: 'subcategory', preserves: [] });
    const compiled = compileSearchPlan(value);
    expect(compiled.searchSpace.medium.provenance).toBe('context');
    expect(compiled.searchSpace.negatives[0]).toEqual({ text: 'real match recordings', strength: 'hard' });
    expect(compiled.proposals.map((item) => item.branch)).toEqual(['title', 'soccer games']);
  });
  it('rejects query text contaminated with rationale rather than a short public purpose field', () => {
    const category=plan('basketball videogames because they cover the topic');
    category.searchSpace={...category.searchSpace,focus:'category',identityAnchors:[]};
    category.proposals[0].strategy='subcategory';category.proposals[0].preserves=[];
    expect(() => compileSearchPlan(category)).toThrow();
    expect(() => compileSearchPlan(plan('sports games where to play'))).toThrow();
    const title = plan('Because of Winn-Dixie');
    title.searchSpace.identityAnchors = ['Because of Winn-Dixie'];
    (title.proposals[0] as { preserves: string[] }).preserves = ['Because of Winn-Dixie'];
    expect(compileSearchPlan(title).proposals[0]?.query).toBe('Because of Winn-Dixie');
  });
  it('does not treat redaction-only clarification text as meaningful',()=>{expect(hasMeaningfulClarification('[removed]')).toBe(false);expect(hasMeaningfulClarification('Which season? [removed]')).toBe(true);expect(hasMeaningfulClarification('\u0000\u001f')).toBe(false);});
});
