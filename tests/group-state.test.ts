import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { State } from '../src/core/state';
import type { WorkItem } from '../src/core/work-queue-types';
import type { ParsedReleaseCoverage } from '../src/core/group-types';

const NOW = '2026-01-01T00:00:00.000Z';
const LATER = '2026-01-01T00:05:00.000Z';

function work(key: string, seasonNumber: number, episodeId: number): WorkItem {
  return {
    workKey: key, contentIdentity: 'sonarr:4:44:tv', missingFingerprint: `fp-${episodeId}`,
    unit: { key, kind: 'tv', arr: 'sonarr', serviceId: 4, externalId: 44, title: 'Show', altTitles: [], season: { seasonNumber, missing: [{ episodeId, episodeNumber: 1, absoluteEpisodeNumber: null, title: `E${episodeId}` }] } },
    status: 'ready', lastSearchAt: null, nextSearchAt: null, failCount: 0, lastOutcome: null,
    lastObservedAt: NOW, lastQueueObservedAt: null, queueObservationKnown: false, blockedReason: null,
  };
}

function setup() {
  const db = new Database(':memory:');
  const state = new State(db);
  const works = [work('sonarr:4:s1', 1, 101), work('sonarr:4:s2', 2, 201)];
  const keys = ['group:sonarr:4', ...works.map((item) => item.workKey)];
  const claims = state.claimUnits({ keys, now: new Date(NOW) });
  if (!claims) throw new Error('group claim unavailable');
  for (const item of works) state.applyWorkReconciliation({ key: item.workKey, token: claims.ownerToken, work: item, intentUpdates: [] });
  return { db, state, works, claims };
}

function multiScopeSetup() {
  const db = new Database(':memory:');
  const state = new State(db);
  const a = {
    ...work('sonarr:4:s1', 1, 101),
    unit: { ...work('sonarr:4:s1', 1, 101).unit, season: { seasonNumber: 1, missing: [
      { episodeId: 101, episodeNumber: 1, absoluteEpisodeNumber: 101, title: 'A1' },
      { episodeId: 102, episodeNumber: 2, absoluteEpisodeNumber: 102, title: 'A2' },
    ] } },
  } satisfies WorkItem;
  const b = {
    ...work('sonarr:5:s1', 1, 201),
    contentIdentity: 'sonarr:5:55:tv',
    unit: { ...work('sonarr:5:s1', 1, 201).unit, serviceId: 5, externalId: 55, key: 'sonarr:5:s1', title: 'Other Show', season: { seasonNumber: 1, missing: [{ episodeId: 201, episodeNumber: 1, absoluteEpisodeNumber: 201, title: 'B1' }] } },
  } satisfies WorkItem;
  const extra = {
    ...work('sonarr:4:s2', 2, 301),
    unit: { ...work('sonarr:4:s2', 2, 301).unit, season: { seasonNumber: 2, missing: [{ episodeId: 301, episodeNumber: 1, absoluteEpisodeNumber: 301, title: 'A season 2' }] } },
  } satisfies WorkItem;
  const works = [a, b, extra];
  const keys = ['group:sonarr:4', 'group:sonarr:5', ...works.map((item) => item.workKey)];
  const claims = state.claimUnits({ keys, now: new Date(NOW) });
  if (!claims) throw new Error('multi-scope claim unavailable');
  for (const item of works) state.applyWorkReconciliation({ key: item.workKey, token: claims.ownerToken, work: item, intentUpdates: [] });
  return { db, state, works, claims };
}

const seasonOneEpisodeOne = { kind: 'claims' as const, seasonClaims: [{ seasonNumber: 1, episodes: [1] }], absoluteEpisodes: null, unqualifiedEpisodes: null, wholeSeries: false };
const seasonOnePack = { kind: 'claims' as const, seasonClaims: [{ seasonNumber: 1, episodes: null }], absoluteEpisodes: null, unqualifiedEpisodes: null, wholeSeries: false };

function beginSingle(state: State, claims: ReturnType<typeof multiScopeSetup>['claims'], workKey: string, episodeId: number, releaseGuid: string, declaredScope: ParsedReleaseCoverage, infoHash = `${releaseGuid}-hash`) {
  const target = state.getWorkItem(workKey)!;
  return state.beginGroupGrab({
    claims, fingerprints: { [workKey]: target.missingFingerprint },
    release: { arr: 'sonarr', indexerId: 4, guid: releaseGuid, infoHash, releaseTitle: releaseGuid },
    coverage: [{ workKey, episodeIds: [episodeId], basis: 'explicit-episodes' }], declaredScope, now: NOW, deadline: LATER,
  });
}

const release = { arr: 'sonarr' as const, indexerId: 4, guid: 'pack', infoHash: 'pack-hash', releaseTitle: 'Show Complete' };
const coverage = [
  { workKey: 'sonarr:4:s1', episodeIds: [101], basis: 'explicit-episodes' as const },
  { workKey: 'sonarr:4:s2', episodeIds: [201], basis: 'explicit-episodes' as const },
];

describe('group claims and immutable multi-work intents', () => {
  it('allows disjoint explicit episode and unrelated-series captures without widening declared scope', () => {
    const { state, claims } = multiScopeSetup();
    expect(beginSingle(state, claims, 'sonarr:4:s1', 101, 'explicit-e1', seasonOneEpisodeOne)).toMatchObject({ ok: true });
    expect(beginSingle(state, claims, 'sonarr:4:s1', 102, 'explicit-e2', { kind: 'none' })).toMatchObject({ ok: true });
    expect(beginSingle(state, claims, 'sonarr:5:s1', 201, 'other-series-e1', { kind: 'none' })).toMatchObject({ ok: true });
  });

  it('permits only proven residual captures under queue-active and active-intent holds', () => {
    const intentCase = multiScopeSetup();
    expect(beginSingle(intentCase.state, intentCase.claims, 'sonarr:4:s1', 101, 'active-e1', { kind: 'none' })).toMatchObject({ ok: true });
    intentCase.state.applyWorkQueueObservation({ key: 'sonarr:4:s1', token: intentCase.claims.ownerToken, observedAt: NOW, known: true, coverage: [] });
    const activeWork = intentCase.state.getWorkItem('sonarr:4:s1')!;
    intentCase.state.applyWorkReconciliation({ key: activeWork.workKey, token: intentCase.claims.ownerToken, work: { ...activeWork, blockedReason: 'active-intent' }, intentUpdates: [] });
    expect(beginSingle(intentCase.state, intentCase.claims, 'sonarr:4:s1', 102, 'active-residual-e2', { kind: 'none' })).toMatchObject({ ok: true });

    const queueCase = multiScopeSetup();
    const queueWork = queueCase.state.getWorkItem('sonarr:4:s1')!;
    queueCase.state.applyWorkQueueObservation({ key: queueWork.workKey, token: queueCase.claims.ownerToken, observedAt: NOW, known: true, coverage: [{ workKey: queueWork.workKey, episodeIds: [101], basis: 'explicit-episodes' }] });
    queueCase.state.applyWorkReconciliation({ key: queueWork.workKey, token: queueCase.claims.ownerToken, work: { ...queueWork, queueObservationKnown: true, blockedReason: 'queue-active' }, intentUpdates: [] });
    expect(beginSingle(queueCase.state, queueCase.claims, 'sonarr:4:s1', 102, 'queue-residual-e2', { kind: 'none' })).toMatchObject({ ok: true });

    const missingEvidence = multiScopeSetup();
    const heldWork = missingEvidence.state.getWorkItem('sonarr:4:s1')!;
    missingEvidence.state.applyWorkReconciliation({ key: heldWork.workKey, token: missingEvidence.claims.ownerToken, work: { ...heldWork, blockedReason: 'queue-active' }, intentUpdates: [] });
    expect(beginSingle(missingEvidence.state, missingEvidence.claims, 'sonarr:4:s1', 102, 'queue-no-proof', { kind: 'none' })).toMatchObject({ ok: false, reason: 'work-held-for-review' });

    const unknownIntentEvidence = multiScopeSetup();
    expect(beginSingle(unknownIntentEvidence.state, unknownIntentEvidence.claims, 'sonarr:4:s1', 101, 'active-unknown-e1', { kind: 'none' })).toMatchObject({ ok: true });
    const unknownIntentWork = unknownIntentEvidence.state.getWorkItem('sonarr:4:s1')!;
    unknownIntentEvidence.state.applyWorkReconciliation({ key: unknownIntentWork.workKey, token: unknownIntentEvidence.claims.ownerToken, work: { ...unknownIntentWork, blockedReason: 'active-intent' }, intentUpdates: [] });
    expect(beginSingle(unknownIntentEvidence.state, unknownIntentEvidence.claims, 'sonarr:4:s1', 102, 'active-unknown-e2', { kind: 'none' })).toMatchObject({ ok: false, reason: 'work-held-for-review' });

    const emptyEvidence = multiScopeSetup();
    const emptyWork = emptyEvidence.state.getWorkItem('sonarr:4:s1')!;
    emptyEvidence.state.applyWorkQueueObservation({ key: emptyWork.workKey, token: emptyEvidence.claims.ownerToken, observedAt: NOW, known: true, coverage: [] });
    emptyEvidence.state.applyWorkReconciliation({ key: emptyWork.workKey, token: emptyEvidence.claims.ownerToken, work: { ...emptyWork, queueObservationKnown: true, blockedReason: 'queue-active' }, intentUpdates: [] });
    expect(beginSingle(emptyEvidence.state, emptyEvidence.claims, 'sonarr:4:s1', 102, 'queue-empty-proof', { kind: 'none' })).toMatchObject({ ok: false, reason: 'work-held-for-review' });
  });

  it('keeps review, unknown, paused, import-blocked, waiting, and non-actionable work hard-held', () => {
    for (const blockedReason of ['queue-unknown', 'queue-ambiguous', 'queue-review', 'content-identity-changed', 'manual-review', 'library-unknown', 'paused', 'import-blocked', 'waiting-release']) {
      const { state, claims } = multiScopeSetup();
      const held = state.getWorkItem('sonarr:4:s1')!;
      state.applyWorkReconciliation({ key: held.workKey, token: claims.ownerToken, work: { ...held, blockedReason }, intentUpdates: [] });
      expect(beginSingle(state, claims, held.workKey, 101, `held-${blockedReason}`, { kind: 'none' }), blockedReason).toMatchObject({ ok: false, reason: 'work-held-for-review' });
    }
    for (const status of ['backoff', 'manual', 'waiting-release'] as const) {
      const { state, claims } = multiScopeSetup();
      const held = state.getWorkItem('sonarr:4:s1')!;
      state.applyWorkReconciliation({ key: held.workKey, token: claims.ownerToken, work: { ...held, status }, intentUpdates: [] });
      expect(beginSingle(state, claims, held.workKey, 101, `status-${status}`, { kind: 'none' }), status).toMatchObject({ ok: false, reason: 'work-not-actionable' });
    }
  });

  it('keeps actual episode, same-source/hash, season-pack, and advertised-extra reservations conservative', () => {
    const explicit = multiScopeSetup();
    expect(beginSingle(explicit.state, explicit.claims, 'sonarr:4:s1', 101, 'same-guid', seasonOneEpisodeOne, 'same-hash')).toMatchObject({ ok: true });
    expect(beginSingle(explicit.state, explicit.claims, 'sonarr:4:s1', 101, 'different-guid', { kind: 'none' }, 'different-hash')).toMatchObject({ ok: false, reason: 'coverage-reserved' });
    expect(beginSingle(explicit.state, explicit.claims, 'sonarr:5:s1', 201, 'same-guid', { kind: 'none' }, 'another-hash')).toMatchObject({ ok: false, reason: 'source-identity-reserved' });
    expect(beginSingle(explicit.state, explicit.claims, 'sonarr:5:s1', 201, 'different-guid', { kind: 'none' }, 'same-hash')).toMatchObject({ ok: false, reason: 'hash-reserved' });

    const seasonPack = multiScopeSetup();
    expect(beginSingle(seasonPack.state, seasonPack.claims, 'sonarr:4:s1', 101, 'season-pack', seasonOnePack)).toMatchObject({ ok: true });
    expect(beginSingle(seasonPack.state, seasonPack.claims, 'sonarr:4:s1', 102, 'pack-overlap', { kind: 'none' })).toMatchObject({ ok: false, reason: 'coverage-reserved' });

    const wholeSeries = multiScopeSetup();
    expect(beginSingle(wholeSeries.state, wholeSeries.claims, 'sonarr:4:s1', 101, 'whole-series', { kind: 'claims', seasonClaims: [], absoluteEpisodes: null, unqualifiedEpisodes: null, wholeSeries: true })).toMatchObject({ ok: true });
    expect(beginSingle(wholeSeries.state, wholeSeries.claims, 'sonarr:4:s2', 301, 'whole-series-overlap', { kind: 'none' })).toMatchObject({ ok: false, reason: 'coverage-reserved' });

    const advertised = multiScopeSetup();
    expect(beginSingle(advertised.state, advertised.claims, 'sonarr:4:s1', 101, 'advertised-extra', {
      kind: 'claims', seasonClaims: [{ seasonNumber: 1, episodes: [1] }, { seasonNumber: 2, episodes: null }], absoluteEpisodes: null, unqualifiedEpisodes: null, wholeSeries: false,
    })).toMatchObject({ ok: true });
    expect(beginSingle(advertised.state, advertised.claims, 'sonarr:4:s2', 301, 'advertised-extra-target', { kind: 'none' })).toMatchObject({ ok: false, reason: 'coverage-reserved' });
  });

  it('cleans up an expired own lease but never deletes a successor lease', () => {
    const { state, claims } = setup();
    expect(() => state.releaseClaims({ keys: claims.keys, ownerToken: claims.ownerToken })).not.toThrow();
    const successor = state.claimUnits({ keys: claims.keys, now: new Date() });
    expect(successor).not.toBeNull();
    expect(successor?.ownerToken).not.toBe(claims.ownerToken);
    expect(() => state.releaseClaims({ keys: claims.keys, ownerToken: claims.ownerToken })).toThrow(/wholly owned/);
    expect(state.claimUnits({ keys: claims.keys, now: new Date() })).toBeNull();
    state.releaseClaims({ keys: successor!.keys, ownerToken: successor!.ownerToken });
  });

  it('claims all keys atomically, uses one owner, and rejects conflicts/expiry without partial ownership', () => {
    const { state, claims } = setup();
    expect(claims.keys).toEqual(['group:sonarr:4', 'sonarr:4:s1', 'sonarr:4:s2']);
    expect(new Set(claims.keys.map((key) => state.claimUnit(key, new Date(NOW)))).size).toBe(1);
    const conflict = state.claimUnit('sonarr:4:s2', new Date(NOW));
    expect(conflict).toBeNull();
    expect(state.claimUnits({ keys: ['fresh-work', 'sonarr:4:s2'], now: new Date(NOW) })).toBeNull();
    expect(state.claimUnit('fresh-work', new Date(NOW))).toBeTypeOf('string');
    expect(() => state.claimUnits({ keys: [''], now: new Date(NOW) })).toThrow(/claim keys/);
    expect(state.renewClaims({ keys: claims.keys, ownerToken: claims.ownerToken, now: new Date(Date.parse(NOW) + 16 * 60_000) })).toBe(false);
  });

  it('records one multi-key intent and one set of physical markers; owner receipt is late-safe and idempotent', () => {
    const { state, works, claims } = setup();
    const result = state.beginGroupGrab({ claims, fingerprints: Object.fromEntries(works.map((item) => [item.workKey, item.missingFingerprint])), release, coverage, declaredScope: { kind: 'claims', seasonClaims: [{ seasonNumber: 1, episodes: null }, { seasonNumber: 2, episodes: null }, { seasonNumber: 3, episodes: null }], absoluteEpisodes: null, unqualifiedEpisodes: null, wholeSeries: false }, now: NOW, deadline: LATER });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    state.markGrabUncertain({ intentId: result.intentId, ownerToken: claims.ownerToken, now: NOW });
    const later = new Date(Date.parse(NOW) + 16 * 60_000);
    const renewed = state.claimUnits({ keys: claims.keys, now: later });
    expect(renewed).not.toBeNull();
    for (const item of works) state.applyWorkReconciliation({ key: item.workKey, token: renewed!.ownerToken, work: { ...item, status: 'cooldown', nextSearchAt: '2026-01-02T00:00:00.000Z' }, intentUpdates: [] });
    state.confirmGrab({ intentId: result.intentId, ownerToken: claims.ownerToken, now: later.toISOString() });
    state.confirmGrab({ intentId: result.intentId, ownerToken: claims.ownerToken, now: later.toISOString() });
    expect(state.listGrabIntents()).toHaveLength(1);
    expect(state.hasHash('pack-hash')).toBe(true);
    expect(state.hasRelease(4, 'pack')).toBe(true);
    expect(state.lastDecisionAt('sonarr:4:s1')).toBe(later.toISOString());
    expect(state.lastDecisionAt('sonarr:4:s2')).toBe(later.toISOString());
    expect(state.getWorkItem('sonarr:4:s1')?.nextSearchAt).toBe('2026-01-02T00:00:00.000Z');
    expect(state.listGrabIntents()[0]?.coverage).toEqual(coverage);
  });

  it('does not let extra declared seasons create captures and rejects stale/partial ownership', () => {
    const { state, works, claims } = setup();
    const extra = { workKey: 'sonarr:4:s3', episodeIds: [301], basis: 'explicit-episodes' as const };
    const args = { claims, fingerprints: Object.fromEntries(works.map((item) => [item.workKey, item.missingFingerprint])), release, coverage: [...coverage, extra], declaredScope: { kind: 'claims' as const, seasonClaims: [{ seasonNumber: 1, episodes: null }, { seasonNumber: 2, episodes: null }, { seasonNumber: 3, episodes: null }], absoluteEpisodes: null, unqualifiedEpisodes: null, wholeSeries: false }, now: NOW, deadline: LATER };
    expect(state.beginGroupGrab(args)).toMatchObject({ ok: false });
    const partial = state.claimUnits({ keys: ['only-one'], now: new Date(NOW) });
    expect(partial).not.toBeNull();
    expect(state.beginGroupGrab({ ...args, claims: partial! })).toMatchObject({ ok: false });
    expect(() => state.claimUnits({ keys: ['x', 'x'], now: new Date(NOW) })).not.toThrow();
  });

  it('reads a legacy single-fingerprint intent from a native pre-group schema after construction and reopen', () => {
    const db = new Database(':memory:');
    db.exec(`CREATE TABLE grab_intents (
      id TEXT PRIMARY KEY, owner_token TEXT NOT NULL, arr TEXT NOT NULL, indexer_id INTEGER NOT NULL, guid TEXT NOT NULL,
      info_hash TEXT, release_title TEXT NOT NULL, coverage_json TEXT NOT NULL, status TEXT NOT NULL, started_at TEXT NOT NULL,
      confirmed_at TEXT, queue_deadline_at TEXT NOT NULL, last_seen_at TEXT, queue_refs_json TEXT NOT NULL, captured_fingerprint TEXT NOT NULL
    );`);
    db.prepare(`INSERT INTO grab_intents VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run('legacy', 'owner', 'sonarr', 4, 'legacy-guid', null, 'Legacy', JSON.stringify([{ workKey: 'sonarr:4:s1', episodeIds: [101], basis: 'explicit-episodes' }]), 'uncertain', NOW, null, LATER, null, '[]', 'legacy-fp');
    const first = new State(db);
    expect(first.listGrabIntents()[0]).toMatchObject({ id: 'legacy', coverage: [{ workKey: 'sonarr:4:s1', episodeIds: [101] }] });
    expect(new State(db).listGrabIntents()).toHaveLength(1);
  });

  it('keeps declared extra-season scope as a potential overlap for future related work, never as captured fulfillment', () => {
    const { state, works, claims } = setup();
    const declaredScope = { kind: 'claims' as const, seasonClaims: [{ seasonNumber: 1, episodes: null }, { seasonNumber: 2, episodes: null }, { seasonNumber: 3, episodes: null }], absoluteEpisodes: null, unqualifiedEpisodes: null, wholeSeries: false };
    const first = state.beginGroupGrab({ claims, fingerprints: Object.fromEntries(works.map((item) => [item.workKey, item.missingFingerprint])), release, coverage, declaredScope, now: NOW, deadline: LATER });
    if (!first.ok) throw new Error('expected group reservation');
    const laterWork = work('sonarr:4:s3', 3, 301);
    const laterOwner = state.claimUnit(laterWork.workKey, new Date(NOW));
    if (!laterOwner) throw new Error('future work lease unavailable');
    state.applyWorkReconciliation({ key: laterWork.workKey, token: laterOwner, work: laterWork, intentUpdates: [] });
    state.releaseClaim(laterWork.workKey, laterOwner);
    const laterClaims = state.claimUnits({ keys: [laterWork.workKey, 'group:sonarr:4'], now: new Date('2026-01-01T00:16:00.000Z') });
    expect(laterClaims).not.toBeNull();
    expect(state.beginGroupGrab({ claims: laterClaims!, fingerprints: { [laterWork.workKey]: laterWork.missingFingerprint }, release: { ...release, guid: 'next', infoHash: 'next-hash' }, coverage: [{ workKey: laterWork.workKey, episodeIds: [301], basis: 'explicit-episodes' }], declaredScope: { kind: 'none' }, now: '2026-01-01T00:16:00.000Z', deadline: '2026-01-01T00:20:00.000Z' })).toMatchObject({ ok: false, reason: 'coverage-reserved' });
    expect(state.listGrabIntents()[0]?.coverage).toEqual(coverage);
  });

  it('rejects a group receipt across each actual capture without writing physical markers', () => {
    const { state, works, claims } = setup();
    const begun = state.beginGroupGrab({ claims, fingerprints: Object.fromEntries(works.map((item) => [item.workKey, item.missingFingerprint])), release, coverage, declaredScope: { kind: 'none' }, now: NOW, deadline: LATER });
    if (!begun.ok) throw new Error('expected group reservation');
    state.rejectGrab({ intentId: begun.intentId, ownerToken: claims.ownerToken, nextSearchAt: LATER, now: NOW });
    expect(state.listGrabIntents()[0]).toMatchObject({ status: 'failed', coverage });
    expect(state.listWorkItems().map((item) => item.status)).toEqual(['backoff', 'backoff']);
    expect(state.hasHash('pack-hash')).toBe(false);
    expect(state.hasRelease(4, 'pack')).toBe(false);
  });
});
