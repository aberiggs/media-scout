import { afterEach, describe, expect, it, vi } from 'vitest';
import pino from 'pino';
import { buildApp } from '../src/daemon';
import type { Stack } from '../src/compose';
import { State } from '../src/core/state';
import { WORK_OBSERVATION_STALE_AFTER_MS } from '../src/core/state';
import { OperationsDashboard } from '../src/core/operations';
import type { WorkItem } from '../src/core/work-queue-types';
import type { CycleSummary } from '../src/core/runner';
import { defaultSettings } from '../src/settings';

const NOW = '2026-10-01T00:00:00.000Z';
const resources: Array<{ app: Awaited<ReturnType<typeof buildApp>>; state: State }> = [];

function makeApp(cycle: () => Promise<CycleSummary> = async () => ({ units: 0, searched: 0, grabbed: 0, dryRunGrabs: 0, manualFlagged: 0, skipped: 0 })) {
  const state = State.open(':memory:');
  state.saveSettings({ ...defaultSettings, safety: { ...defaultSettings.safety, allowOperatorActions: true },
    integrations: { prowlarr: { url: 'http://p.test', apiKey: 'p', tvClient: 'tv', movieClient: 'movie' }, sonarr: { url: 'http://s.test', apiKey: 's' }, radarr: { url: 'http://r.test', apiKey: 'r' } },
    ai: { ...defaultSettings.ai, apiKey: 'llm' } });
  const row: WorkItem = {
    workKey: 'sonarr:4:s1', contentIdentity: 'identity', missingFingerprint: 'fingerprint',
    unit: { key: 'sonarr:4:s1', kind: 'tv', arr: 'sonarr', serviceId: 4, externalId: 44, title: 'Show http://private.test/secret', altTitles: [] , season: { seasonNumber: 1, missing: [{ episodeId: 101, episodeNumber: 1, absoluteEpisodeNumber: null, title: 'Episode' }] } },
    status: 'backoff', lastSearchAt: NOW, nextSearchAt: null, failCount: 1, lastOutcome: 'operation-failure',
    lastQueueObservedAt: new Date().toISOString(), queueObservationKnown: true, blockedReason: null,
    lastObservedAt: new Date().toISOString(),
  };
  const owner = state.claimUnit(row.workKey, new Date(row.lastObservedAt))!;
  state.applyWorkReconciliation({ key: row.workKey, token: owner, work: row, intentUpdates: [] });
  state.applyWorkQueueObservation({ key: row.workKey, token: owner, observedAt: row.lastQueueObservedAt!, known: true, coverage: [] });
  state.flagManualReview(row.workKey, 'no-suitable-release', 'details contain secret-url https://private.test/key', new Date(NOW));
  state.releaseClaim(row.workKey, owner);
  const stack = {
    config: { DRY_RUN: true, LLM_MODEL: 'test', CYCLE_INTERVAL_MIN: 5, LOG_LEVEL: 'silent', HTTP_PORT: 7877, HTTP_HOST: '127.0.0.1', DB_PATH: ':memory:' },
    state, runner: { cycle },
    logger: pino({ level: 'silent' }),
  } as unknown as Stack;
  stack.createSnapshot = () => stack;
  return buildApp(stack).then((app) => { resources.push({ app, state }); return { app, state }; });
}
afterEach(async () => { for (const resource of resources.splice(0)) { await resource.app.close(); resource.state.close(); } });

describe('operational dashboard API', () => {
  it('projects eligibility only for displayed work and skips it when operator actions are disabled', async () => {
    const { state } = await makeApp();
    const now = new Date();
    const dashboard = new OperationsDashboard(state, () => now);
    const eligibility = vi.spyOn(state, 'getWorkActionEligibility');

    const beyondPage = dashboard.work({ limit: 1, offset: 1 }, true, now);
    expect(beyondPage).toMatchObject({ items: [], total: 1, counts: { backoff: 1 } });
    expect(eligibility).not.toHaveBeenCalled();

    const visible = dashboard.work({ limit: 1, offset: 0 }, true, now);
    expect(visible).toMatchObject({ total: 1, items: [{ workKey: 'sonarr:4:s1', actions: { retry: { allowed: true }, reset: { allowed: true } } }] });
    expect(eligibility).toHaveBeenCalledTimes(1);

    const disabled = dashboard.work({ limit: 1, offset: 0 }, false, now);
    expect(disabled).toMatchObject({ total: 1, counts: { backoff: 1 }, items: [{ actions: {
      retry: { allowed: false, reason: 'operator-actions-disabled' }, reset: { allowed: false, reason: 'operator-actions-disabled' },
    } }] });
    expect(eligibility).toHaveBeenCalledTimes(1);
  });

  it('projects review eligibility only for displayed open ordinary reviews', async () => {
    const { state } = await makeApp();
    const now = new Date();
    const dashboard = new OperationsDashboard(state, () => now);
    const eligibility = vi.spyOn(state, 'getWorkActionEligibility');
    const at = new Date(now.getTime() - 1_000);
    state.flagManualReview('sonarr:4:s1', 'queue-review', undefined, at);
    state.flagManualReview('sonarr:4:s1', 'picker-manual', undefined, at);
    const resolvedId = state.listManualReview(false).find((row) => row.reason === 'picker-manual')!.id;
    state.resolveManualReview(resolvedId, now);

    const offPage = dashboard.reviews({ resolved: false, limit: 1, offset: 0 }, true, now);
    expect(offPage.total).toBe(2);
    expect(offPage.items).toMatchObject([{ reason: 'queue-review' }]);
    expect(eligibility).not.toHaveBeenCalled();

    const disabled = dashboard.reviews({ resolved: false, limit: 10, offset: 0 }, false, now);
    expect(disabled.items).toHaveLength(2);
    expect(disabled.items.every((row) => row.actions.retry.reason === 'operator-actions-disabled')).toBe(true);
    expect(eligibility).not.toHaveBeenCalled();

    const resolved = dashboard.reviews({ resolved: true, limit: 10, offset: 0 }, true, now);
    expect(resolved.items).toHaveLength(1);
    expect(resolved.items[0]?.actions.retry).toEqual({ allowed: false, reason: 'review-resolved' });
    expect(eligibility).not.toHaveBeenCalled();

    const ordinary = dashboard.reviews({ resolved: false, q: 'Show', limit: 1, offset: 1 }, true, now);
    expect(ordinary.items).toHaveLength(1);
    expect(ordinary.items[0]?.actions.retry).toMatchObject({ allowed: false, reason: 'review-not-eligible' });
    expect(eligibility).toHaveBeenCalledTimes(1);
  });

  it('accepts the frontend default All-filter URLs for work and activity', async () => {
    const { app } = await makeApp();
    const work = await app.inject({ method: 'GET', url: '/api/operations/work?status=&q=&limit=50&offset=0' });
    expect(work.statusCode).toBe(200);
    expect(work.json()).toMatchObject({ items: [expect.objectContaining({ workKey: 'sonarr:4:s1' })], total: 1, counts: { backoff: 1 }, openReviewCount: 1 });
    expect(work.json()).toHaveProperty('generatedAt');

    const activity = await app.inject({ method: 'GET', url: '/api/operations/activity?q=&outcome=&limit=50&offset=0' });
    expect(activity.statusCode).toBe(200);
    expect(activity.json()).toMatchObject({ items: [], total: 0, retention: { days: 7, maxEntries: 2000 } });
    expect(activity.json()).toHaveProperty('generatedAt');
    expect((await app.inject({ method: 'GET', url: '/api/operations/work?status=not-a-status&q=&limit=50&offset=0' })).statusCode).toBe(400);
    expect((await app.inject({ method: 'GET', url: '/api/operations/activity?q=&outcome=not-an-outcome&limit=50&offset=0' })).statusCode).toBe(400);
  });

  it('filters terminal history before pagination and reports the effective count scope', async () => {
    const { app, state } = await makeApp();
    const observedAt = new Date().toISOString();
    const addRow = (workKey: string, status: 'ready' | 'fulfilled' | 'inactive', movie = false) => {
      const unit: WorkItem['unit'] = movie
        ? { key: workKey, kind: 'movie', arr: 'radarr', serviceId: 8, externalId: 88, title: 'Movie', year: 2020, altTitles: [] }
        : { key: workKey, kind: 'tv', arr: 'sonarr', serviceId: 4, externalId: 44, title: 'Show', altTitles: [], season: { seasonNumber: Number(workKey.slice(-1)), missing: status === 'ready' ? [{ episodeId: 201, episodeNumber: 1, absoluteEpisodeNumber: null, title: 'Episode' }] : [] } };
      const item: WorkItem = { workKey, contentIdentity: `identity-${workKey}`, missingFingerprint: `fingerprint-${workKey}`, unit, status,
        lastSearchAt: null, nextSearchAt: null, failCount: 0, lastOutcome: null, lastObservedAt: observedAt, lastQueueObservedAt: observedAt,
        queueObservationKnown: true, blockedReason: null };
      const owner = state.claimUnit(workKey, new Date(observedAt))!;
      state.applyWorkReconciliation({ key: workKey, token: owner, work: item, intentUpdates: [] });
      state.applyWorkQueueObservation({ key: workKey, token: owner, observedAt, known: true, coverage: [] });
      state.releaseClaim(workKey, owner);
    };
    addRow('radarr:8', 'ready', true);
    addRow('sonarr:4:s2', 'fulfilled');
    addRow('sonarr:4:s3', 'inactive');

    const firstActivePage = await app.inject({ method: 'GET', url: '/api/operations/work?limit=1&offset=0' });
    const secondActivePage = await app.inject({ method: 'GET', url: '/api/operations/work?limit=1&offset=1' });
    expect(firstActivePage.json()).toMatchObject({ scope: 'active', countScope: 'active', total: 2, counts: { fulfilled: 0, inactive: 0 } });
    expect(secondActivePage.json().total).toBe(2);
    expect(secondActivePage.json().items).toHaveLength(1);

    const historyPage = await app.inject({ method: 'GET', url: '/api/operations/work?scope=all&limit=2&offset=1' });
    expect(historyPage.json()).toMatchObject({ scope: 'all', countScope: 'all', total: 4, counts: { backoff: 1, ready: 1, fulfilled: 1, inactive: 1 } });
    expect(historyPage.json().items.map((item: { status: string }) => item.status)).toEqual(['backoff', 'fulfilled']);
    const lastHistoryPage = await app.inject({ method: 'GET', url: '/api/operations/work?scope=all&limit=1&offset=3' });
    expect(lastHistoryPage.json().items.map((item: { status: string }) => item.status)).toEqual(['inactive']);
    const explicitTerminal = await app.inject({ method: 'GET', url: '/api/operations/work?status=fulfilled&limit=50&offset=0' });
    expect(explicitTerminal.json()).toMatchObject({ scope: 'active', countScope: 'all', total: 1, items: [{ status: 'fulfilled' }] });
    expect((await app.inject({ method: 'GET', url: '/api/operations/work?scope=bad' })).statusCode).toBe(400);
  });

  it('uses one explicit freshness time, disables every mutation projection when opted out, and exposes season-scoped reviews', async () => {
    const { app, state } = await makeApp();
    const now = new Date('2026-10-10T00:00:00.000Z');
    const base = new Date(now.getTime() - WORK_OBSERVATION_STALE_AFTER_MS).toISOString();
    const setObservation = (lastObservedAt: string, lastQueueObservedAt: string | null, known: boolean) => {
      const current = state.getWorkItem('sonarr:4:s1')!;
      const owner = state.claimUnit(current.workKey, now)!;
      state.applyWorkReconciliation({ key: current.workKey, token: owner, work: { ...current, lastObservedAt, lastQueueObservedAt, queueObservationKnown: known }, intentUpdates: [] });
      state.applyWorkQueueObservation({ key: current.workKey, token: owner, observedAt: lastQueueObservedAt ?? lastObservedAt, known, coverage: [] });
      state.releaseClaim(current.workKey, owner);
    };
    let injectedClockReads = 0;
    const dashboard = new OperationsDashboard(state, () => { injectedClockReads += 1; return now; });
    setObservation(base, base, true);
    const oneMillisecondFresh = dashboard.work({ limit: 50, offset: 0 }, true, new Date(now.getTime() - 1));
    expect(oneMillisecondFresh.items[0]?.observationState).toBe('known');
    expect(oneMillisecondFresh.items[0]?.actions.reset.allowed).toBe(true);
    expect(oneMillisecondFresh.generatedAt).toBe(new Date(now.getTime() - 1).toISOString());
    expect(oneMillisecondFresh.freshness).toEqual({ staleAfterHours: 24 });
    const exactCutoff = dashboard.work({ limit: 50, offset: 0 }, true);
    expect(exactCutoff.items[0]?.observationState).toBe('known');
    expect(injectedClockReads).toBe(1);
    const oneMillisecondStale = dashboard.work({ limit: 50, offset: 0 }, true, new Date(now.getTime() + 1));
    expect(oneMillisecondStale.items[0]).toMatchObject({ observationState: 'stale', actions: { reset: { allowed: false, reason: 'queue-observation-stale' } } });

    setObservation(base, now.toISOString(), true);
    expect(dashboard.work({ limit: 50, offset: 0 }, true, new Date(now.getTime() + 1)).items[0]?.observationState).toBe('stale'); // old library, fresh queue
    setObservation(now.toISOString(), base, true);
    expect(dashboard.work({ limit: 50, offset: 0 }, true, new Date(now.getTime() + 1)).items[0]?.observationState).toBe('stale'); // fresh library, old queue
    const futureAt = new Date(now.getTime() + 1).toISOString();
    setObservation(futureAt, now.toISOString(), true);
    expect(dashboard.work({ limit: 50, offset: 0 }, true, now).items[0]).toMatchObject({ observationState: 'unknown', actions: { reset: { allowed: false, reason: 'queue-observation-unknown' } } });
    setObservation(now.toISOString(), futureAt, true);
    expect(dashboard.work({ limit: 50, offset: 0 }, true, now).items[0]).toMatchObject({ observationState: 'unknown', actions: { retry: { allowed: false, reason: 'queue-observation-unknown' } } });
    setObservation(now.toISOString(), null, true);
    const db = (state as unknown as { db: { prepare: (sql: string) => { run: (...values: unknown[]) => void } } }).db;
    db.prepare('UPDATE work_items SET queue_observed_at=NULL,queue_known=1 WHERE work_key=?').run('sonarr:4:s1');
    expect(dashboard.work({ limit: 50, offset: 0 }, true, now).items[0]).toMatchObject({ observationState: 'unknown', queueObservationKnown: true, queueObservedAt: null });

    const secondItem: WorkItem = {
      workKey: 'sonarr:4:s2', contentIdentity: 'identity-s2', missingFingerprint: 'fingerprint-s2',
      unit: { key: 'sonarr:4:s2', kind: 'tv', arr: 'sonarr', serviceId: 4, externalId: 44, title: 'Show', altTitles: [], season: { seasonNumber: 2, missing: [{ episodeId: 201, episodeNumber: 1, absoluteEpisodeNumber: null, title: 'Second season' }] } },
      status: 'backoff', lastSearchAt: null, nextSearchAt: null, failCount: 1, lastOutcome: 'operation-failure', lastObservedAt: new Date().toISOString(), lastQueueObservedAt: new Date().toISOString(), queueObservationKnown: true, blockedReason: null,
    };
    const secondOwner = state.claimUnit(secondItem.workKey, new Date(secondItem.lastObservedAt))!;
    state.applyWorkReconciliation({ key: secondItem.workKey, token: secondOwner, work: secondItem, intentUpdates: [] });
    state.applyWorkQueueObservation({ key: secondItem.workKey, token: secondOwner, observedAt: secondItem.lastQueueObservedAt!, known: true, coverage: [] });
    state.flagManualReview(secondItem.workKey, 'no-suitable-release', undefined, new Date());
    state.releaseClaim(secondItem.workKey, secondOwner);

    const disabledSettings = { ...state.getSettings(), safety: { ...state.getSettings().safety, allowOperatorActions: false } };
    state.saveSettings(disabledSettings);
    const disabledWork = await app.inject({ method: 'GET', url: '/api/operations/work' });
    expect(disabledWork.json().items[0].actions).toEqual({ retry: { allowed: false, reason: 'operator-actions-disabled' }, reset: { allowed: false, reason: 'operator-actions-disabled' } });
    const disabledReview = await app.inject({ method: 'GET', url: '/api/operations/reviews' });
    expect(disabledReview.json().items.map((item: { mediaType: string; season?: number }) => [item.mediaType, item.season]).sort((left: Array<string | number | undefined>, right: Array<string | number | undefined>) => Number(left[1]) - Number(right[1]))).toEqual([['tv', 1], ['tv', 2]]);
    for (const review of disabledReview.json().items) expect(review.actions).toEqual({ retry: { allowed: false, reason: 'operator-actions-disabled' }, reset: { allowed: false, reason: 'operator-actions-disabled' }, associate: { allowed: false, reason: 'operator-actions-disabled' }, release: { allowed: false, reason: 'operator-actions-disabled' } });
  });

  it('serves paginated allowlisted work/review rows without raw review details and enforces validation/origin guards', async () => {
    const { app, state } = await makeApp();
    const work = await app.inject({ method: 'GET', url: '/api/operations/work?q=Show&limit=1&offset=0' });
    expect(work.statusCode).toBe(200);
    expect(work.json()).toMatchObject({ total: 1, counts: { backoff: 1 }, openReviewCount: 1, items: [{ workKey: 'sonarr:4:s1', mediaType: 'tv', observationState: 'known' }] });
    expect(work.body).not.toContain('private.test');
    expect(work.body).not.toContain('unit');
    const reviews = await app.inject({ method: 'GET', url: '/api/operations/reviews?resolved=false&limit=1' });
    expect(reviews.statusCode).toBe(200);
    expect(reviews.json().items[0]).toMatchObject({ reason: 'no-suitable-release', actions: { retry: { allowed: true }, reset: { allowed: true } } });
    expect(reviews.body).not.toContain('details contain');
    const unknownAt = new Date().toISOString();
    const unknownLease = state.claimUnit('sonarr:4:s1', new Date(unknownAt))!;
    state.applyWorkQueueObservation({ key: 'sonarr:4:s1', token: unknownLease, observedAt: unknownAt, known: false, coverage: [] });
    state.releaseClaim('sonarr:4:s1', unknownLease);
    const unknownWork = await app.inject({ method: 'GET', url: '/api/operations/work' });
    expect(unknownWork.json().items[0]).toMatchObject({ observationState: 'unknown', queueObservationKnown: false, queueObservedAt: expect.any(String) });
    expect(unknownWork.json().items[0].actions.reset).toMatchObject({ allowed: false, reason: 'queue-observation-unknown' });
    const activityId = state.startSearchActivity({ source: 'manual', query: 'query https://secret.test/path', media: [], now: new Date().toISOString() });
    state.finishSearchActivity({ id: activityId, now: new Date().toISOString(), resultCount: 4 });
    const activity = await app.inject({ method: 'GET', url: '/api/operations/activity?outcome=success&limit=1' });
    expect(activity.statusCode).toBe(200);
    expect(activity.json()).toMatchObject({ total: 1, retention: { days: 7, maxEntries: 2000 }, items: [{ source: 'manual', resultCount: 4, outcome: 'success' }] });
    expect(activity.body).not.toContain('secret.test');
    expect((await app.inject({ method: 'GET', url: '/api/operations/activity?outcome=private' })).statusCode).toBe(400);
    expect((await app.inject({ method: 'GET', url: '/api/operations/work?status=surprise' })).statusCode).toBe(400);
    const rejected = await app.inject({ method: 'POST', url: '/api/operations/work/action', headers: { origin: 'http://evil.test' }, payload: { workKey: 'sonarr:4:s1', action: 'reset' } });
    expect(rejected.statusCode).toBe(403);
    const invalid = await app.inject({ method: 'POST', url: '/api/operations/work/action', payload: { workKey: 'sonarr:4:s1', action: 'patch', status: 'ready' } });
    expect(invalid.statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: '/api/operations/reviews/not-an-id/prepare', payload: { action: 'associate' } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: '/api/operations/reviews/1/prepare', headers: { origin: 'http://evil.test' }, payload: { action: 'associate' } })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: '/api/operations/reviews/1/commit', payload: { action: 'associate', token: 'x'.repeat(32), challenge: 'anything', note: 'valid note' } })).statusCode).toBe(400);
  });

  it('records Reset through the guarded endpoint without running an immediate cycle', async () => {
    const { app, state } = await makeApp();
    const response = await app.inject({ method: 'POST', url: '/api/operations/work/action', payload: { workKey: 'sonarr:4:s1', action: 'reset' } });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true, message: 'Reset recorded; rediscovery will begin after a later known library observation.' });
    expect(state.getWorkItem('sonarr:4:s1')).toMatchObject({ status: 'ready', lastSearchAt: null, resetPendingAt: expect.any(String) });
    expect(await (await app.inject({ method: 'GET', url: '/api/operations/work' })).json()).toMatchObject({ items: [], total: 0, counts: { ready: 0 } });
    const unknownOwner = state.claimUnits({ keys: ['sonarr:4:s1', 'group:sonarr:4'], now: new Date() })!;
    state.applyWorkQueueObservation({ key: 'sonarr:4:s1', token: unknownOwner.ownerToken, observedAt: new Date().toISOString(), known: false, coverage: [] });
    state.releaseClaims({ keys: unknownOwner.keys, ownerToken: unknownOwner.ownerToken });
    expect((await (await app.inject({ method: 'GET', url: '/api/operations/work' })).json()).total).toBe(0);
    const afterReset = new Date(Date.parse(state.getWorkItem('sonarr:4:s1')!.resetPendingAt!) + 1).toISOString();
    const knownOwner = state.claimUnits({ keys: ['sonarr:4:s1', 'group:sonarr:4'], now: new Date(afterReset) })!;
    const observed = { ...state.getWorkItem('sonarr:4:s1')!, lastObservedAt: afterReset, lastQueueObservedAt: afterReset, queueObservationKnown: true, resetPendingAt: null };
    state.applyWorkReconciliation({ key: observed.workKey, token: knownOwner.ownerToken, work: observed, intentUpdates: [] });
    state.applyWorkQueueObservation({ key: observed.workKey, token: knownOwner.ownerToken, observedAt: afterReset, known: true, coverage: [] });
    state.releaseClaims({ keys: knownOwner.keys, ownerToken: knownOwner.ownerToken });
    expect((await (await app.inject({ method: 'GET', url: '/api/operations/work' })).json()).total).toBe(1);
  });

  it('rejects work actions while the local cycle gate is active', async () => {
    let resolveCycle!: (value: CycleSummary) => void;
    const pending = new Promise<CycleSummary>((resolve) => { resolveCycle = resolve; });
    const { app, state } = await makeApp(() => pending);
    const attempt = app.cycleGate.run();
    await Promise.resolve();
    const response = await app.inject({ method: 'POST', url: '/api/operations/work/action', payload: { workKey: 'sonarr:4:s1', action: 'reset' } });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ code: 'cycle-running' });
    expect(state.getWorkItem('sonarr:4:s1')).toMatchObject({ status: 'backoff', lastSearchAt: NOW });
    resolveCycle({ units: 0, searched: 0, grabbed: 0, dryRunGrabs: 0, manualFlagged: 0, skipped: 0 });
    await attempt;
  });
});
