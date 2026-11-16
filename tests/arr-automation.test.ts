import { describe, expect, it, vi } from 'vitest';
import { ArrAutomation } from '../src/search/automation';
import { ArrObserver } from '../src/search/arr';
import { openSearchStore } from '../src/search/store';
import type { SonarrClient } from '../src/clients/sonarr';
import type { ArrTarget, ArrSnapshot } from '../src/search/arr';
import type { SearchRequest } from '../src/search/contracts';
import type { SearchResult } from '../src/search/service';

const makeTarget = (key: string, episodeNumber: number, eligible = true): ArrTarget => ({ key, provider: 'sonarr', sourceFingerprint: 'fp', serviceId: 1, externalId: 20, episodeId: episodeNumber, monitored: true, hasFile: false, available: true, airAt: episodeNumber, eligible, context: { title: 'Show', titles: ['Show', 'Alias'], seasonNumber: 2, episodeNumber, absoluteEpisodeNumber: 24 + episodeNumber, episodeTitle: 'Pilot' } });
const result = (status: SearchResult['status'] = 'matched'): SearchResult => ({ searchId: 's', status, options: status === 'matched' ? [{ optionId: 'rank1', rank: 1, releases: [{ candidateId: 'c' }], coveredTargetIds: [], reason: 'match', uncertainty: '' }] : [], candidates: [], counts: { decisions: 1, searches: 1, candidates: 1 }, events: [], promptVersion: 'v1' });

describe('ArrAutomation', () => {
  it('uses the configured search-only retry for no-match', async () => {
    const clock = Date.parse('2026-01-01'), target = makeTarget('no-match', 1), store = openSearchStore(':memory:');
    const observer: any = { observe: async () => ({ observedAt: clock, sonarr: { known: true }, radarr: { known: false }, targets: [target] }) };
    try {
      const pass = await new ArrAutomation({ store, observer, search: { run: async () => result('no-match') }, submission: { submit: vi.fn() }, getPolicy: () => ({ enabled: true, dryRun: false, searchRetryMinutes: 30 }), clock: () => clock }).runPass();
      expect(pass.nextAttemptAt).toBe(clock + 30 * 60_000);
      expect(store.getAutomationAttempt(target.key)?.failCount).toBe(0);
    } finally { store.close(); }
  });
  it('caps repeated operational failures without creating a permanent hold', async () => {
    let clock = Date.parse('2026-01-01'); const target = makeTarget('failure', 1), store = openSearchStore(':memory:');
    const observer: any = { observe: async () => ({ observedAt: clock, sonarr: { known: true }, radarr: { known: false }, targets: [target] }) };
    try {
      const automation = new ArrAutomation({ store, observer, search: { run: async () => result('failed') }, submission: { submit: vi.fn() }, getPolicy: () => ({ enabled: true, dryRun: false }), clock: () => clock });
      let pass: any, fifthAttemptAt = 0;
      for (let i = 0; i < 5; i++) { fifthAttemptAt = clock; pass = await automation.runPass(); clock = pass.nextAttemptAt; }
      expect(pass.nextAttemptAt - fifthAttemptAt).toBe(60 * 60_000);
      expect(store.getAutomationAttempt(target.key)).toMatchObject({ failCount: 5, deadline: clock });
      expect(store.getDeadline(target.key)).toBe(clock);
    } finally { store.close(); }
  });
  it('does not search through an active provider deadline', async () => {
    const clock = Date.parse('2026-01-01'), target = makeTarget('throttled', 1), store = openSearchStore(':memory:'), search = { run: vi.fn(async () => result()) };
    const observer: any = { observe: async () => ({ observedAt: clock, sonarr: { known: true }, radarr: { known: false }, targets: [target] }) };
    try {
      store.setProviderDeadline('prowlarr', clock + 60_000);
      const pass = await new ArrAutomation({ store, observer, search, submission: { submit: vi.fn() }, getPolicy: () => ({ enabled: true, dryRun: false }), clock: () => clock }).runPass();
      expect(pass.reason).toBe('nothing-due'); expect(search.run).not.toHaveBeenCalled();
    } finally { store.close(); }
  });
  it('defers automation when the shared search pool is full without recording a target failure', async () => {
    const clock = Date.parse('2026-01-01'), target = makeTarget('pool-full', 1), store = openSearchStore(':memory:');
    const observer: any = { observe: async () => ({ observedAt: clock, sonarr: { known: true }, radarr: { known: false }, targets: [target] }) };
    try {
      const pass = await new ArrAutomation({ store, observer, search: { run: async () => { throw new Error('automation-capacity-deferred'); } }, submission: { submit: vi.fn() }, getPolicy: () => ({ enabled: true, dryRun: false }), clock: () => clock }).runPass();
      expect(pass).toMatchObject({ ran: false, reason: 'search-capacity' });
      expect(store.getAutomationAttempt(target.key)).toBeNull();
      expect(store.getDeadline(target.key)).toBe(0);
    } finally { store.close(); }
  });
  it('validates the chosen rank one before submission and never promotes rank two', async () => {
    const clock = Date.parse('2026-01-01'), target = makeTarget('stale', 1), store = openSearchStore(':memory:'), grabs: string[] = [];
    const observer: any = { observe: async () => ({ observedAt: clock, sonarr: { known: true }, radarr: { known: false }, targets: [target] }), validateTarget: async () => false, sourceFingerprint: () => 'fp' };
    const matched = { ...result(), options: [{ optionId: 'first', rank: 1, releases: [{ candidateId: '1' }], coveredTargetIds: [], reason: 'best', uncertainty: '' }, { optionId: 'second', rank: 2, releases: [{ candidateId: '2' }], coveredTargetIds: [], reason: 'next', uncertainty: '' }] };
    try {
      const submission = { submit: vi.fn(async (request: { optionId: string }, context: { validate(): Promise<boolean> }) => { if (await context.validate()) grabs.push(request.optionId); return { outcome: 'rejected', searchId: 's', optionId: request.optionId, candidateIds: [], outcomes: [] } as any; }) };
      await new ArrAutomation({ store, observer, search: { run: async () => matched }, submission, getPolicy: () => ({ enabled: true, dryRun: false }), clock: () => clock }).runPass();
      expect(submission.submit).toHaveBeenCalledTimes(1);
      expect(submission.submit.mock.calls[0]![0]).toMatchObject({ optionId: 'first' });
      expect(grabs).toEqual([]);
    } finally { store.close(); }
  });
  it('uses operational backoff rather than a six-hour no-match deadline for a failed search result', async () => {
    let clock = Date.parse('2026-01-01');
    const target: any = { key: 'tv:episode', provider: 'sonarr', sourceFingerprint: 'source', serviceId: 1, externalId: 2, episodeId: 3, monitored: true, hasFile: false, eligible: true, available: true, context: { title: 'Show', titles: ['Show'], seasonNumber: 2, episodeNumber: 1, absoluteEpisodeNumber: 26 } };
    const observer: any = { observe: async () => ({ observedAt: clock, sonarr: { known: true }, radarr: { known: false }, targets: [target] }), validateTarget: async () => true };
    const store = openSearchStore(':memory:');
    const search: any = { run: async () => ({ searchId: 's', status: 'failed', options: [], candidates: [], counts: {}, events: [], promptVersion: 'v1' }) };
    try {
      const automation = new ArrAutomation({ observer, store, search, submission: { submit: vi.fn() }, getPolicy: () => ({ enabled: true, dryRun: false }), clock: () => clock });
      const result = await automation.runPass();
      expect(result.nextAttemptAt).toBe(clock + 5 * 60_000);
      expect(store.getAutomationAttempt(target.key)?.failCount).toBe(1);
      clock += 5 * 60_000;
      expect((await automation.runPass()).nextAttemptAt).toBe(clock + 10 * 60_000);
      expect(store.getAutomationAttempt(target.key)?.failCount).toBe(2);
    } finally { store.close(); }
  });
  it.each(['failed', 'budget-exhausted', 'interrupted'] as const)('uses exponential backoff for %s searches even in dry-run', async status => {
    let clock = Date.parse('2026-01-01'); const target = makeTarget(`dry-run-${status}`, 1), store = openSearchStore(':memory:');
    const observer: any = { observe: async () => ({ observedAt: clock, sonarr: { known: true }, radarr: { known: false }, targets: [target] }) };
    const search = { run: vi.fn(async () => result(status)) }, submission = { submit: vi.fn() };
    try {
      const automation = new ArrAutomation({ store, observer, search, submission, getPolicy: () => ({ enabled: true, dryRun: true }), clock: () => clock });
      let pass = await automation.runPass();
      expect(pass.nextAttemptAt).toBe(clock + 5 * 60_000);
      expect(store.getAutomationAttempt(target.key)?.failCount).toBe(1);
      expect(submission.submit).not.toHaveBeenCalled();
      clock = pass.nextAttemptAt!;
      pass = await automation.runPass();
      expect(pass.nextAttemptAt).toBe(clock + 10 * 60_000);
      expect(store.getAutomationAttempt(target.key)?.failCount).toBe(2);
    } finally { store.close(); }
  });
  it('uses a short search retry for a matched dry-run without creating submission grace', async () => {
    const clock = Date.parse('2026-01-01'), target = makeTarget('dry-run-match', 1), store = openSearchStore(':memory:');
    const observer: any = { observe: async () => ({ observedAt: clock, sonarr: { known: true }, radarr: { known: false }, targets: [target] }) };
    try {
      const pass = await new ArrAutomation({ store, observer, search: { run: async () => result('matched') }, submission: { submit: vi.fn() }, getPolicy: () => ({ enabled: true, dryRun: true, searchRetryMinutes: 30 }), clock: () => clock }).runPass();
      expect(pass.reason).toBe('paused-after-search');
      expect(pass.nextAttemptAt).toBe(clock + 30 * 60_000);
      expect(store.getAutomationAttempt(target.key)).toMatchObject({ failCount: 0, deadline: clock + 30 * 60_000, graceUntil: 0 });
    } finally { store.close(); }
  });
  it('stores dry-run cooldown in SQLite and does not repeat across automation restart', async () => {
    let clock = Date.parse('2026-01-01T00:00:00Z');
    const sonarr = {
      getSeries: async () => [{ id: 1, tvdbId: 20, title: 'Show', titleSlug: 'show', seriesType: 'standard', monitored: true, seasons: [], alternateTitles: [] }],
      getEpisodes: async () => [{ id: 2, seriesId: 1, seasonNumber: 1, episodeNumber: 1, absoluteEpisodeNumber: null, title: 'Pilot', airDate: '2020-01-01', airDateUtc: null, finaleType: null, monitored: true, hasFile: false }],
      getQueue: async () => [],
    } as unknown as SonarrClient;
    const observer = new ArrObserver({ sonarr, source: { sonarr: { id: 'one', url: 'http://sonarr', apiKey: 'secret' } }, clock: () => clock });
    const store = openSearchStore(':memory:');
    const search = { run: vi.fn(async () => ({ searchId: 's', status: 'matched' as const, options: [{ optionId: 'o', rank: 1, releases: [{ candidateId: 'c' }], coveredTargetIds: [], reason: 'match', uncertainty: '' }], candidates: [], counts: { decisions: 1, searches: 1, candidates: 1 }, events: [], promptVersion: 'test' })) };
    const submission = { submit: vi.fn() };
    try {
      const first = await new ArrAutomation({ store, observer, search, submission, getPolicy: () => ({ enabled: true, dryRun: true }), clock: () => clock }).runPass();
      expect(first.search?.status).toBe('matched');
      expect(search.run).toHaveBeenCalledTimes(1);
      clock += 6 * 60_000;
      const restarted = new ArrAutomation({ store, observer, search, submission, getPolicy: () => ({ enabled: true, dryRun: true }), clock: () => clock });
      expect((await restarted.runPass()).reason).toBe('nothing-due');
      expect(search.run).toHaveBeenCalledTimes(1);
      expect(submission.submit).not.toHaveBeenCalled();
    } finally { store.close(); }
  });

  it('schedules the due episode after a downloading sibling and passes complete sanitized identity/preferences', async () => {
    const clock = Date.parse('2026-02-01');
    const targets = [makeTarget('e3', 3, false), makeTarget('e4', 4)];
    const snapshot = { observedAt: clock, sonarr: { known: true, observedAt: clock, targets, queue: [], diagnostics: { unidentifiedQueueRows: 0 } }, radarr: { known: false, observedAt: clock, targets: [], queue: [], diagnostics: { unidentifiedQueueRows: 0 } }, targets } satisfies ArrSnapshot;
    const observer = { observe: async () => snapshot, validateTarget: async () => true };
    const store = openSearchStore(':memory:');
    let request: SearchRequest | undefined;
    const search = { run: vi.fn(async (raw: SearchRequest) => { request = raw; return result(); }) };
    const submission = { submit: vi.fn() };
    try {
      const automation = new ArrAutomation({ store, observer, search, submission, getPolicy: () => ({ enabled: true, dryRun: true, preferences: 'Prefer anime' }), clock: () => clock });
      const pass = await automation.runPass();
      expect(pass.targetKey).toBe('e4');
      expect(request?.context?.titles).toEqual(['Show', 'Alias']);
      expect(request?.context?.scope).toMatchObject({ seasonNumber: 2, episodeNumber: 4, absoluteEpisodeNumber: 28 });
      expect(request?.preferences?.notes).toBe('Prefer anime');
      expect(request?.prompt).toContain('Show');
    } finally { store.close(); }
  });

  it('does not submit rank one when automation is paused while search is in flight', async () => {
    const clock = Date.parse('2026-02-01'), target = makeTarget('e4', 4);
    const snapshot: ArrSnapshot = { observedAt: clock, sonarr: { known: true, observedAt: clock, targets: [target], queue: [], diagnostics: { unidentifiedQueueRows: 0 } }, radarr: { known: false, observedAt: clock, targets: [], queue: [], diagnostics: { unidentifiedQueueRows: 0 } }, targets: [target] };
    const observer = { observe: async () => snapshot, validateTarget: async () => true };
    const store = openSearchStore(':memory:');
    const policy = { enabled: true, dryRun: false };
    const submission = { submit: vi.fn() };
    try {
      const search = { run: async () => { policy.enabled = false; return result(); } };
      const pass = await new ArrAutomation({ store, observer, search, submission, getPolicy: () => policy, clock: () => clock }).runPass();
      expect(pass.reason).toBe('paused-after-search');
      expect(submission.submit).not.toHaveBeenCalled();
      expect(store.getAutomationAttempt(target.key)?.deadline).toBe(0);
      expect(store.getDeadline(target.key) ?? 0).toBe(0);
    } finally { store.close(); }
  });

  it.each(['submitted', 'submitting'])('expires a vanished-queue %s receipt once and passes target exclusions to public search', async outcome => {
    const clock = Date.parse('2026-02-01'), target = makeTarget('sonarr:fp:1:20:4', 4);
    const snapshot: ArrSnapshot = { observedAt: clock, sonarr: { known: true, observedAt: clock, targets: [target], queue: [], diagnostics: { unidentifiedQueueRows: 0 } }, radarr: { known: false, observedAt: clock, targets: [], queue: [], diagnostics: { unidentifiedQueueRows: 0 } }, targets: [target] };
    const observer = { observe: async () => snapshot, validateTarget: async () => true };
    const store = openSearchStore(':memory:');
    const search = { run: vi.fn(async (_request: SearchRequest, _limits: unknown, _signal: unknown, context: {targetKeys?: string[]}) => { expect(context.targetKeys).toEqual([target.key]); return result('no-match'); }) };
    try {
      store.reserveSubmission({ idempotencyKey: 'receipt', payload: { targets: [target.key], physicalReleases: ['physical-hash'] }, owner: 'owner', targets: [target.key], physicalReleases: ['physical-hash'], now: clock - 40 * 60_000, graceMs: 30 * 60_000 });
      store.updateSubmissionOutcome('receipt', outcome);
      const automation = new ArrAutomation({ store, observer, search, submission: { submit: vi.fn() }, getPolicy: () => ({ enabled: true, dryRun: false }), clock: () => clock });
      await automation.runPass();
      expect(store.isExcluded(target.key, 'physical-hash', clock + 23 * 60 * 60_000)).toBe(true);
      expect(store.isExcluded(target.key, 'physical-hash', clock + 25 * 60 * 60_000)).toBe(false);
      const saved = store.getSetting(`arr-receipt:receipt:excluded:${target.key}:physical-hash`) as {createdAt:number};
      expect(saved.createdAt).toBe(clock);
    } finally { store.close(); }
  });

  it('records observed import without preventing a later fresh missing-library observation from retrying', async () => {
    let clock = Date.parse('2026-02-01'), current = { ...makeTarget('sonarr:fp:1:20:4', 4, false), hasFile: true };
    const snapshot = (): ArrSnapshot => ({ observedAt: clock, sonarr: { known: true, observedAt: clock, targets: [current], queue: [], diagnostics: { unidentifiedQueueRows: 0 } }, radarr: { known: false, observedAt: clock, targets: [], queue: [], diagnostics: { unidentifiedQueueRows: 0 } }, targets: [current] });
    const observer = { observe: async () => snapshot(), validateTarget: async () => true };
    const store = openSearchStore(':memory:');
    const search = { run: vi.fn(async () => result('no-match')) };
    try {
      store.reserveSubmission({ idempotencyKey: 'imported', payload: { targets: [current.key], physicalReleases: ['physical'] }, owner: 'owner', targets: [current.key], physicalReleases: ['physical'], now: clock - 40 * 60_000, graceMs: 30 * 60_000 });
      store.updateSubmissionOutcome('imported', 'submitted');
      const automation = new ArrAutomation({ store, observer, search, submission: { submit: vi.fn() }, getPolicy: () => ({ enabled: true, dryRun: false }), clock: () => clock });
      await automation.runPass();
      expect(store.getSetting('arr-receipt:imported:imported')).toBeTruthy();
      current = { ...current, hasFile: false, eligible: true };
      clock += 5 * 60_000;
      await automation.runPass();
      expect(search.run).toHaveBeenCalledTimes(1);
    } finally { store.close(); }
  });
});
