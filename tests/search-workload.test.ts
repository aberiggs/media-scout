import { describe, expect, it } from 'vitest';
import { buildAutomationPrompt } from '../src/search/workload';
import type { ArrTarget } from '../src/search/arr';

const target = (episode: number, details: Record<string, unknown> = {}): ArrTarget => ({
  key: `internal-key:${episode}`, provider: 'sonarr', sourceFingerprint: 'internal-source', serviceId: 7, externalId: 77,
  episodeId: episode, monitored: true, hasFile: false, eligible: true, available: true,
  airAt: Date.parse('2025-01-02') + episode,
  showContext: { title: 'The Show', titles: ['The Show', 'Alias'], overview: 'Internal synopsis', externalIds: { tvdb: 77 } },
  context: { seasonNumber: 3, episodeNumber: episode, ...details },
});
const base = { preferences: '', secrets: [] };
describe('scheduled prompt workload', () => {
  it('selects oldest due episodes first, caps the workload and rejects mixed shows', () => {
    const targets = Array.from({ length: 201 }, (_, i) => target(i + 1)).reverse();
    const result = buildAutomationPrompt({ ...base, targets });
    expect(result.selectedTargets.map(item => item.episodeId)).toEqual(Array.from({ length: 200 }, (_, i) => i + 1));
    expect(result.deferredTargets).toBe(1);
    expect(result.prompt).not.toMatch(/"episode":201\b|Internal synopsis|internal-key|internal-source|tvdb/);
    expect(() => buildAutomationPrompt({ ...base, targets: [target(1), { ...target(2), serviceId: 8 }] })).toThrow(/one observed/);
  });

  it('budgets the final UTF-8 prompt, keeps rows whole and rotates deferred work by attempt priority', () => {
    const a = target(1, { episodeTitle: '星'.repeat(150) });
    const b = target(2, { episodeTitle: '月'.repeat(150) });
    const targets = [a, b];
    const preferences = 'Prefer English subs\nPrefer the uncensored release';
    const setup = { ...base, targets, preferences, maxBytes: 1450 };
    const first = buildAutomationPrompt(setup);
    const next = buildAutomationPrompt({ ...setup, prioritize: (left, right) => Number(left === a) - Number(right === a) });
    expect(first.selectedTargets).toEqual([a]);
    expect(next.selectedTargets).toEqual([b]);
    expect(next.deferredTargets).toBe(1);
    expect(next.prompt).toContain(JSON.stringify({ season: 3, episode: 2, title: '月'.repeat(150) }));
    expect(next.prompt).toContain(preferences);
    expect(Buffer.byteLength(next.prompt)).toBeLessThanOrEqual(setup.maxBytes);
    expect(() => buildAutomationPrompt({ ...setup, maxBytes: 100 })).toThrow(/cannot fit/);
  });

  it('keeps meaningful daily air dates and escapes metadata while scrubbing secrets', () => {
    const episode = target(1, { episodeTitle: 'A "quoted" name with private-key', absoluteEpisodeNumber: 0, airDate: '2025-01-01' });
    episode.showContext = { ...episode.showContext, seriesType: 'daily' };
    const result = buildAutomationPrompt({ ...base, targets: [episode], secrets: ['private-key'] });
    expect(result.prompt).toContain('{"season":3,"episode":1,"title":"A \\"quoted\\" name with [redacted]","airDate":"2025-01-01"}');
    expect(result.prompt).not.toContain('private-key');
  });
});
