import { afterEach, describe, expect, it } from 'vitest';
import pino from 'pino';
import { buildApp } from '../src/daemon';
import type { Stack } from '../src/compose';
import { State } from '../src/core/state';
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
