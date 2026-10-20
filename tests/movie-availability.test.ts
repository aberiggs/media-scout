import { afterEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { State } from '../src/core/state';
import type { WorkItem } from '../src/core/work-queue-types';

const now = '2026-10-18T00:00:00.000Z';
const retryAt = '2026-10-18T06:00:00.000Z';
const opened: Database.Database[] = [];
afterEach(() => { for (const db of opened.splice(0)) db.close(); });

function setup(available = true, change: Partial<WorkItem> = {}) {
  const db = new Database(':memory:'); opened.push(db);
  const state = new State(db);
  const work: WorkItem = { workKey: 'radarr:8', contentIdentity: 'radarr:8:88:movie',
    missingFingerprint: JSON.stringify(['radarr:8:88:movie', [[8, available]]]),
    unit: { key: 'radarr:8', kind: 'movie', arr: 'radarr', serviceId: 8, externalId: 88, title: 'Movie', year: 2026, altTitles: [] },
    status: available ? 'manual' : 'waiting-release', blockedReason: 'manual-review',
    lastSearchAt: null, nextSearchAt: null, failCount: 0, lastOutcome: 'no-suitable-release',
    lastObservedAt: now, lastQueueObservedAt: now, queueObservationKnown: true, ...change };
  const token = state.claimUnit(work.workKey, new Date(now))!;
  state.applyWorkReconciliation({ key: work.workKey, token, work, intentUpdates: [] });
  state.applyWorkQueueObservation({ key: work.workKey, token, observedAt: work.lastQueueObservedAt!, known: work.queueObservationKnown, coverage: [] });
  state.flagManualReview(work.workKey, 'no-suitable-release', undefined, new Date(now));
  const convert = (overrides = {}) => state.convertLegacyAvailability({ key: work.workKey, token, contentIdentity: work.contentIdentity, now, retryAt, ...overrides });
  return { db, state, work, token, convert };
}

describe('legacy movie availability', () => {
  it.each([true, false])('converts availability-only review using captured Radarr availability %s', (available) => {
    const { state, convert } = setup(available);
    expect(convert()).toBe(true);
    expect(state.getWorkItem('radarr:8')).toMatchObject({ status: available ? 'cooldown' : 'waiting-release',
      nextSearchAt: available ? retryAt : null, lastSearchAt: null, blockedReason: available ? null : 'waiting-release' });
    expect(state.listManualReview()).toEqual([]);
    expect(state.listManualReview(true)[0]?.resolvedAt).toBe(now);
  });

  it.each(['queue-review', 'picker-manual', 'content-identity-changed'])('preserves concurrent %s review', (reason) => {
    const { state, convert } = setup();
    state.flagManualReview('radarr:8', reason, undefined, new Date(now));
    expect(convert()).toBe(false);
    expect(state.listManualReview()).toHaveLength(2);
  });

  it('does not convert unknown or stale observations, foreign identities or foreign owners', () => {
    const unknown = setup(true, { queueObservationKnown: false });
    expect(unknown.convert()).toBe(false);
    const fresh = setup();
    expect(fresh.convert({ contentIdentity: 'changed' })).toBe(false);
    expect(() => fresh.convert({ token: 'foreign' })).toThrow();
    fresh.state.releaseClaim('radarr:8', fresh.token);
    const later = '2026-10-20T00:00:00.000Z';
    const token = fresh.state.claimUnit('radarr:8', new Date(later))!;
    expect(fresh.convert({ token, now: later, retryAt: '2026-10-20T06:00:00.000Z' })).toBe(false);
  });

  it('preserves unresolved intents and queue coverage instead of converting', () => {
    const { state, token, work, convert } = setup();
    state.applyWorkReconciliation({ key: work.workKey, token, work: { ...work, status: 'ready', blockedReason: null }, intentUpdates: [] });
    expect(state.beginGrab({ key: work.workKey, token, fingerprint: work.missingFingerprint,
      release: { arr: 'radarr', indexerId: 1, guid: 'synthetic-reserved', infoHash: null, releaseTitle: 'Movie' },
      coverage: [{ workKey: work.workKey, episodeIds: null, basis: null }], now, deadline: '2026-10-18T00:30:00.000Z' })).toMatchObject({ ok: true });
    state.applyWorkReconciliation({ key: work.workKey, token, work, intentUpdates: [] });
    const intents = state.listGrabIntents();
    expect(convert()).toBe(false);
    expect(state.listGrabIntents()).toEqual(intents);
    const covered = setup();
    covered.state.applyWorkQueueObservation({ key: work.workKey, token: covered.token, observedAt: now, known: true,
      coverage: [{ workKey: work.workKey, episodeIds: null, basis: null }] });
    expect(covered.convert()).toBe(false);
  });
});
