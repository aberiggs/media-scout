import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { State, type OperatorObservation } from '../src/core/state';
import type { WorkItem } from '../src/core/work-queue-types';
import type { ParsedReleaseCoverage } from '../src/core/group-types';

const NOW = '2026-01-01T00:00:00.000Z';
const DEADLINE = '2026-01-01T00:30:00.000Z';
const REVIEW = '2026-01-01T00:31:00.000Z';
const RELEASE_CHALLENGE = 'I inspected the download client(s), including routing used at submission; no matching download is active, and I authorize releasing this reservation so retries may become eligible.';
const episodeScope = (episode: number): ParsedReleaseCoverage => ({
  kind: 'claims', seasonClaims: [{ seasonNumber: 1, episodes: [episode] }], absoluteEpisodes: null, unqualifiedEpisodes: null, wholeSeries: false,
});

function tvWork(): WorkItem {
  return {
    workKey: 'sonarr:4:s1', contentIdentity: 'sonarr:4:44:tv', missingFingerprint: 'tv-fingerprint',
    unit: { key: 'sonarr:4:s1', kind: 'tv', arr: 'sonarr', serviceId: 4, externalId: 44, title: 'Show', altTitles: [], season: { seasonNumber: 1, missing: [
      { episodeId: 101, episodeNumber: 1, absoluteEpisodeNumber: 101, title: 'E1' },
      { episodeId: 102, episodeNumber: 2, absoluteEpisodeNumber: 102, title: 'E2' },
    ] } },
    status: 'ready', lastSearchAt: null, nextSearchAt: null, failCount: 0, lastOutcome: null,
    lastObservedAt: NOW, lastQueueObservedAt: null, queueObservationKnown: true, blockedReason: null,
  };
}

function operatorEvidence(queueEvidence: OperatorObservation['queueEvidence'] = [], works: WorkItem[] = [tvWork()]): OperatorObservation {
  return {
    sourceConfigFingerprint: 'private-config-fingerprint', readStartedAt: REVIEW, readCompletedAt: REVIEW,
    libraryKnown: { sonarr: true, radarr: true }, queueKnown: { sonarr: true, radarr: true },
    libraryEvidence: works.map((work) => ({ workKey: work.workKey, contentIdentity: work.contentIdentity, missingFingerprint: work.missingFingerprint, contentEvidenceFingerprint: `fresh-${work.workKey}`, targetIds: work.unit.season?.missing.map(({ episodeId }) => episodeId) ?? [], missingTargetIds: work.unit.season?.missing.map(({ episodeId }) => episodeId) ?? [], hasAllFiles: false })),
    queueEvidence,
  };
}

function prepareTwoSeasonRelease(queueEvidence: OperatorObservation['queueEvidence'], captureOrder: number[] = [101, 201]) {
  const state = new State(new Database(':memory:'));
  const works = [
    { ...tvWork(), workKey: 'sonarr:4:s1', unit: tvWork().unit, missingFingerprint: 'fp-s1' },
    { ...tvWork(), workKey: 'sonarr:4:s2', unit: { ...tvWork().unit, key: 'sonarr:4:s2', season: { seasonNumber: 2, missing: [{ episodeId: 201, episodeNumber: 1, absoluteEpisodeNumber: 201, title: 'S2E1' }] } }, missingFingerprint: 'fp-s2' },
  ] satisfies WorkItem[];
  const coverage = captureOrder.map((episodeId) => ({
    workKey: episodeId === 101 ? works[0]!.workKey : works[1]!.workKey,
    episodeIds: [episodeId], basis: 'explicit-episodes' as const,
  }));
  const claims = state.claimUnits({ keys: ['group:sonarr:4', ...works.map((work) => work.workKey)], now: new Date(NOW) })!;
  for (const work of works) state.applyWorkReconciliation({ key: work.workKey, token: claims.ownerToken, work, intentUpdates: [] });
  const result = state.beginGroupGrab({
    claims, fingerprints: Object.fromEntries(works.map((work) => [work.workKey, work.missingFingerprint])),
    release: { arr: 'sonarr', indexerId: 4, guid: 'two-season-pack', infoHash: 'two-season-hash', releaseTitle: 'Show S01 S02' }, coverage,
    declaredScope: { kind: 'none' }, now: NOW, deadline: DEADLINE,
  });
  if (!result.ok) throw new Error(`could not prepare grouped intent: ${result.reason}`);
  state.markGrabUncertain({ intentId: result.intentId, ownerToken: claims.ownerToken, now: NOW });
  state.releaseClaims({ keys: claims.keys, ownerToken: claims.ownerToken });
  state.flagManualReviewLinked({ workKey: works[0]!.workKey, reason: 'queue-review', intentId: result.intentId, at: new Date(REVIEW) });
  const reviewId = state.listManualReview()[0]!.id;
  const evidence = operatorEvidence(queueEvidence, works);
  const receipt = state.issueOperatorObservation({ reviewId, operation: 'release_intent_hold', claims: works.map((work) => ({ workKey: work.workKey, contentIdentity: work.contentIdentity, fingerprint: work.missingFingerprint })), observation: evidence, now: REVIEW });
  const lease = state.claimUnits({ keys: ['group:sonarr:4', ...works.map((work) => work.workKey)], now: new Date(REVIEW) })!;
  return { state, evidence, receipt, lease, reviewId, intentId: result.intentId };
}

describe('Gate2 State release and scoped reservation regressions', () => {
  it('treats S01 queue conflict existentially across either capture order', () => {
    const activeS1 = [{ arr: 'sonarr' as const, ref: 'download:s1', stableRef: true, title: 'Show S01', status: 'downloading', trackedStatus: null, trackedState: 'downloading', serviceId: 4, episodeId: null, seasonNumber: 1 }];
    for (const captureOrder of [[101, 201], [201, 101]]) {
      const test = prepareTwoSeasonRelease(activeS1, captureOrder);
      expect(() => test.state.releaseIntentHold({
        token: test.receipt.token, reviewId: test.reviewId, claims: test.lease, currentObservation: test.evidence,
        challengeResponse: RELEASE_CHALLENGE, note: 'review queue overlap', now: REVIEW,
      })).toThrow(/queue row may conflict/);
    }
  });

  it.each([
    { label: 'importBlocked with tracked error and unknown identity', trackedStatus: 'error', trackedState: 'importBlocked', serviceId: null },
    { label: 'ignored with unknown identity', trackedStatus: null, trackedState: 'ignored', serviceId: null },
  ])('does not release on $label', ({ trackedStatus, trackedState, serviceId }) => {
    const queueRow = { arr: 'sonarr' as const, ref: null, stableRef: false, title: 'unassociated job', status: 'queued', trackedStatus, trackedState, serviceId, episodeId: null, seasonNumber: null };
    const test = prepareTwoSeasonRelease([queueRow]);
    expect(() => test.state.releaseIntentHold({
      token: test.receipt.token, reviewId: test.reviewId, claims: test.lease, currentObservation: test.evidence,
      challengeResponse: RELEASE_CHALLENGE, note: 'unknown queue row', now: REVIEW,
    })).toThrow(/queue row may conflict/);
  });

  it.each([
    { label: 'status=failed', status: 'failed', trackedState: 'importBlocked' },
    { label: 'trackedState=failed', status: 'queued', trackedState: 'failed' },
  ])('allows a release past definitive $label only', ({ status, trackedState }) => {
    const row = { arr: 'sonarr' as const, ref: null, stableRef: false, title: 'failed job', status, trackedStatus: 'error', trackedState, serviceId: null, episodeId: null, seasonNumber: null };
    const test = prepareTwoSeasonRelease([row]);
    expect(() => test.state.releaseIntentHold({
      token: test.receipt.token, reviewId: test.reviewId, claims: test.lease, currentObservation: test.evidence,
      challengeResponse: RELEASE_CHALLENGE, note: 'definitive queue failure', now: REVIEW,
    })).not.toThrow();
  });

  it('allows release when an earlier explicit episode scope does not cover the other captured episode', () => {
    const db = new Database(':memory:');
    const state = new State(db);
    const work = tvWork();
    const claims = state.claimUnits({ keys: ['group:sonarr:4', work.workKey], now: new Date(NOW) })!;
    state.applyWorkReconciliation({ key: work.workKey, token: claims.ownerToken, work, intentUpdates: [] });
    const reserve = (guid: string, episodeId: number, scope: ParsedReleaseCoverage) => state.beginGroupGrab({
      claims, fingerprints: { [work.workKey]: work.missingFingerprint },
      release: { arr: 'sonarr', indexerId: 4, guid, infoHash: `${guid}-hash`, releaseTitle: guid },
      coverage: [{ workKey: work.workKey, episodeIds: [episodeId], basis: 'explicit-episodes' }], declaredScope: scope, now: NOW, deadline: DEADLINE,
    });
    const prior = reserve('prior-e1', 101, { kind: 'none' });
    if (!prior.ok) throw new Error(prior.reason);
    const current = reserve('current-e2', 102, { kind: 'none' });
    if (!current.ok) throw new Error(current.reason);
    // Model legacy durable state where an earlier admission allowed this disjoint pair.
    db.prepare('UPDATE grab_intents SET declared_scope_json=? WHERE id=?').run(JSON.stringify(episodeScope(1)), prior.intentId);
    state.markGrabUncertain({ intentId: current.intentId, ownerToken: claims.ownerToken, now: NOW });
    state.releaseClaims({ keys: claims.keys, ownerToken: claims.ownerToken });
    state.flagManualReviewLinked({ workKey: work.workKey, reason: 'queue-review', intentId: current.intentId, at: new Date(REVIEW) });
    const reviewId = state.listManualReview()[0]!.id;
    const evidence = operatorEvidence();
    const receipt = state.issueOperatorObservation({ reviewId, operation: 'release_intent_hold', claims: [{ workKey: work.workKey, contentIdentity: work.contentIdentity, fingerprint: work.missingFingerprint }], observation: evidence, now: REVIEW });
    const lease = state.claimUnits({ keys: ['group:sonarr:4', work.workKey], now: new Date(REVIEW) })!;
    expect(() => state.releaseIntentHold({ token: receipt.token, reviewId, claims: lease, currentObservation: evidence, challengeResponse: RELEASE_CHALLENGE, note: 'exact disjoint capture', now: REVIEW })).not.toThrow();
  });
});
