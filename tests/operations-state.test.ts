import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { State, type ActivityScope } from '../src/core/state';
import Database from 'better-sqlite3';
import type { WorkItem } from '../src/core/work-queue-types';

const NOW = '2026-10-01T00:00:00.000Z';
const LATER = '2026-10-01T00:10:00.000Z';
const paths: string[] = [];
afterEach(() => { for (const path of paths.splice(0)) rmSync(path, { recursive: true, force: true }); });

function work(): WorkItem {
  return {
    workKey: 'sonarr:4:s1', contentIdentity: 'sonarr:4:44:tv', missingFingerprint: 'missing-a',
    unit: { key: 'sonarr:4:s1', kind: 'tv', arr: 'sonarr', serviceId: 4, externalId: 44, title: 'Show', altTitles: [], season: { seasonNumber: 1, missing: [{ episodeId: 101, episodeNumber: 1, absoluteEpisodeNumber: null, title: 'Episode' }] } },
    status: 'backoff', lastSearchAt: NOW, nextSearchAt: LATER, failCount: 3, lastOutcome: 'operation-failure', lastObservedAt: NOW,
    lastQueueObservedAt: NOW, queueObservationKnown: false, blockedReason: null,
  };
}
function siblingWork(): WorkItem {
  const item = work();
  item.workKey = 'sonarr:4:s2';
  item.contentIdentity = 'sonarr:4:44:tv';
  item.missingFingerprint = 'missing-sibling';
  item.unit = { ...item.unit, key: item.workKey, season: { seasonNumber: 2, missing: [{ episodeId: 201, episodeNumber: 1, absoluteEpisodeNumber: null, title: 'Sibling episode' }] } };
  return item;
}
function seed(state: State): void {
  const row = work();
  const token = state.claimUnit(row.workKey, new Date(NOW))!;
  state.applyWorkReconciliation({ key: row.workKey, token, work: row, intentUpdates: [] });
  state.applyWorkQueueObservation({ key: row.workKey, token, observedAt: NOW, known: true, coverage: [], failedQueueRefs: ['["previous-failure",101]'] });
  state.recordHash('hash-stays', row.workKey, new Date(NOW));
  state.recordRelease(7, 'guid-stays', row.workKey, new Date(NOW));
  state.recordDecision({ workKey: row.workKey, verdict: 'skip', grabbed: false }, new Date(NOW));
  state.flagManualReview(row.workKey, 'no-suitable-release', 'private details should never be projected', new Date(NOW));
  state.releaseClaim(row.workKey, token);
}

describe('operational work actions', () => {
  it('upgrades legacy activity rows idempotently and retains safe stage attribution through reopen', () => {
    const db = new Database(':memory:');
    db.exec(`CREATE TABLE search_activity(id INTEGER PRIMARY KEY AUTOINCREMENT,source TEXT NOT NULL,started_at TEXT NOT NULL,finished_at TEXT,query TEXT NOT NULL,media_json TEXT NOT NULL,result_count INTEGER,outcome TEXT NOT NULL,error_code TEXT);
      INSERT INTO search_activity(source,started_at,query,media_json,outcome) VALUES('cycle','${NOW}','Legacy query','[]','running')`);
    try {
      const state = new State(db);
      const scope: ActivityScope = { stage: 'episodes', event: 'search', fallback: true, deferredEpisodeCount: 0,
        targets: [{ workKey: 'sonarr:4:s1', seasonNumber: 1, episodeNumbers: [2], episodeCount: 1 }] };
      const id = state.startSearchActivity({ source: 'cycle', query: 'Show S01E02', media: [], scope, now: NOW });
      state.finishSearchActivity({ id, now: LATER, resultCount: null, errorCode: 'http-429' });
      const rows = new State(db).listSearchActivity(LATER);
      expect(rows[0]).toMatchObject({ scope, outcome: 'error', errorCode: 'http-429' });
      expect(rows[1]!.scope).toBeUndefined();
    } finally { db.close(); }
  });

  it('bounds acquisition diagnostics and rejects private or malformed scope data before storage', () => {
    const state = State.open(':memory:');
    try {
      const scope: ActivityScope = { stage: 'episodes', event: 'capacity-deferred', fallback: true, deferredEpisodeCount: 150,
        targets: [{ workKey: 'sonarr:4:s1', seasonNumber: 1, episodeNumbers: Array.from({ length: 150 }, (_, index) => index), episodeCount: 150 }] };
      expect(() => state.startSearchActivity({ source: 'cycle', query: 'No query', media: [], now: NOW,
        scope: { ...scope, credentials: 'never-store' } as unknown as ActivityScope })).toThrow();
      expect(() => state.startSearchActivity({ source: 'cycle', query: 'No query', media: [], now: NOW,
        scope: { ...scope, targets: [{ ...scope.targets[0]!, workKey: 'https://synthetic.invalid/?apikey=never-store' }] } })).toThrow();
      expect(state.listSearchActivity(NOW)).toEqual([]);
      state.startSearchActivity({ source: 'cycle', query: 'No query: capacity deferred', media: [], scope: { ...scope,
        targets: Array.from({ length: 25 }, (_, seasonNumber) => ({ ...scope.targets[0]!, workKey: `sonarr:4:s${seasonNumber}`, seasonNumber })),
      }, now: NOW });
      const saved = state.listSearchActivity(NOW)[0]!;
      expect(saved.scope!.targets[0]!.episodeNumbers).toHaveLength(100);
      expect(saved.scope!.targets[0]!.episodeCount).toBe(150);
      expect(saved.scope!.targets).toHaveLength(20);
      expect(JSON.stringify(saved)).not.toContain('never-store');
    } finally { state.close(); }
  });

  it('uses competing SQLite connections for lease exclusion and atomically resets only ordinary scheduling/review state', () => {
    const dir = mkdtempSync(join(tmpdir(), 'media-scout-operations-'));
    paths.push(dir);
    const path = join(dir, 'state.sqlite');
    const left = State.open(path);
    const right = State.open(path);
    seed(left);

    const keys = ['sonarr:4:s1', 'group:sonarr:4'];
    const lease = left.claimUnits({ keys, now: new Date(NOW) });
    expect(lease).not.toBeNull();
    expect(right.claimUnits({ keys, now: new Date(NOW) })).toBeNull();
    left.applyWorkAction({ workKey: 'sonarr:4:s1', action: 'reset', ownerToken: lease!.ownerToken, claimKeys: lease!.keys, now: LATER });

    expect(right.getWorkItem('sonarr:4:s1')).toMatchObject({ status: 'ready', lastSearchAt: null, nextSearchAt: null, failCount: 0, lastOutcome: null, resetPendingAt: LATER });
    expect(right.hasHash('hash-stays')).toBe(true);
    expect(right.hasRelease(7, 'guid-stays')).toBe(true);
    expect(right.lastDecisionAt('sonarr:4:s1')).toBe(NOW);
    expect(right.listWorkQueueObservations()[0]).toMatchObject({ failedQueueRefs: ['["previous-failure",101]'], observedAt: NOW, known: true });
    expect(right.listManualReview(false)).toHaveLength(0);
    left.releaseClaims({ keys: lease!.keys, ownerToken: lease!.ownerToken });
    left.close();
    right.close();
  });

  it('ordinary Retry preserves lastSearchAt; Reset clears unlinked safety reviews without deleting history', () => {
    const state = State.open(':memory:');
    seed(state);
    const keys = ['sonarr:4:s1', 'group:sonarr:4'];
    const lease = state.claimUnits({ keys, now: new Date(NOW) })!;
    state.applyWorkAction({ workKey: 'sonarr:4:s1', action: 'retry', ownerToken: lease.ownerToken, claimKeys: lease.keys, now: LATER });
    state.releaseClaims({ keys: lease.keys, ownerToken: lease.ownerToken });
    expect(state.getWorkItem('sonarr:4:s1')).toMatchObject({ status: 'ready', lastSearchAt: NOW, nextSearchAt: null, failCount: 0 });
    expect(state.getWorkActionEligibility('sonarr:4:s1', LATER)).toMatchObject({ retry: { allowed: false, reason: 'work-not-retryable' }, reset: { allowed: true } });

    const current = state.getWorkItem('sonarr:4:s1')!;
    state.flagManualReview(current.workKey, 'queue-review', 'must remain untouched', new Date(LATER));
    expect(state.getWorkActionEligibility(current.workKey, LATER).reset).toEqual({ allowed: true });
    const reset = state.claimUnits({ keys, now: new Date(LATER) })!;
    state.applyWorkAction({ workKey: current.workKey, action: 'reset', ownerToken: reset.ownerToken, claimKeys: reset.keys, now: LATER });
    expect(state.listManualReview()).toEqual([]);
    expect(state.listManualReview(true).every((review) => review.resolvedAt !== null)).toBe(true);
    expect(state.hasRelease(7, 'guid-stays')).toBe(true);
    state.close();
  });

  it('requires the same-series lease at the State boundary, blocks rate-limit deadlines and preserves state on rejected actions', () => {
    const state = State.open(':memory:');
    seed(state);
    const groupLease = state.claimUnits({ keys: ['sonarr:4:s1', 'group:sonarr:4'], now: new Date(NOW) })!;
    expect(() => state.applyWorkAction({ workKey: 'sonarr:4:s1', action: 'retry', ownerToken: groupLease.ownerToken, claimKeys: ['sonarr:4:s1'], now: LATER })).toThrow(/group claim/);
    expect(state.getWorkItem('sonarr:4:s1')).toMatchObject({ status: 'backoff', lastSearchAt: NOW, failCount: 3 });
    state.releaseClaims({ keys: groupLease.keys, ownerToken: groupLease.ownerToken });
    const item = { ...state.getWorkItem('sonarr:4:s1')!, lastOutcome: 'rate-limited', nextSearchAt: '2026-10-01T00:20:00.000Z' };
    const owner = state.claimUnit(item.workKey, new Date(NOW))!;
    state.applyWorkReconciliation({ key: item.workKey, token: owner, work: item, intentUpdates: [] });
    state.releaseClaim(item.workKey, owner);
    expect(state.getWorkActionEligibility(item.workKey, LATER).reset).toMatchObject({ allowed: false, reason: 'rate-limited' });
    state.close();
  });

  it('blocks a sibling-series reservation and retained vanished queue coverage; sibling live leases block but stale leases do not', () => {
    const reservationState = State.open(':memory:');
    seed(reservationState);
    const sibling = siblingWork();
    const reservationLease = reservationState.claimUnits({ keys: [sibling.workKey, 'group:sonarr:4'], now: new Date(NOW) })!;
    reservationState.applyWorkReconciliation({ key: sibling.workKey, token: reservationLease.ownerToken, work: sibling, intentUpdates: [] });
    const reservation = reservationState.beginGrab({ key: sibling.workKey, token: reservationLease.ownerToken, fingerprint: sibling.missingFingerprint,
      release: { arr: 'sonarr', indexerId: 8, guid: 'sibling-reservation', infoHash: null, releaseTitle: 'Show.S02E01' },
      coverage: [{ workKey: sibling.workKey, episodeIds: [201], basis: 'explicit-episodes' }], now: NOW, deadline: LATER });
    expect(reservation.ok).toBe(true);
    if (!reservation.ok) throw new Error('expected sibling reservation');
    reservationState.markGrabUncertain({ intentId: reservation.intentId, ownerToken: reservationLease.ownerToken, now: LATER });
    reservationState.releaseClaims({ keys: reservationLease.keys, ownerToken: reservationLease.ownerToken });
    expect(reservationState.getWorkActionEligibility('sonarr:4:s1', LATER).retry).toMatchObject({ allowed: false, reason: 'reservation-open' });
    expect(reservationState.getWorkActionEligibility('sonarr:4:s1', LATER).reset).toEqual({ allowed: true });
    const rejectedLease = reservationState.claimUnits({ keys: ['sonarr:4:s1', 'group:sonarr:4'], now: new Date(LATER) })!;
    const beforeIntents = reservationState.listGrabIntents();
    reservationState.applyWorkAction({ workKey: 'sonarr:4:s1', action: 'reset', ownerToken: rejectedLease.ownerToken, claimKeys: rejectedLease.keys, now: LATER });
    expect(reservationState.getWorkItem('sonarr:4:s1')).toMatchObject({ status: 'ready', lastSearchAt: null, failCount: 0, resetPendingAt: LATER });
    expect(reservationState.listGrabIntents()).toEqual(beforeIntents);
    expect(reservationState.listGrabIntents()[0]?.releasedAt).toBeUndefined();
    reservationState.releaseClaims({ keys: rejectedLease.keys, ownerToken: rejectedLease.ownerToken });
    reservationState.close();

    const queueState = State.open(':memory:');
    seed(queueState);
    const queueSibling = siblingWork();
    const queueLease = queueState.claimUnit(queueSibling.workKey, new Date(NOW))!;
    queueState.applyWorkReconciliation({ key: queueSibling.workKey, token: queueLease, work: queueSibling, intentUpdates: [] });
    queueState.applyWorkQueueObservation({ key: queueSibling.workKey, token: queueLease, observedAt: NOW, known: true, coverage: [{ workKey: queueSibling.workKey, episodeIds: [201], basis: 'explicit-episodes' }] });
    queueState.applyWorkQueueObservation({ key: queueSibling.workKey, token: queueLease, observedAt: LATER, known: false, coverage: [] });
    queueState.releaseClaim(queueSibling.workKey, queueLease);
    expect(queueState.getWorkActionEligibility('sonarr:4:s1', LATER).retry).toMatchObject({ allowed: false, reason: 'queue-coverage-held' });
    const beforeQueue = queueState.listWorkQueueObservations();
    const resetQueue = queueState.claimUnits({ keys: ['sonarr:4:s1', 'group:sonarr:4'], now: new Date(LATER) })!;
    queueState.applyWorkAction({ workKey: 'sonarr:4:s1', action: 'reset', ownerToken: resetQueue.ownerToken, claimKeys: resetQueue.keys, now: LATER });
    expect(queueState.listWorkQueueObservations()).toEqual(beforeQueue);
    queueState.close();

    const leaseState = State.open(':memory:');
    seed(leaseState);
    const activeSibling = siblingWork();
    const owner = leaseState.claimUnit(activeSibling.workKey, new Date(NOW))!;
    leaseState.applyWorkReconciliation({ key: activeSibling.workKey, token: owner, work: activeSibling, intentUpdates: [] });
    leaseState.releaseClaim(activeSibling.workKey, owner);
    const siblingOwner = leaseState.claimUnit(activeSibling.workKey, new Date(NOW))!;
    expect(leaseState.getWorkActionEligibility('sonarr:4:s1', NOW).reset).toMatchObject({ allowed: false, reason: 'work-claimed' });
    const afterLeaseExpiry = '2026-10-01T00:16:00.000Z';
    expect(leaseState.getWorkActionEligibility('sonarr:4:s1', afterLeaseExpiry).reset).toEqual({ allowed: true });
    leaseState.releaseClaim(activeSibling.workKey, siblingOwner);
    leaseState.close();
  });

  it('rejects future library/queue timestamps at both eligibility and transactional mutation boundaries', () => {
    const futureAt = '2026-10-01T00:00:01.000Z';
    for (const source of ['library', 'queue'] as const) {
      const state = State.open(':memory:');
      seed(state);
      const current = state.getWorkItem('sonarr:4:s1')!;
      const owner = state.claimUnit(current.workKey, new Date(source === 'library' ? futureAt : NOW))!;
      if (source === 'library') {
        state.applyWorkReconciliation({ key: current.workKey, token: owner, work: { ...current, lastObservedAt: futureAt }, intentUpdates: [] });
      } else {
        state.applyWorkQueueObservation({ key: current.workKey, token: owner, observedAt: futureAt, known: true, coverage: [] });
      }
      state.releaseClaim(current.workKey, owner);
      expect(state.getWorkActionEligibility(current.workKey, NOW).reset).toMatchObject({ allowed: false, reason: 'queue-observation-unknown' });
      const before = state.getWorkItem(current.workKey)!;
      const reviewsBefore = state.listManualReview(false);
      const actionLease = state.claimUnits({ keys: [current.workKey, 'group:sonarr:4'], now: new Date(NOW) })!;
      expect(() => state.applyWorkAction({ workKey: current.workKey, action: 'reset', ownerToken: actionLease.ownerToken, claimKeys: actionLease.keys, now: NOW })).toThrow(/queue-observation-unknown/);
      state.releaseClaims({ keys: actionLease.keys, ownerToken: actionLease.ownerToken });
      expect(state.getWorkItem(current.workKey)).toEqual(before);
      expect(state.listManualReview(false)).toEqual(reviewsBefore);
      state.close();
    }
  });

  it('rejects invalid persisted observation timestamps without scheduling or resolving reviews', () => {
    for (const timestampColumn of ['last_observed_at', 'queue_observed_at']) {
      const state = State.open(':memory:');
      seed(state);
      const db = (state as unknown as { db: { prepare: (sql: string) => { get: (...values: unknown[]) => unknown; run: (...values: unknown[]) => void } } }).db;
      const before = db.prepare('SELECT status,last_search_at,next_search_at,fail_count,last_outcome FROM work_items WHERE work_key=?').get('sonarr:4:s1');
      db.prepare(`UPDATE work_items SET ${timestampColumn}='not-a-timestamp' WHERE work_key=?`).run('sonarr:4:s1');
      const reviewsBefore = state.listManualReview(false);
      const lease = state.claimUnits({ keys: ['sonarr:4:s1', 'group:sonarr:4'], now: new Date(NOW) })!;
      expect(() => state.getWorkActionEligibility('sonarr:4:s1', NOW)).toThrow(/ISO timestamp/);
      expect(() => state.applyWorkAction({ workKey: 'sonarr:4:s1', action: 'reset', ownerToken: lease.ownerToken, claimKeys: lease.keys, now: NOW })).toThrow(/ISO timestamp/);
      state.releaseClaims({ keys: lease.keys, ownerToken: lease.ownerToken });
      expect(db.prepare('SELECT status,last_search_at,next_search_at,fail_count,last_outcome FROM work_items WHERE work_key=?').get('sonarr:4:s1')).toEqual(before);
      expect(state.listManualReview(false)).toEqual(reviewsBefore);
      state.close();
    }
  });
});
