import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { State, type OperatorObservation } from '../src/core/state';
import type { WorkItem } from '../src/core/work-queue-types';

const NOW = '2026-01-01T00:00:00.000Z';
const DEADLINE = '2026-01-01T00:30:00.000Z';
const REVIEW_TIME = '2026-01-01T00:31:00.000Z';
const RELEASE_CHALLENGE = 'I inspected the download client(s), including routing used at submission; no matching download is active, and I authorize releasing this reservation so retries may become eligible.';

function movie(): WorkItem {
  return {
    workKey: 'radarr:1', contentIdentity: 'radarr:1:tmdb:2:movie', missingFingerprint: 'movie-fingerprint',
    unit: { key: 'radarr:1', kind: 'movie', arr: 'radarr', serviceId: 1, externalId: 2, title: 'Movie', year: 2020, altTitles: [] },
    status: 'ready', lastSearchAt: null, nextSearchAt: null, failCount: 0, lastOutcome: null,
    lastObservedAt: NOW, lastQueueObservedAt: null, queueObservationKnown: false, blockedReason: null,
  };
}

function evidence(overrides: Partial<OperatorObservation> = {}): OperatorObservation {
  return {
    sourceConfigFingerprint: 'private-config-fingerprint', readStartedAt: REVIEW_TIME, readCompletedAt: REVIEW_TIME,
    libraryKnown: { sonarr: true, radarr: true }, queueKnown: { sonarr: true, radarr: true },
    libraryEvidence: [{ workKey: 'radarr:1', contentIdentity: movie().contentIdentity, missingFingerprint: movie().missingFingerprint, contentEvidenceFingerprint: 'fresh-movie-evidence', targetIds: [1], missingTargetIds: [1], hasAllFiles: false }],
    queueEvidence: [], ...overrides,
  };
}

function stateWithMovie(state = new State(new Database(':memory:')), keepOriginalClaim = false, timing = { start: NOW, deadline: DEADLINE, review: REVIEW_TIME }): { state: State; work: WorkItem; intentId: string; reviewId: number; originalOwnerToken: string } {
  const work = movie();
  const claims = state.claimUnits({ keys: [work.workKey], now: new Date(timing.start) })!;
  state.applyWorkReconciliation({ key: work.workKey, token: claims.ownerToken, work, intentUpdates: [] });
  const grabbed = state.beginGrab({ key: work.workKey, token: claims.ownerToken, fingerprint: work.missingFingerprint, release: { arr: 'radarr', indexerId: 3, guid: 'release-guid', infoHash: null, releaseTitle: 'Movie.2020' }, coverage: [{ workKey: work.workKey, episodeIds: null, basis: null }], now: timing.start, deadline: timing.deadline });
  if (!grabbed.ok) throw new Error(grabbed.reason);
  state.markGrabUncertain({ intentId: grabbed.intentId, ownerToken: claims.ownerToken, now: timing.start });
  if (!keepOriginalClaim) state.releaseClaims({ keys: claims.keys, ownerToken: claims.ownerToken });
  state.flagManualReviewLinked({ workKey: work.workKey, reason: 'queue-review', intentId: grabbed.intentId, at: new Date(timing.review) });
  return { state, work, intentId: grabbed.intentId, reviewId: state.listManualReview()[0]!.id, originalOwnerToken: claims.ownerToken };
}

describe('operator observation state boundary', () => {
  it('requires complete fresh reads and linked, currently missing captures before minting a release token', () => {
    const { state, work, reviewId } = stateWithMovie();
    const claim = [{ workKey: work.workKey, contentIdentity: work.contentIdentity, fingerprint: work.missingFingerprint }];
    expect(() => state.issueOperatorObservation({ operation: 'release_intent_hold', reviewId, claims: claim, observation: evidence({ queueKnown: { sonarr: true, radarr: false } }), now: REVIEW_TIME })).toThrow(/complete known/);
    expect(() => state.issueOperatorObservation({ operation: 'release_intent_hold', reviewId, claims: claim, observation: evidence({ libraryEvidence: [{ ...evidence().libraryEvidence[0]!, hasAllFiles: true, missingTargetIds: [] }] }), now: REVIEW_TIME })).toThrow(/positively known missing/);
    expect(() => state.issueOperatorObservation({ operation: 'release_intent_hold', reviewId, claims: claim, observation: evidence(), now: '2026-01-01T00:33:00.000Z' })).toThrow(/fresh/);
    expect(() => state.issueOperatorObservation({ operation: 'release_intent_hold', reviewId, claims: claim, observation: evidence({ readStartedAt: NOW, readCompletedAt: NOW }), now: NOW })).toThrow(/not releasable/);
  });

  it('releases without rewriting the original intent and atomically consumes the proof once', () => {
    const { state, work, intentId, reviewId } = stateWithMovie();
    const intentBefore = state.listGrabIntents()[0]!;
    const receipt = state.issueOperatorObservation({ operation: 'release_intent_hold', reviewId, claims: [{ workKey: work.workKey, contentIdentity: work.contentIdentity, fingerprint: work.missingFingerprint }], observation: evidence(), now: REVIEW_TIME });
    expect(() => state.peekOperatorObservation({ token: receipt.token, operation: 'associate_queue', reviewId, now: REVIEW_TIME })).toThrow(/mismatched/);
    expect(() => state.peekOperatorObservation({ token: receipt.token, operation: 'release_intent_hold', reviewId: reviewId + 100, now: REVIEW_TIME })).toThrow(/mismatched/);
    expect(() => state.peekOperatorObservation({ token: receipt.token, operation: 'release_intent_hold', reviewId, now: '2026-01-01T00:33:00.000Z' })).toThrow(/expired/);
    const lease = state.claimUnits({ keys: [work.workKey], now: new Date(REVIEW_TIME) })!;
    const commit = { token: receipt.token, reviewId, claims: lease, currentObservation: evidence(), challengeResponse: RELEASE_CHALLENGE, note: 'Inspected tracked and client queues', now: REVIEW_TIME };
    state.releaseIntentHold(commit);
    expect(state.listGrabIntents()[0]).toMatchObject({ id: intentId, status: 'uncertain', confirmedAt: null, releasedAt: REVIEW_TIME, releaseNote: 'Inspected tracked and client queues', coverage: intentBefore.coverage, queueRefs: intentBefore.queueRefs });
    expect(state.getWorkQueueStatus().openIntentCount).toBe(0);
    expect(state.listManualReview(true)[0]?.resolvedAt).toBe(REVIEW_TIME);
    expect(() => state.releaseIntentHold(commit)).toThrow(/consumed/);
    state.releaseClaims({ keys: lease.keys, ownerToken: lease.ownerToken });
    const retryLease = state.claimUnit(work.workKey, new Date(REVIEW_TIME))!;
    expect(state.beginGrab({ key: work.workKey, token: retryLease, fingerprint: work.missingFingerprint, release: { arr: 'radarr', indexerId: 3, guid: 'retry-guid', infoHash: 'retry-hash', releaseTitle: 'Movie.2020.retry' }, coverage: [{ workKey: work.workKey, episodeIds: null, basis: null }], now: REVIEW_TIME, deadline: '2026-01-01T01:00:00.000Z' })).toMatchObject({ ok: true });
  });

  it('rejects wrong challenge, changed queue evidence, changed durable state, wrong subject, and replay without consuming on failure', () => {
    const { state, work, reviewId } = stateWithMovie();
    const receipt = state.issueOperatorObservation({ operation: 'release_intent_hold', reviewId, claims: [{ workKey: work.workKey, contentIdentity: work.contentIdentity, fingerprint: work.missingFingerprint }], observation: evidence(), now: REVIEW_TIME });
    const lease = state.claimUnits({ keys: [work.workKey], now: new Date(REVIEW_TIME) })!;
    const base = { token: receipt.token, reviewId, claims: lease, currentObservation: evidence(), note: 'manual client inspection complete', now: REVIEW_TIME };
    expect(() => state.releaseIntentHold({ ...base, challengeResponse: 'yes' })).toThrow(/challenge/);
    expect(() => state.releaseIntentHold({ ...base, currentObservation: evidence({ queueEvidence: [{ arr: 'radarr', ref: 'download:new', stableRef: true, title: 'Movie', status: 'downloading', trackedStatus: null, trackedState: 'downloading', serviceId: 1, episodeId: null, seasonNumber: null }] }), challengeResponse: RELEASE_CHALLENGE })).toThrow(/changed/);
    const changed = { ...work, lastOutcome: 'new durable state' };
    state.applyWorkReconciliation({ key: work.workKey, token: lease.ownerToken, work: changed, intentUpdates: [] });
    expect(() => state.releaseIntentHold({ ...base, challengeResponse: RELEASE_CHALLENGE })).toThrow(/Durable state changed/);
    expect(state.listGrabIntents()[0]?.releasedAt).toBeUndefined();
    state.releaseClaims({ keys: lease.keys, ownerToken: lease.ownerToken });
  });

  it('refuses a live original owner and a paused or unassociated possible queue conflict', () => {
    const liveAt = '2026-01-01T00:06:00.000Z';
    const { state, work, reviewId, originalOwnerToken } = stateWithMovie(new State(new Database(':memory:')), true, { start: NOW, deadline: '2026-01-01T00:05:00.000Z', review: liveAt });
    expect(() => state.issueOperatorObservation({ operation: 'release_intent_hold', reviewId, claims: [{ workKey: work.workKey, contentIdentity: work.contentIdentity, fingerprint: work.missingFingerprint }], observation: evidence({ readStartedAt: liveAt, readCompletedAt: liveAt }), now: liveAt })).toThrow(/live processing owner/);
    state.releaseClaim(work.workKey, originalOwnerToken);

    const paused = evidence({ queueEvidence: [{ arr: 'radarr', ref: 'download:paused', stableRef: true, title: 'Movie', status: 'paused', trackedStatus: null, trackedState: 'queued', serviceId: 1, episodeId: null, seasonNumber: null }] });
    const receipt = state.issueOperatorObservation({ operation: 'release_intent_hold', reviewId, claims: [{ workKey: work.workKey, contentIdentity: work.contentIdentity, fingerprint: work.missingFingerprint }], observation: paused, now: REVIEW_TIME });
    const lease = state.claimUnit(work.workKey, new Date(REVIEW_TIME))!;
    expect(() => state.releaseIntentHold({ token: receipt.token, reviewId, claims: { ownerToken: lease, keys: [work.workKey] }, currentObservation: paused, challengeResponse: RELEASE_CHALLENGE, note: 'paused job remains', now: REVIEW_TIME })).toThrow(/queue row may conflict/);
    state.releaseClaim(work.workKey, lease);
  });

  it('does not permit release of an import-blocked/confirmed intent', () => {
    const { state, work, intentId, reviewId } = stateWithMovie();
    const owner = state.claimUnit(work.workKey, new Date(REVIEW_TIME))!;
    state.applyWorkReconciliation({ key: work.workKey, token: owner, work, intentUpdates: [{ id: intentId, status: 'import-blocked' }] });
    state.releaseClaim(work.workKey, owner);
    expect(() => state.issueOperatorObservation({ operation: 'release_intent_hold', reviewId, claims: [{ workKey: work.workKey, contentIdentity: work.contentIdentity, fingerprint: work.missingFingerprint }], observation: evidence(), now: REVIEW_TIME })).toThrow(/not releasable/);
  });

  it('commits only prepared association decisions and prevents a same-signature LLM cache overwrite', () => {
    const state = new State(new Database(':memory:'));
    const work = movie();
    const owner = state.claimUnit(work.workKey, new Date(NOW))!;
    state.applyWorkReconciliation({ key: work.workKey, token: owner, work, intentUpdates: [] });
    state.releaseClaim(work.workKey, owner);
    state.flagManualReview(work.workKey, 'queue-review', undefined, new Date(REVIEW_TIME));
    const reviewId = state.listManualReview()[0]!.id;
    const observation = evidence({
      queueEvidence: [{ arr: 'radarr', ref: 'download:job-1', stableRef: true, title: 'Movie.2020', status: 'downloading', trackedStatus: null, trackedState: 'downloading', serviceId: null, episodeId: null, seasonNumber: null }],
      associationEvidence: {
        arr: 'radarr', sourceJobKey: 'radarr:download:job-1', materialSignature: 'material', contextSignature: 'context', promptVersion: 'v1',
        queueRefs: ['download:job-1'], mediaReferences: [{ arr: 'radarr', serviceId: 1, externalId: 2 }],
        workReferences: [{ workKey: work.workKey, arr: 'radarr', serviceId: 1, externalId: 2, seasonNumber: null }],
      },
    });
    const receipt = state.issueOperatorObservation({ operation: 'associate_queue', reviewId, claims: [{ workKey: work.workKey, contentIdentity: work.contentIdentity, fingerprint: work.missingFingerprint }], observation, now: REVIEW_TIME });
    const lease = state.claimUnits({ keys: [work.workKey], now: new Date(REVIEW_TIME) })!;
    const decision = { arr: 'radarr' as const, queueRef: 'download:job-1', outcome: 'matched' as const, mediaReferences: [{ arr: 'radarr' as const, serviceId: 1, externalId: 2 }], workReferences: [{ workKey: work.workKey, arr: 'radarr' as const, serviceId: 1, externalId: 2, seasonNumber: null }], potentialScope: 'movie' as const, seasonNumber: null, episodeIds: null, basis: null, uncertainty: 'human-reviewed' };
    state.commitHumanQueueAssociation({ token: receipt.token, reviewId, claims: lease, decision, currentObservation: observation, challengeResponse: receipt.challenge, note: 'Matched to supplied movie', now: REVIEW_TIME });
    expect(state.listAssociationCache()[0]?.decisions[0]?.outcome).toBe('matched');
    const assocLease = state.claimUnit('association:radarr', new Date(REVIEW_TIME))!;
    state.putAssociationCache({ leaseKey: 'association:radarr', ownerToken: assocLease, now: REVIEW_TIME, entry: { arr: 'radarr', sourceJobKey: 'radarr:download:job-1', materialSignature: 'material', contextSignature: 'context', promptVersion: 'v1', cachedAt: REVIEW_TIME, decisions: [{ ...decision, outcome: 'unrelated', mediaReferences: [], workReferences: [], potentialScope: 'unknown', seasonNumber: null, episodeIds: null, basis: null, uncertainty: null }] } });
    expect(state.listAssociationCache()[0]?.decisions[0]?.outcome).toBe('matched');
  });

  it('persists migrations, audit and consumed proof atomically across a native SQLite reopen', () => {
    const directory = mkdtempSync(join(tmpdir(), 'media-agent-operator-'));
    const filename = join(directory, 'state.sqlite');
    const db = new Database(filename);
    try {
      const { state, work, intentId, reviewId } = stateWithMovie(new State(db));
      const receipt = state.issueOperatorObservation({ operation: 'release_intent_hold', reviewId, claims: [{ workKey: work.workKey, contentIdentity: work.contentIdentity, fingerprint: work.missingFingerprint }], observation: evidence(), now: REVIEW_TIME });
      const lease = state.claimUnits({ keys: [work.workKey], now: new Date(REVIEW_TIME) })!;
      state.releaseIntentHold({ token: receipt.token, reviewId, claims: lease, currentObservation: evidence(), challengeResponse: RELEASE_CHALLENGE, note: 'Native reopen audit note', now: REVIEW_TIME });
      db.close();
      const reopenedDb = new Database(filename);
      const reopened = new State(reopenedDb);
      expect(reopened.listGrabIntents()[0]).toMatchObject({ id: intentId, status: 'uncertain', releasedAt: REVIEW_TIME, releaseNote: 'Native reopen audit note' });
      expect(reopened.listManualReview(true)[0]?.resolvedAt).toBe(REVIEW_TIME);
      const tokenDigest = createHash('sha256').update(receipt.token).digest('hex');
      const consumed = reopenedDb.prepare('SELECT consumed_at FROM operator_observations WHERE token_digest=?').get(tokenDigest) as { consumed_at: string } | undefined;
      expect(consumed?.consumed_at).toBe(REVIEW_TIME);
      expect(reopenedDb.prepare('SELECT operation,note FROM operator_audit').get()).toMatchObject({ operation: 'release_intent_hold', note: 'Native reopen audit note' });
      reopenedDb.close();
    } finally {
      if (db.open) db.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
