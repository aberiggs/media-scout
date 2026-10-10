import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type Database from 'better-sqlite3';
import nock from 'nock';
import pino from 'pino';
import { buildApp } from '../src/daemon';
import type { Stack } from '../src/compose';
import { State } from '../src/core/state';
import { OperationsDashboard } from '../src/core/operations';
import type { WorkItem } from '../src/core/work-queue-types';
import { defaultSettings } from '../src/settings';
import { Runner, type RunnerDeps } from '../src/core/runner';
import type { LibrarySnapshot } from '../src/core/watcher';

const now = new Date('2026-10-10T00:00:00.000Z');
const resources: Array<{ app: Awaited<ReturnType<typeof buildApp>>; state: State }> = [];

async function fixture(alreadyIneligible = false) {
  const state = State.open(':memory:');
  state.saveSettings({ ...defaultSettings, safety: { ...defaultSettings.safety, allowOperatorActions: true } });
  const workKey = 'sonarr:41:s1';
  const unit: WorkItem['unit'] = { key: workKey, kind: 'tv', arr: 'sonarr', serviceId: 41, externalId: 4100,
    title: 'Synthetic Series', altTitles: [], season: { seasonNumber: 1, missing: [] } };
  const work: WorkItem = { workKey, contentIdentity: 'synthetic-series-4100', missingFingerprint: '[]', unit,
    status: 'fulfilled', lastSearchAt: null, nextSearchAt: null, failCount: 0, lastOutcome: null,
    lastObservedAt: now.toISOString(), lastQueueObservedAt: now.toISOString(), queueObservationKnown: true, blockedReason: null };
  const owner = state.claimUnit(workKey, now)!;
  state.applyWorkReconciliation({ key: workKey, token: owner, work, intentUpdates: [] });
  state.applyWorkQueueObservation({ key: workKey, token: owner, observedAt: now.toISOString(), known: true, coverage: [] });
  const db = (state as unknown as { db: Database.Database }).db;
  for (let i = 0; i < 21; i++) state.flagManualReview(workKey, 'unparseable-title', `synthetic review ${i}`, new Date(now.getTime() - (i + 1) * 1000));
  if (alreadyIneligible) db.prepare('UPDATE manual_review SET target_evidence_json=?').run(JSON.stringify({ kind: 'legacy-ineligible' }));
  state.releaseClaim(workKey, owner);
  const stack = { config: { DRY_RUN: true, LLM_MODEL: 'test', CYCLE_INTERVAL_MIN: 5, LOG_LEVEL: 'silent', HTTP_PORT: 7877, HTTP_HOST: '127.0.0.1', DB_PATH: ':memory:' },
    state, runner: { cycle: async () => { throw new Error('unexpected cycle'); } }, logger: pino({ level: 'silent' }) } as unknown as Stack;
  stack.createSnapshot = () => stack;
  const app = await buildApp(stack);
  resources.push({ app, state });
  return { app, state, workKey, db };
}

beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(now); nock.disableNetConnect(); });
afterEach(async () => {
  for (const r of resources.splice(0)) { await r.app.close(); r.state.close(); }
  vi.useRealTimers(); nock.enableNetConnect();
});

function replayRunner(state: State) {
  const snapshot: LibrarySnapshot = { observedAt: now.toISOString(), sonarr: { known: true, series: [{
    series: { id: 41, tvdbId: 4100, title: 'Synthetic Series', titleSlug: 'synthetic', seriesType: 'anime', monitored: true, seasons: [], alternateTitles: [] },
    known: true, episodes: Array.from({ length: 14 }, (_, index) => ({ id: index + 101, seriesId: 41, seasonNumber: 1,
      episodeNumber: index + 1, absoluteEpisodeNumber: index + 1, title: 'Synthetic episode', airDate: '2020-01-01', monitored: true, hasFile: true })),
  }] }, radarr: { known: true, movies: [] } };
  const forbidden = vi.fn(() => { throw new Error('Investigation replay must not plan, pick, search, associate, or grab'); });
  const runner = new Runner({ state, now: () => new Date(), logger: pino({ level: 'silent' }),
    watcher: { getSnapshot: async () => snapshot } as RunnerDeps['watcher'],
    sonarr: { getQueue: async () => [] }, radarr: { getQueue: async () => [] },
    planner: { plan: forbidden, planGroup: forbidden } as unknown as RunnerDeps['planner'],
    picker: { pick: forbidden, pickGroup: forbidden } as unknown as RunnerDeps['picker'],
    prowlarr: new Proxy({}, { get: () => forbidden }) as RunnerDeps['prowlarr'],
    config: { dryRun: true, minRetryHours: 6 }, clientNames: { tv: 'test', movie: 'test' },
  });
  return { runner, forbidden, snapshot };
}

describe('issue 10 completed legacy review cleanup', () => {
  it.each([false, true])('deletes obsolete legacy reviews after positive import polls (already tagged: %s)', async (alreadyIneligible) => {
    const { app, state, workKey } = await fixture(alreadyIneligible);
    const { runner, forbidden } = replayRunner(state);
    for (let poll = 0; poll < 2; poll++) {
      expect(await runner.cycle()).toMatchObject({ units: 0, searched: 0, grabbed: 0 });
      expect(state.getWorkItem(workKey)).toMatchObject({ status: 'fulfilled', unit: { season: { missing: [] } } });
      expect(state.listManualReview(true)).toHaveLength(0);
      expect((await app.inject({ method: 'GET', url: '/api/operations/reviews' })).json()).toMatchObject({ total: 0, items: [] });
      expect((await app.inject({ method: 'GET', url: '/api/operations/work' })).json()).toMatchObject({ total: 0, openReviewCount: 0 });
    }
    expect(forbidden).not.toHaveBeenCalled();
  });

  it('keeps captured review history while deleting completed legacy noise', async () => {
    const { state, workKey } = await fixture(true);
    state.flagUnparseableReview({ workKey, details: 'Synthetic captured review', at: new Date(now.getTime() - 1000),
      evidence: { arr: 'sonarr', serviceId: 41, externalId: 4100, episodeIds: [101, 102] } });
    const captured = state.listManualReview().find((r) => r.targetEvidenceKind === 'captured')!;
    const { runner, forbidden } = replayRunner(state);
    await runner.cycle();
    expect(state.getManualReview(captured.id)?.resolvedAt).toBe(now.toISOString());
    vi.setSystemTime(new Date(now.getTime() + 60_000));
    await runner.cycle();
    expect(state.getManualReview(captured.id)?.resolvedAt).toBe(now.toISOString());
    expect(state.listManualReview()).toHaveLength(0);
    expect(state.listManualReview(true)).toHaveLength(1);
    expect(forbidden).not.toHaveBeenCalled();
  });

  it.each(['unknown library', 'unknown episodes', 'empty inventory', 'missing file', 'other season', 'changed identity',
    'identity hold', 'orphan', 'stale snapshot', 'snapshot predates work', 'snapshot predates review', 'future snapshot', 'held claim'])
  ('does not delete legacy reviews with %s', async (condition) => {
    const { state, workKey, db } = await fixture(true);
    const { runner, snapshot } = replayRunner(state);
    const observed = snapshot.sonarr.series[0]!;
    if (condition === 'unknown library') snapshot.sonarr.known = false;
    if (condition === 'unknown episodes') { observed.known = false; observed.episodes = null; }
    if (condition === 'empty inventory') observed.episodes = [];
    if (condition === 'missing file') {
      observed.episodes![0]!.hasFile = false;
      // Keep missing work held so this safety test cannot start a paid operation.
      state.flagManualReview(workKey, 'queue-review', 'synthetic hold', now);
    }
    if (condition === 'other season') observed.episodes!.forEach((ep) => { ep.seasonNumber = 2; });
    if (condition === 'changed identity') observed.series.tvdbId = 9999;
    if (condition === 'identity hold') state.flagManualReview(workKey, 'content-identity-changed', 'synthetic identity hold', now);
    if (condition === 'orphan') db.prepare('DELETE FROM work_items').run();
    if (condition === 'stale snapshot') vi.setSystemTime(new Date(now.getTime() + 25 * 60 * 60_000));
    if (condition === 'snapshot predates work') snapshot.observedAt = new Date(now.getTime() - 1000).toISOString();
    if (condition === 'snapshot predates review') db.prepare('UPDATE manual_review SET created_at=?').run(new Date(now.getTime() + 1000).toISOString());
    if (condition === 'future snapshot') snapshot.observedAt = new Date(now.getTime() + 1000).toISOString();
    if (condition === 'held claim') state.claimUnit(workKey, now);
    await runner.cycle();
    expect(state.listManualReview().filter((r) => r.reason === 'unparseable-title')).toHaveLength(21);
  });

  it('deletes only obsolete unlinked title rows, leaving linked and other reviews untouched', async () => {
    const { state, workKey, db } = await fixture(true);
    const insert = db.prepare('INSERT INTO manual_review(work_key,reason,created_at,subject_kind,subject_key,target_evidence_json) VALUES(?,?,?,?,?,?)');
    insert.run(workKey, 'unparseable-title', now.toISOString(), 'queue', 'synthetic-queue', '{"kind":"legacy-ineligible"}');
    insert.run(workKey, 'unparseable-title', now.toISOString(), 'intent', 'synthetic-intent', '{"kind":"legacy-ineligible"}');
    state.flagManualReview(workKey, 'queue-review', 'synthetic queue uncertainty', now);
    state.flagManualReview(workKey, 'picker-manual', 'synthetic ordinary review', now);
    const before = state.listManualReview().filter((r) => r.subjectKind || r.reason !== 'unparseable-title');
    state.recordRelease(1, 'synthetic-guid', workKey, now);
    state.recordHash('synthetic-hash', workKey, now);
    const tables = ['grab_intents', 'seen_releases', 'seen_hashes', 'decisions', 'queue_associations', 'operator_audit'];
    const durableBefore = tables.map((t) => db.prepare(`SELECT * FROM ${t}`).all());
    await replayRunner(state).runner.cycle();
    expect(state.listManualReview(true)).toEqual(before);
    expect(tables.map((t) => db.prepare(`SELECT * FROM ${t}`).all())).toEqual(durableBefore);
    expect(state.getWorkItem(workKey)?.status).toBe('fulfilled');
  });

  it('does not suppress a review for a new missing target generation under the same season key', async () => {
    const { state, workKey } = await fixture(true);
    const { runner, snapshot } = replayRunner(state);
    await runner.cycle();
    expect(state.listManualReview(true)).toHaveLength(0);
    snapshot.sonarr.series[0]!.episodes![0]!.hasFile = false;
    state.flagUnparseableReview({ workKey, details: 'Synthetic new generation', at: now,
      evidence: { arr: 'sonarr', serviceId: 41, externalId: 4100, episodeIds: [101] } });
    state.flagManualReview(workKey, 'queue-review', 'synthetic scheduling hold', now);
    await runner.cycle();
    expect(state.listManualReview()).toEqual(expect.arrayContaining([expect.objectContaining({ reason: 'unparseable-title', resolvedAt: null })]));
  });

  it.each(['absent', 'unfiled', 'filed in another season'])('requires positive files for saved targets that are %s', async (condition) => {
    const { state, workKey } = await fixture(true);
    const work = state.getWorkItem(workKey)!;
    work.unit.season!.missing = [{ episodeId: 999, episodeNumber: 1, absoluteEpisodeNumber: null, title: 'Synthetic saved target' }];
    const token = state.claimUnit(workKey, now)!;
    state.applyWorkReconciliation({ key: workKey, token, work, intentUpdates: [] });
    state.releaseClaim(workKey, token);
    const { runner, snapshot } = replayRunner(state);
    if (condition !== 'absent') snapshot.sonarr.series[0]!.episodes!.push({ id: 999, seriesId: 41, seasonNumber: 2,
      episodeNumber: 1, absoluteEpisodeNumber: null, title: 'Synthetic moved target', airDate: null, monitored: false,
      hasFile: condition === 'filed in another season' });
    await runner.cycle();
    expect(state.listManualReview(true)).toHaveLength(condition === 'filed in another season' ? 0 : 21);
  });

  it('requires a live owner claim and refuses captured, resolved, or linked rows at the deletion boundary', async () => {
    const { state, workKey, db } = await fixture(true);
    const selected = state.listManualReview()[0]!;
    const token = state.claimUnit(workKey, now)!;
    const input = { id: selected.id, workKey, token, now: now.toISOString() };
    expect(() => state.deleteIneligibleUnparseableReview({ ...input, token: 'wrong-owner' })).toThrow();
    expect(() => state.deleteIneligibleUnparseableReview({ ...input, now: new Date(now.getTime() + 16 * 60_000).toISOString() })).toThrow();
    db.prepare('UPDATE manual_review SET subject_kind=?,subject_key=? WHERE id=?').run('intent', 'synthetic-intent', selected.id);
    expect(state.deleteIneligibleUnparseableReview(input)).toBe(false);
    db.prepare('UPDATE manual_review SET subject_kind=NULL,subject_key=NULL,resolved_at=? WHERE id=?').run(now.toISOString(), selected.id);
    expect(state.deleteIneligibleUnparseableReview(input)).toBe(false);
    db.prepare('UPDATE manual_review SET resolved_at=NULL,target_evidence_json=? WHERE id=?')
      .run(JSON.stringify({ arr: 'sonarr', serviceId: 41, externalId: 4100, episodeIds: [101] }), selected.id);
    expect(state.deleteIneligibleUnparseableReview(input)).toBe(false);
    expect(state.getManualReview(selected.id)).not.toBeNull();
    state.releaseClaim(workKey, token);
  });

  it('keeps fulfilled history and all 21 open reviews while blocking work mutations', async () => {
    const { app, state, workKey } = await fixture();
    const work = await app.inject({ method: 'GET', url: '/api/operations/work' });
    const history = await app.inject({ method: 'GET', url: '/api/operations/work?scope=all' });
    const reviews = await app.inject({ method: 'GET', url: '/api/operations/reviews?resolved=false' });
    expect(work.json()).toMatchObject({ total: 0, counts: { fulfilled: 0 }, openReviewCount: 21 });
    expect(history.json()).toMatchObject({ total: 1, counts: { fulfilled: 1 }, items: [{ workKey, status: 'fulfilled', missingCount: 0 }] });
    expect(reviews.json()).toMatchObject({ total: 21, items: Array.from({ length: 21 }, () => ({ actions: {
      retry: { allowed: false, reason: 'work-not-retryable' }, reset: { allowed: false, reason: 'work-not-resettable' },
      associate: { allowed: false, reason: 'action-not-eligible' }, release: { allowed: false, reason: 'action-not-eligible' },
    } })) });
    expect(new OperationsDashboard(state, () => now).work({ limit: 50, offset: 0 }, true, now).openReviewCount).toBe(21);
    expect(state.getWorkActionEligibility(workKey, now.toISOString())).toMatchObject({ retry: { allowed: false, reason: 'work-not-retryable' }, reset: { allowed: false, reason: 'work-not-resettable' } });
    expect((await app.inject({ method: 'POST', url: '/api/operations/work/action', payload: { workKey, action: 'retry' } })).json()).toMatchObject({ code: 'action-not-eligible' });
    expect(state.getWorkItem(workKey)?.status).toBe('fulfilled');
    expect(state.listManualReview()).toHaveLength(21);
  });

  it('resolves only the acknowledged review row and preserves fulfilled work and remaining history', async () => {
    const { state, workKey, db } = await fixture(true);
    state.recordRelease(1, 'synthetic-guid', workKey, now);
    state.recordHash('synthetic-hash', workKey, now);
    const tables = ['work_items', 'grab_intents', 'seen_releases', 'seen_hashes', 'decisions', 'unit_claims', 'operator_audit', 'work_action_audit', 'queue_associations'];
    const durableBefore = tables.map((table) => db.prepare(`SELECT * FROM ${table}`).all());
    const selected = state.listManualReview()[0]!;
    const before = state.getWorkItem(workKey);
    expect(state.resolveManualReview(selected.id, now)).toBe(true);
    expect(state.resolveManualReview(selected.id, now)).toBe(false);
    expect(state.getManualReview(selected.id)?.resolvedAt).toBe(now.toISOString());
    expect(state.listManualReview()).toHaveLength(20);
    expect(state.getWorkItem(workKey)).toEqual(before);
    expect(state.listManualReview(true)).toHaveLength(21);
    expect(tables.map((table) => db.prepare(`SELECT * FROM ${table}`).all())).toEqual(durableBefore);
  });
});
