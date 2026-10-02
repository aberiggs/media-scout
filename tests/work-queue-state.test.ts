import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { State } from '../src/core/state';
import type { WorkItem } from '../src/core/work-queue-types';

const NOW = '2026-01-01T00:00:00.000Z';
const LATER = '2026-01-01T00:05:00.000Z';

function tvWork(key = 'sonarr:4:s1', ids = [101, 102]): WorkItem {
  return {
    workKey: key,
    contentIdentity: 'sonarr:4:s1',
    missingFingerprint: ids.join(','),
    unit: {
      key, kind: 'tv', arr: 'sonarr', serviceId: 4, externalId: 44, title: 'Show', altTitles: [],
      season: { seasonNumber: 1, missing: ids.map((episodeId, i) => ({ episodeId, episodeNumber: i + 1, absoluteEpisodeNumber: null, title: `Episode ${i + 1}` })) },
    },
    status: 'ready', lastSearchAt: null, nextSearchAt: null, failCount: 0, lastOutcome: null,
    lastObservedAt: NOW, lastQueueObservedAt: null, queueObservationKnown: false, blockedReason: null,
  };
}

function claim(state: State, key = 'sonarr:4:s1', at = NOW): string {
  const token = state.claimUnit(key, new Date(at));
  if (!token) throw new Error('claim unavailable');
  return token;
}

describe('durable work queue state', () => {
  it('persists work and intents across reopen and applies only under an active claim', () => {
    const db = new Database(':memory:');
    let state = new State(db);
    const work = tvWork();
    const token = claim(state);
    state.applyWorkReconciliation({ key: work.workKey, token, work, intentUpdates: [] });
    expect(state.getWorkItem(work.workKey)).toEqual(work);
    state.startSearch({ key: work.workKey, token, now: NOW, recoveryAt: LATER });
    expect(state.getWorkItem(work.workKey)).toMatchObject({ status: 'searching', lastSearchAt: NOW, nextSearchAt: LATER });
    state = new State(db);
    expect(state.listWorkItems()).toHaveLength(1);
    expect(state.listGrabIntents()).toEqual([]);
    expect(() => state.finishSearch({ key: work.workKey, token: 'not-owner', status: 'cooldown', nextSearchAt: null, failCount: 0, outcome: 'empty', now: LATER })).toThrow();
    state.finishSearch({ key: work.workKey, token, status: 'cooldown', nextSearchAt: LATER, failCount: 0, outcome: 'no-results', now: LATER, decision: { workKey: work.workKey, verdict: 'skip', grabbed: false } });
    expect(state.lastDecisionAt(work.workKey)).toBe(LATER);
    db.close();
  });

  it('preserves existing decision, hash and source-marker data when adding queue tables', () => {
    const db = new Database(':memory:');
    db.exec(`CREATE TABLE decisions (id INTEGER PRIMARY KEY AUTOINCREMENT, work_key TEXT NOT NULL, release_title TEXT, info_hash TEXT, verdict TEXT NOT NULL, grabbed INTEGER NOT NULL DEFAULT 0, decided_at TEXT NOT NULL);
      CREATE TABLE seen_hashes (info_hash TEXT PRIMARY KEY, work_key TEXT NOT NULL, seen_at TEXT NOT NULL);
      CREATE TABLE seen_releases (indexer_id INTEGER NOT NULL, guid TEXT NOT NULL, work_key TEXT NOT NULL, seen_at TEXT NOT NULL, PRIMARY KEY(indexer_id,guid));
      INSERT INTO decisions(work_key,verdict,grabbed,decided_at) VALUES ('old','skip',0,'${NOW}');
      INSERT INTO seen_hashes VALUES ('hash','old','${NOW}');
      INSERT INTO seen_releases VALUES (7,'guid','old','${NOW}');`);
    const state = new State(db);
    expect(state.lastDecisionAt('old')).toBe(NOW);
    expect(state.hasHash('hash')).toBe(true);
    expect(state.hasRelease(7, 'guid')).toBe(true);
    const token = state.claimUnit('legacy-claimed-work', new Date(NOW));
    expect(token).toBeTypeOf('string');
    expect(new State(db).claimUnit('legacy-claimed-work', new Date(NOW))).toBeNull();
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('work_items','grab_intents') ORDER BY name").all()).toEqual([{ name: 'grab_intents' }, { name: 'work_items' }]);
  });

  it('rejects malformed persisted work JSON and invalid durable enums instead of returning ready work', () => {
    const db = new Database(':memory:');
    const state = new State(db);
    const work = tvWork();
    state.applyWorkReconciliation({ key: work.workKey, token: claim(state), work, intentUpdates: [] });
    db.pragma('ignore_check_constraints = ON');
    db.prepare('UPDATE work_items SET unit_json = ? WHERE work_key = ?').run('{', work.workKey);
    expect(() => state.getWorkItem(work.workKey)).toThrow();
    db.prepare('UPDATE work_items SET unit_json = ?, status = ? WHERE work_key = ?').run(JSON.stringify(work.unit), 'surprise', work.workKey);
    expect(() => state.listWorkItems()).toThrow();
  });

  it('requires current fingerprint, exact current unit ownership, and requested episode coverage to reserve a grab', () => {
    const state = State.open(':memory:');
    const work = tvWork();
    const token = claim(state);
    state.applyWorkReconciliation({ key: work.workKey, token, work, intentUpdates: [] });
    const release = { arr: 'sonarr' as const, indexerId: 2, guid: 'g1', infoHash: 'h1', releaseTitle: 'Release' };
    expect(state.beginGrab({ key: work.workKey, token, fingerprint: 'stale', release, coverage: [{ workKey: work.workKey, episodeIds: [101], basis: 'explicit-episodes' }], now: NOW, deadline: LATER })).toEqual({ ok: false, reason: expect.any(String) });
    expect(state.beginGrab({ key: work.workKey, token, fingerprint: work.missingFingerprint, release, coverage: [{ workKey: work.workKey, episodeIds: [999], basis: 'explicit-episodes' }], now: NOW, deadline: LATER }).ok).toBe(false);
    expect(() => state.applyWorkReconciliation({ key: work.workKey, token: 'stale', work, intentUpdates: [] })).toThrow();
  });

  it('reserves overlapping coverage, source identity and hash across claims, while allowing disjoint partials', () => {
    const state = State.open(':memory:');
    const work = tvWork();
    const token = claim(state);
    state.applyWorkReconciliation({ key: work.workKey, token, work, intentUpdates: [] });
    const coverage = (episodeIds: number[]) => [{ workKey: work.workKey, episodeIds, basis: 'explicit-episodes' as const }];
    const first = state.beginGrab({ key: work.workKey, token, fingerprint: work.missingFingerprint, release: { arr: 'sonarr', indexerId: 2, guid: 'g1', infoHash: 'h1', releaseTitle: 'A' }, coverage: coverage([101]), now: NOW, deadline: LATER });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(state.beginGrab({ key: work.workKey, token, fingerprint: work.missingFingerprint, release: { arr: 'sonarr', indexerId: 2, guid: 'g2', infoHash: 'h2', releaseTitle: 'B' }, coverage: coverage([101]), now: NOW, deadline: LATER }).ok).toBe(false);
    const second = state.beginGrab({ key: work.workKey, token, fingerprint: work.missingFingerprint, release: { arr: 'sonarr', indexerId: 2, guid: 'g2', infoHash: 'h2', releaseTitle: 'B' }, coverage: coverage([102]), now: NOW, deadline: LATER });
    expect(second.ok).toBe(true);
    expect(state.beginGrab({ key: work.workKey, token, fingerprint: work.missingFingerprint, release: { arr: 'sonarr', indexerId: 2, guid: 'g1', infoHash: 'other', releaseTitle: 'C' }, coverage: coverage([102]), now: NOW, deadline: LATER }).ok).toBe(false);
    expect(state.beginGrab({ key: work.workKey, token, fingerprint: work.missingFingerprint, release: { arr: 'sonarr', indexerId: 9, guid: 'g9', infoHash: 'h1', releaseTitle: 'D' }, coverage: coverage([102]), now: NOW, deadline: LATER }).ok).toBe(false);
  });

  it('records markers only on an idempotent owner receipt, even after lease expiry, without clobbering newer schedule', () => {
    const state = State.open(':memory:');
    const work = tvWork();
    const token = claim(state);
    state.applyWorkReconciliation({ key: work.workKey, token, work, intentUpdates: [] });
    const result = state.beginGrab({ key: work.workKey, token, fingerprint: work.missingFingerprint, release: { arr: 'sonarr', indexerId: 3, guid: 'receipt', infoHash: 'receipt-hash', releaseTitle: 'Release' }, coverage: [{ workKey: work.workKey, episodeIds: [101], basis: 'explicit-episodes' }], now: NOW, deadline: LATER });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const expiredAt = new Date(new Date(NOW).getTime() + 16 * 60_000);
    const newer = claim(state, work.workKey, expiredAt.toISOString());
    const newerWork = { ...work, status: 'cooldown' as const, nextSearchAt: '2026-01-02T00:00:00.000Z' };
    state.applyWorkReconciliation({ key: work.workKey, token: newer, work: newerWork, intentUpdates: [] });
    expect(() => state.confirmGrab({ intentId: result.intentId, ownerToken: 'wrong', now: expiredAt.toISOString() })).toThrow();
    state.confirmGrab({ intentId: result.intentId, ownerToken: token, now: expiredAt.toISOString() });
    state.confirmGrab({ intentId: result.intentId, ownerToken: token, now: expiredAt.toISOString() });
    expect(() => state.markGrabUncertain({ intentId: result.intentId, ownerToken: token, now: expiredAt.toISOString() })).toThrow();
    expect(() => state.rejectGrab({ intentId: result.intentId, ownerToken: token, nextSearchAt: LATER, now: expiredAt.toISOString() })).toThrow();
    expect(state.hasHash('receipt-hash')).toBe(true);
    expect(state.hasRelease(3, 'receipt')).toBe(true);
    expect(state.lastDecisionAt(work.workKey)).toBe(expiredAt.toISOString());
    expect(state.getWorkItem(work.workKey)).toMatchObject({ status: 'cooldown', nextSearchAt: newerWork.nextSearchAt });
    expect(state.listGrabIntents()[0]?.status).toBe('awaiting-queue');
  });

  it('persists a reconciled physical queue reference and observation timestamp across state reopen', () => {
    const db = new Database(':memory:');
    const state = new State(db);
    const work = tvWork();
    const token = claim(state);
    state.applyWorkReconciliation({ key: work.workKey, token, work, intentUpdates: [] });
    const begun = state.beginGrab({
      key: work.workKey, token, fingerprint: work.missingFingerprint,
      release: { arr: 'sonarr', indexerId: 3, guid: 'linked-release', infoHash: null, releaseTitle: 'Pack' },
      coverage: [{ workKey: work.workKey, episodeIds: [101, 102], basis: 'inferred-season-pack' },], now: NOW, deadline: LATER,
    });
    if (!begun.ok) throw new Error('expected reservation');
    state.confirmGrab({ intentId: begun.intentId, ownerToken: token, now: NOW });
    state.applyWorkReconciliation({
      key: work.workKey, token, work: { ...work, lastObservedAt: LATER },
      intentUpdates: [{ id: begun.intentId, status: 'active', lastSeenAt: LATER, queueRefs: ['download:sonarr-pack-22'] }],
    });

    expect(new State(db).listGrabIntents()[0]).toMatchObject({
      id: begun.intentId, status: 'active', lastSeenAt: LATER, queueRefs: ['download:sonarr-pack-22'],
    });
    db.close();
  });

  it('accepts the immutable owner receipt after reconciliation advances intent and claim expires without regressing it', () => {
    const state = State.open(':memory:');
    const work = tvWork();
    const token = claim(state);
    state.applyWorkReconciliation({ key: work.workKey, token, work, intentUpdates: [] });
    const begun = state.beginGrab({ key: work.workKey, token, fingerprint: work.missingFingerprint, release: { arr: 'sonarr', indexerId: 6, guid: 'late-receipt', infoHash: 'late-hash', releaseTitle: 'Late' }, coverage: [{ workKey: work.workKey, episodeIds: [101], basis: 'explicit-episodes' }], now: NOW, deadline: LATER });
    if (!begun.ok) throw new Error('expected reservation');
    state.applyWorkReconciliation({ key: work.workKey, token, work: { ...work, status: 'searching', nextSearchAt: LATER }, intentUpdates: [{ id: begun.intentId, status: 'active', lastSeenAt: LATER, queueRefs: ['download:linked'] }] });
    const newerToken = claim(state, work.workKey, '2026-01-01T00:16:00.000Z');
    const newer = { ...work, status: 'cooldown' as const, nextSearchAt: '2026-01-02T00:00:00.000Z' };
    state.applyWorkReconciliation({ key: work.workKey, token: newerToken, work: newer, intentUpdates: [] });

    state.confirmGrab({ intentId: begun.intentId, ownerToken: token, now: '2026-01-01T00:16:00.000Z' });
    state.confirmGrab({ intentId: begun.intentId, ownerToken: token, now: '2026-01-01T00:16:01.000Z' });

    expect(state.listGrabIntents()[0]).toMatchObject({ status: 'active', confirmedAt: '2026-01-01T00:16:00.000Z', queueRefs: ['download:linked'] });
    expect(state.hasRelease(6, 'late-receipt')).toBe(true);
    expect(state.hasHash('late-hash')).toBe(true);
    expect(state.getWorkItem(work.workKey)).toMatchObject({ status: 'cooldown', nextSearchAt: newer.nextSearchAt });
    expect(state.lastDecisionAt(work.workKey)).toBe('2026-01-01T00:16:00.000Z');
  });

  it('accepts a late positive owner receipt after an uncertain transition without regressing the hold', () => {
    const state = State.open(':memory:');
    const work = tvWork();
    const owner = claim(state);
    state.applyWorkReconciliation({ key: work.workKey, token: owner, work, intentUpdates: [] });
    const begun = state.beginGrab({ key: work.workKey, token: owner, fingerprint: work.missingFingerprint, release: { arr: 'sonarr', indexerId: 12, guid: 'uncertain-late', infoHash: 'uncertain-late-hash', releaseTitle: 'Late' }, coverage: [{ workKey: work.workKey, episodeIds: [101], basis: 'explicit-episodes' }], now: NOW, deadline: LATER });
    if (!begun.ok) throw new Error('expected reservation');
    state.markGrabUncertain({ intentId: begun.intentId, ownerToken: owner, now: NOW });
    state.confirmGrab({ intentId: begun.intentId, ownerToken: owner, now: LATER });
    expect(state.listGrabIntents()[0]).toMatchObject({ status: 'uncertain', confirmedAt: LATER });
    expect(state.hasRelease(12, 'uncertain-late')).toBe(true);
    expect(state.hasHash('uncertain-late-hash')).toBe(true);
    expect(() => state.confirmGrab({ intentId: begun.intentId, ownerToken: 'other-owner', now: LATER })).toThrow(/owner/);
  });

  it('reserves overlapping content, source identity and hash across separately claimed work keys', () => {
    const state = State.open(':memory:');
    const firstWork = tvWork('sonarr:4:s1', [101, 102]);
    const secondWork = tvWork('sonarr:4:s1-alt', [101, 103]);
    secondWork.unit.key = secondWork.workKey;
    const firstToken = claim(state, firstWork.workKey);
    const secondToken = claim(state, secondWork.workKey);
    state.applyWorkReconciliation({ key: firstWork.workKey, token: firstToken, work: firstWork, intentUpdates: [] });
    state.applyWorkReconciliation({ key: secondWork.workKey, token: secondToken, work: secondWork, intentUpdates: [] });
    const first = state.beginGrab({ key: firstWork.workKey, token: firstToken, fingerprint: firstWork.missingFingerprint, release: { arr: 'sonarr', indexerId: 8, guid: 'shared', infoHash: 'shared-hash', releaseTitle: 'One' }, coverage: [{ workKey: firstWork.workKey, episodeIds: [101], basis: 'explicit-episodes' }], now: NOW, deadline: LATER });
    expect(first.ok).toBe(true);
    expect(state.beginGrab({ key: secondWork.workKey, token: secondToken, fingerprint: secondWork.missingFingerprint, release: { arr: 'sonarr', indexerId: 8, guid: 'other', infoHash: 'other-hash', releaseTitle: 'Two' }, coverage: [{ workKey: secondWork.workKey, episodeIds: [101], basis: 'explicit-episodes' }], now: NOW, deadline: LATER }).ok).toBe(false);
    expect(state.beginGrab({ key: secondWork.workKey, token: secondToken, fingerprint: secondWork.missingFingerprint, release: { arr: 'sonarr', indexerId: 8, guid: 'shared', infoHash: 'another-hash', releaseTitle: 'Three' }, coverage: [{ workKey: secondWork.workKey, episodeIds: [103], basis: 'explicit-episodes' }], now: NOW, deadline: LATER }).ok).toBe(false);
    expect(state.beginGrab({ key: secondWork.workKey, token: secondToken, fingerprint: secondWork.missingFingerprint, release: { arr: 'sonarr', indexerId: 9, guid: 'different', infoHash: 'shared-hash', releaseTitle: 'Four' }, coverage: [{ workKey: secondWork.workKey, episodeIds: [103], basis: 'explicit-episodes' }], now: NOW, deadline: LATER }).ok).toBe(false);
  });

  it('reserves captured episode IDs across a season-key move even when the new season has a new key', () => {
    const state = State.open(':memory:');
    const first = tvWork('sonarr:4:s1', [101]);
    const firstOwner = claim(state, first.workKey);
    state.applyWorkReconciliation({ key: first.workKey, token: firstOwner, work: first, intentUpdates: [] });
    const captured = state.beginGrab({ key: first.workKey, token: firstOwner, fingerprint: first.missingFingerprint, release: { arr: 'sonarr', indexerId: 2, guid: 'old', infoHash: 'old-hash', releaseTitle: 'Old' }, coverage: [{ workKey: first.workKey, episodeIds: [101], basis: 'explicit-episodes' }], now: NOW, deadline: LATER });
    expect(captured.ok).toBe(true);
    const second = tvWork('sonarr:4:s2', [101]);
    second.unit.key = second.workKey;
    if (second.unit.kind === 'tv' && second.unit.season) second.unit.season.seasonNumber = 2;
    const secondOwner = claim(state, second.workKey);
    state.applyWorkReconciliation({ key: second.workKey, token: secondOwner, work: second, intentUpdates: [] });
    expect(state.beginGrab({ key: second.workKey, token: secondOwner, fingerprint: second.missingFingerprint, release: { arr: 'sonarr', indexerId: 9, guid: 'new', infoHash: 'new-hash', releaseTitle: 'New' }, coverage: [{ workKey: second.workKey, episodeIds: [101], basis: 'explicit-episodes' }], now: NOW, deadline: LATER })).toMatchObject({ ok: false, reason: 'coverage-reserved' });
  });

  it('rejects expired claim mutations using explicit operation clocks', () => {
    const state = State.open(':memory:');
    const work = tvWork();
    const token = claim(state);
    state.applyWorkReconciliation({ key: work.workKey, token, work, intentUpdates: [] });
    const expiredNow = new Date(Date.parse(NOW) + 16 * 60_000).toISOString();
    expect(() => state.startSearch({ key: work.workKey, token, now: expiredNow, recoveryAt: LATER })).toThrow();
    expect(state.beginGrab({ key: work.workKey, token, fingerprint: work.missingFingerprint, release: { arr: 'sonarr', indexerId: 2, guid: 'expired', infoHash: null, releaseTitle: 'Release' }, coverage: [{ workKey: work.workKey, episodeIds: [101], basis: 'explicit-episodes' }], now: expiredNow, deadline: LATER })).toMatchObject({ ok: false, reason: 'claim-not-owned' });
  });

  it('rejects definitive failures without markers and holds uncertain reservations against resubmission', () => {
    const state = State.open(':memory:');
    const work = tvWork();
    const token = claim(state);
    state.applyWorkReconciliation({ key: work.workKey, token, work, intentUpdates: [] });
    const release = { arr: 'sonarr' as const, indexerId: 5, guid: 'failed-guid', infoHash: 'failed-hash', releaseTitle: 'Release' };
    const first = state.beginGrab({ key: work.workKey, token, fingerprint: work.missingFingerprint, release, coverage: [{ workKey: work.workKey, episodeIds: [101], basis: 'explicit-episodes' }], now: NOW, deadline: LATER });
    if (!first.ok) throw new Error('expected reservation');
    const unrelated = tvWork('sonarr:4:s2', [201]);
    unrelated.unit.key = unrelated.workKey;
    const unrelatedToken = claim(state, unrelated.workKey);
    state.applyWorkReconciliation({ key: unrelated.workKey, token: unrelatedToken, work: unrelated, intentUpdates: [] });
    expect(() => state.applyWorkReconciliation({ key: unrelated.workKey, token: unrelatedToken, work: { ...unrelated, lastObservedAt: LATER }, intentUpdates: [{ id: first.intentId, status: 'active' }] })).toThrow(/unrelated/);
    state.rejectGrab({ intentId: first.intentId, ownerToken: token, nextSearchAt: LATER, now: NOW });
    expect(state.getWorkItem(work.workKey)).toMatchObject({ status: 'backoff', nextSearchAt: LATER });
    expect(state.hasHash('failed-hash')).toBe(false);
    expect(state.hasRelease(5, 'failed-guid')).toBe(false);
    const next = state.beginGrab({ key: work.workKey, token, fingerprint: work.missingFingerprint, release: { ...release, guid: 'uncertain-guid', infoHash: 'uncertain-hash' }, coverage: [{ workKey: work.workKey, episodeIds: [101], basis: 'explicit-episodes' }], now: NOW, deadline: LATER });
    if (!next.ok) throw new Error('expected second reservation');
    state.markGrabUncertain({ intentId: next.intentId, ownerToken: token, now: NOW });
    expect(state.beginGrab({ key: work.workKey, token, fingerprint: work.missingFingerprint, release: { ...release, guid: 'other', infoHash: 'other' }, coverage: [{ workKey: work.workKey, episodeIds: [101], basis: 'explicit-episodes' }], now: NOW, deadline: LATER }).ok).toBe(false);
    expect(() => state.rejectGrab({ intentId: next.intentId, ownerToken: token, nextSearchAt: LATER, now: NOW })).toThrow();
  });

  it('exposes only safe scheduling and coverage projection fields', () => {
    const state = State.open(':memory:');
    const work = tvWork();
    state.applyWorkReconciliation({ key: work.workKey, token: claim(state), work, intentUpdates: [] });
    const projection = JSON.stringify(state.getWorkQueueStatus());
    expect(projection).toContain(work.workKey);
    for (const secret of ['unit', 'infoHash', 'guid', 'downloadId', 'http://', 'altTitles']) expect(projection).not.toContain(secret);
  });

  it('accepts empty missing inventory only for terminal work and reports its missing count as zero', () => {
    const state = State.open(':memory:');
    const work = tvWork();
    const firstToken = claim(state);
    state.applyWorkReconciliation({ key: work.workKey, token: firstToken, work, intentUpdates: [] });
    state.releaseClaim(work.workKey, firstToken);
    const terminal = { ...work, unit: { ...work.unit, season: { seasonNumber: 1, missing: [] } }, status: 'fulfilled' as const, missingFingerprint: 'fulfilled-fingerprint' };
    const secondToken = claim(state, work.workKey, LATER);
    state.applyWorkReconciliation({ key: work.workKey, token: secondToken, work: terminal, intentUpdates: [] });
    state.releaseClaim(work.workKey, secondToken);
    expect(state.getWorkQueueStatus().items[0]).toMatchObject({ status: 'fulfilled', missingCount: 0 });
    const invalid = { ...terminal, status: 'ready' as const };
    const thirdToken = claim(state, work.workKey, '2026-01-01T00:10:00.000Z');
    expect(() => state.applyWorkReconciliation({ key: work.workKey, token: thirdToken, work: invalid, intentUpdates: [] })).toThrow(/empty missing inventory/);
  });

  it('retains last successful queue coverage and timestamp while recording the next read as unknown', () => {
    const db = new Database(':memory:');
    const state = new State(db);
    const work = tvWork();
    const firstToken = claim(state);
    state.applyWorkReconciliation({ key: work.workKey, token: firstToken, work, intentUpdates: [] });
    const coverage = [{ workKey: work.workKey, episodeIds: [101], basis: 'explicit-episodes' as const }];
    const failedEventRef = JSON.stringify(['download:failed-once', 101]);
    state.applyWorkQueueObservation({ key: work.workKey, token: firstToken, observedAt: NOW, known: true, coverage, failedQueueRefs: [failedEventRef] });
    state.releaseClaim(work.workKey, firstToken);

    const unknownWork = { ...work, lastObservedAt: LATER, lastQueueObservedAt: NOW, queueObservationKnown: false, blockedReason: 'queue-unknown' };
    const nextToken = claim(state, work.workKey, LATER);
    state.applyWorkReconciliation({ key: work.workKey, token: nextToken, work: unknownWork, intentUpdates: [] });
    state.applyWorkQueueObservation({ key: work.workKey, token: nextToken, observedAt: LATER, known: false, coverage: [] });

    expect(state.getWorkItem(work.workKey)).toMatchObject({ lastQueueObservedAt: NOW, queueObservationKnown: false });
    const reopened = new State(db);
    expect(reopened.getWorkItem(work.workKey)).toMatchObject({ lastQueueObservedAt: NOW, queueObservationKnown: false });
    expect(reopened.listWorkQueueObservations()[0]).toEqual({ workKey: work.workKey, coverage, failedQueueRefs: [failedEventRef], observedAt: NOW, known: false });
    expect(reopened.getWorkQueueStatus().items[0]).toMatchObject({ lastQueueObservedAt: NOW, queueObservationKnown: false, coveredEpisodeIds: [101] });
  });

  it('uses durable observed queue coverage as a beginGrab reservation until a known reconciliation clears it', () => {
    const state = State.open(':memory:');
    const work = tvWork();
    const token = claim(state);
    state.applyWorkReconciliation({ key: work.workKey, token, work, intentUpdates: [] });
    state.applyWorkQueueObservation({ key: work.workKey, token, observedAt: NOW, known: true, coverage: [{ workKey: work.workKey, episodeIds: [101], basis: 'explicit-episodes' }] });
    const grab = { arr: 'sonarr' as const, indexerId: 9, guid: 'new-release', infoHash: 'new-hash', releaseTitle: 'Release' };
    expect(state.beginGrab({ key: work.workKey, token, fingerprint: work.missingFingerprint, release: grab, coverage: [{ workKey: work.workKey, episodeIds: [101], basis: 'explicit-episodes' }], now: NOW, deadline: LATER })).toMatchObject({ ok: false, reason: 'coverage-reserved' });
    state.applyWorkQueueObservation({ key: work.workKey, token, observedAt: LATER, known: true, coverage: [] });
    expect(state.beginGrab({ key: work.workKey, token, fingerprint: work.missingFingerprint, release: grab, coverage: [{ workKey: work.workKey, episodeIds: [101], basis: 'explicit-episodes' }], now: LATER, deadline: '2026-01-01T00:10:00.000Z' }).ok).toBe(true);
  });
});
