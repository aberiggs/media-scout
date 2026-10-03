import { createHash } from 'node:crypto';
import type { Config } from '../config';
import type { RadarrClient } from '../clients/radarr';
import type { SonarrClient } from '../clients/sonarr';
import { buildAssociationRequests } from './queue-association';
import type { AssociationDecision, AssociationRequest } from './group-types';
import { State, type OperatorClaim, type OperatorObservation } from './state';
import type { QueueReads } from './work-queue';
import type { LibrarySnapshot, Watcher } from './watcher';

const TTL_MS = 120_000;
export type OperatorOperation = 'associate_queue' | 'release_intent_hold';

export interface PreparedOperatorAction {
  reviewId: number;
  operation: OperatorOperation;
  token: string;
  version: number;
  expiresAt: string;
  challenge: string;
  targetNames: string[];
  queuePreview?: { title: string | null; status: string | null };
  associationChoices?: { media: Array<{ index: number; title: string }>; targets: Array<{ index: number; title: string }> };
}

interface FreshReads {
  snapshot: LibrarySnapshot;
  queues: QueueReads;
  observation: OperatorObservation;
}

/**
 * Explicit operator-only recovery lane. It reads the real library and complete *arr queues,
 * but has no search, grab, cycle, or download-client mutation methods.
 */
export class OperatorActions {
  constructor(private readonly deps: {
    enabled: boolean;
    config: Config;
    state: State;
    watcher: Watcher;
    sonarr: SonarrClient;
    radarr: RadarrClient;
    now?: () => Date;
  }) {}

  async prepareReviewAction(input: { reviewId: number; operation: OperatorOperation }): Promise<PreparedOperatorAction> {
    this.assertEnabled();
    const review = this.openReview(input.reviewId);
    const reads = await this.readFresh();
    const now = this.clock().toISOString();
    let claims: OperatorClaim[];
    let targetNames: string[];
    let request: AssociationRequest | null = null;
    if (input.operation === 'release_intent_hold') {
      if (review.subjectKind !== 'intent' || !review.subjectKey) throw new Error('Review is not explicitly linked to an intent');
      const intent = this.deps.state.listGrabIntents().find((candidate) => candidate.id === review.subjectKey);
      if (!intent || intent.releasedAt || intent.confirmedAt !== null || intent.status === 'failed' || intent.status === 'fulfilled' || intent.status === 'active' || intent.status === 'import-blocked') throw new Error('Intent is not eligible for operator release');
      if (Date.parse(now) < Date.parse(intent.queueDeadlineAt)) throw new Error('Intent queue grace deadline has not passed');
      claims = this.claimsFor(this.releaseWorkKeys(intent), reads.observation);
      targetNames = claims.map(({ workKey }) => safeName(workLabel(this.deps.state.getWorkItem(workKey), reads.snapshot)));
      const capturesMissing = intent.coverage.every((capture) => {
        const entry = reads.observation.libraryEvidence.find((candidate) => candidate.workKey === capture.workKey);
        const ids = capture.episodeIds ?? entry?.targetIds ?? [];
        return !!entry && !entry.hasAllFiles && ids.length > 0 && ids.every((id) => entry.targetIds.includes(id) && entry.missingTargetIds.includes(id));
      });
      if (!capturesMissing) throw new Error('Captured targets are no longer positively known missing');
    } else {
      request = this.findAssociationRequest(reads, review.workKey);
      if (!request) throw new Error('No complete, currently associable queue row scopes to this review');
      const targetIndex = request.lookup.workReferencesByIndex.findIndex((ref) => ref.workKey === review.workKey);
      if (targetIndex < 0) throw new Error('Review work is not in the prepared private association lookup');
      claims = this.claimsFor([review.workKey], reads.observation);
      reads.observation.associationEvidence = this.associationEvidence(request);
      targetNames = [safeName(workLabel(this.deps.state.getWorkItem(review.workKey), reads.snapshot))];
    }
    const receipt = this.deps.state.issueOperatorObservation({ operation: input.operation, reviewId: input.reviewId, claims, observation: reads.observation, now });
    return {
      reviewId: input.reviewId,
      operation: input.operation,
      ...receipt,
      targetNames,
      ...(request ? {
        queuePreview: { title: request.queue[0]?.title ?? null, status: request.queue[0]?.status ?? null },
        associationChoices: {
          media: request.media.map(({ mediaIndex, title }) => ({ index: mediaIndex, title })),
          targets: request.targets.filter((_, index) => request.lookup.workReferencesByIndex[index]?.workKey === review.workKey).map(({ targetIndex, title }) => ({ index: targetIndex, title })),
        },
      } : {}),
    };
  }

  async associateQueue(input: { reviewId: number; token: string; proposedAssociation: { mediaIndex: number; targetIndices: number[] }; challengeResponse: string; note: string }): Promise<{ associated: true }> {
    this.assertEnabled();
    const prepared = this.deps.state.peekOperatorObservation({ token: input.token, operation: 'associate_queue', reviewId: input.reviewId, now: this.clock().toISOString() });
    const reads = await this.readFresh();
    const expected = prepared.associationEvidence;
    if (!expected) throw new Error('Prepared action is missing private association evidence');
    const request = this.findAssociationRequest(reads, this.openReview(input.reviewId).workKey, expected.sourceJobKey);
    if (!request || !same(this.associationEvidence(request), expected)) throw new Error('Queue association material changed since prepare');
    const decision = this.makeHumanDecision(request, this.openReview(input.reviewId).workKey, input.proposedAssociation, reads);
    reads.observation.associationEvidence = this.associationEvidence(request);
    const claimKeys = [...new Set(decision.workReferences.map(({ workKey }) => workKey))];
    const keys = this.claimKeys(claimKeys);
    const lease = this.deps.state.claimUnits({ keys, now: this.clock() });
    if (!lease) throw new Error('Operator work is currently claimed by another process');
    try {
      this.deps.state.commitHumanQueueAssociation({ token: input.token, reviewId: input.reviewId, claims: lease, decision, currentObservation: reads.observation, challengeResponse: input.challengeResponse, note: input.note, now: this.clock().toISOString() });
      return { associated: true };
    } finally {
      this.deps.state.releaseClaims({ keys: lease.keys, ownerToken: lease.ownerToken });
    }
  }

  async releaseIntentHold(input: { reviewId: number; token: string; challengeResponse: string; note: string }): Promise<{ released: true }> {
    this.assertEnabled();
    const prepared = this.deps.state.peekOperatorObservation({ token: input.token, operation: 'release_intent_hold', reviewId: input.reviewId, now: this.clock().toISOString() });
    const reads = await this.readFresh();
    if (prepared.associationEvidence) throw new Error('Invalid release observation');
    const review = this.openReview(input.reviewId);
    if (review.subjectKind !== 'intent' || !review.subjectKey) throw new Error('Review is not explicitly linked to an intent');
    const intent = this.deps.state.listGrabIntents().find(({ id }) => id === review.subjectKey);
    if (!intent) throw new Error('Linked intent no longer exists');
    const claimKeys = this.releaseWorkKeys(intent);
    const keys = this.claimKeys(claimKeys);
    const lease = this.deps.state.claimUnits({ keys, now: this.clock() });
    if (!lease) throw new Error('Intent work is currently claimed by another process');
    try {
      this.deps.state.releaseIntentHold({ token: input.token, reviewId: input.reviewId, claims: lease, currentObservation: reads.observation, challengeResponse: input.challengeResponse, note: input.note, now: this.clock().toISOString() });
      return { released: true };
    } finally {
      this.deps.state.releaseClaims({ keys: lease.keys, ownerToken: lease.ownerToken });
    }
  }

  private assertEnabled(): void {
    if (!this.deps.enabled) throw new Error('Operator actions are disabled; enable allowOperatorActions in the web settings first');
  }

  private clock(): Date { return (this.deps.now ?? (() => new Date()))(); }

  private openReview(id: number) {
    const review = this.deps.state.listManualReview(false).find(({ id: rowId }) => rowId === id);
    if (!review) throw new Error('Review row not found or already resolved');
    return review;
  }

  private async readFresh(): Promise<FreshReads> {
    const readStartedAt = this.clock().toISOString();
    const [snapshot, sonarrRecords, radarrRecords] = await Promise.all([
      this.deps.watcher.getSnapshot(),
      this.deps.sonarr.getQueue(),
      this.deps.radarr.getQueue(),
    ]);
    const readCompletedAt = this.clock().toISOString();
    if (!snapshot.sonarr.known || !snapshot.radarr.known || snapshot.sonarr.series.some((entry) => !entry.known || entry.episodes === null)) throw new Error('Complete known library snapshot is required for operator actions');
    const queues: QueueReads = {
      sonarr: { kind: 'known', records: sonarrRecords, observedAt: readCompletedAt },
      radarr: { kind: 'known', records: radarrRecords, observedAt: readCompletedAt },
    };
    const libraryEvidence = this.deps.state.listWorkItems().map((work) => {
      let targetIds: number[];
      if (work.unit.kind === 'tv') {
        const series = snapshot.sonarr.series.find(({ series: item }) => item.id === work.unit.serviceId);
        if (!series) return null;
        if (!series.known || !series.episodes) throw new Error('Affected series episode inventory is unknown');
        targetIds = work.unit.season?.missing.map(({ episodeId }) => episodeId) ?? [];
        const byId = new Map(series.episodes.map((episode) => [episode.id, episode]));
        const missingTargetIds = series.episodes.filter((episode) => episode.seasonNumber === work.unit.season?.seasonNumber && episode.monitored && !episode.hasFile).map(({ id }) => id).sort((a, b) => a - b);
        const allFiles = targetIds.length > 0 && targetIds.every((id) => byId.get(id)?.hasFile === true);
        const contentEvidenceFingerprint = digest(stableJson({ series: series.series, episodes: series.episodes.filter((episode) => episode.seasonNumber === work.unit.season?.seasonNumber) }));
        return { workKey: work.workKey, contentIdentity: work.contentIdentity, missingFingerprint: work.missingFingerprint, contentEvidenceFingerprint, targetIds, missingTargetIds, hasAllFiles: allFiles };
      } else {
        const movie = snapshot.radarr.movies.find(({ id }) => id === work.unit.serviceId);
        if (!movie) return null;
        targetIds = [movie.id];
        const allFiles = movie.hasFile;
        const contentEvidenceFingerprint = digest(stableJson(movie));
        return { workKey: work.workKey, contentIdentity: work.contentIdentity, missingFingerprint: work.missingFingerprint, contentEvidenceFingerprint, targetIds, missingTargetIds: movie.hasFile ? [] : [movie.id], hasAllFiles: allFiles };
      }
    }).filter((entry): entry is NonNullable<typeof entry> => entry !== null);
    const queueEvidence = [
      ...sonarrRecords.map((row) => {
        const knownEpisode = row.episodeId == null ? null : snapshot.sonarr.series.flatMap((series) => series.known ? series.episodes ?? [] : []).find(({ id }) => id === row.episodeId) ?? null;
        return { arr: 'sonarr' as const, ref: row.downloadId?.trim() ? `download:${row.downloadId.trim()}` : row.id !== undefined && row.id !== null ? `row:${row.id}` : null, stableRef: Boolean(row.downloadId?.trim()) || (row.id !== undefined && row.id !== null), title: row.title ?? null, status: row.status ?? null, trackedStatus: row.trackedDownloadStatus ?? null, trackedState: row.trackedDownloadState ?? null, serviceId: row.seriesId ?? knownEpisode?.seriesId ?? null, episodeId: row.episodeId ?? null, seasonNumber: row.seasonNumber ?? knownEpisode?.seasonNumber ?? null };
      }),
      ...radarrRecords.map((row) => ({ arr: 'radarr' as const, ref: row.downloadId?.trim() ? `download:${row.downloadId.trim()}` : row.id !== undefined && row.id !== null ? `row:${row.id}` : null, stableRef: Boolean(row.downloadId?.trim()) || (row.id !== undefined && row.id !== null), title: row.title ?? null, status: row.status ?? null, trackedStatus: row.trackedDownloadStatus ?? null, trackedState: row.trackedDownloadState ?? null, serviceId: row.movieId ?? null, episodeId: null, seasonNumber: null })),
    ];
    const observation: OperatorObservation = {
      sourceConfigFingerprint: this.sourceConfigFingerprint(), readStartedAt, readCompletedAt,
      libraryKnown: { sonarr: true, radarr: true }, queueKnown: { sonarr: true, radarr: true },
      libraryEvidence, queueEvidence,
    };
    if (Date.parse(readCompletedAt) - Date.parse(readStartedAt) > TTL_MS) throw new Error('Operator reads exceeded the observation freshness window');
    return { snapshot, queues, observation };
  }

  private sourceConfigFingerprint(): string {
    const config = this.deps.config;
    return digest(JSON.stringify({
      sonarrUrl: config.SONARR_URL, sonarrKey: digest(config.SONARR_API_KEY),
      radarrUrl: config.RADARR_URL, radarrKey: digest(config.RADARR_API_KEY),
      prowlarrUrl: config.PROWLARR_URL, prowlarrKey: digest(config.PROWLARR_API_KEY),
      tvClient: config.PROWLARR_CLIENT_TV, movieClient: config.PROWLARR_CLIENT_MOVIE,
    }));
  }

  private claimsFor(keys: string[], observation: OperatorObservation): OperatorClaim[] {
    return [...new Set(keys)].sort().map((workKey) => {
      const work = this.deps.state.getWorkItem(workKey);
      const evidence = observation.libraryEvidence.find((entry) => entry.workKey === workKey);
      if (!work || !evidence || work.contentIdentity !== evidence.contentIdentity || work.missingFingerprint !== evidence.missingFingerprint) throw new Error('Operator work state is stale or unavailable');
      return { workKey, contentIdentity: work.contentIdentity, fingerprint: work.missingFingerprint };
    });
  }

  private claimKeys(workKeys: string[]): string[] {
    const keys = [...workKeys];
    for (const workKey of workKeys) {
      const work = this.deps.state.getWorkItem(workKey);
      if (work?.unit.kind === 'tv') keys.push(`group:sonarr:${work.unit.serviceId}`);
    }
    return [...new Set(keys)].sort();
  }

  private releaseWorkKeys(intent: ReturnType<State['listGrabIntents']>[number]): string[] {
    const keys = new Set(intent.coverage.map(({ workKey }) => workKey));
    for (const capture of intent.coverage) {
      if (capture.episodeIds === null) continue;
      const original = this.deps.state.getWorkItem(capture.workKey);
      if (original?.unit.kind !== 'tv') continue;
      const ids = new Set(capture.episodeIds);
      for (const work of this.deps.state.listWorkItems()) {
        if (work.unit.kind === 'tv' && work.unit.arr === original.unit.arr && work.unit.serviceId === original.unit.serviceId && work.unit.season?.missing.some(({ episodeId }) => ids.has(episodeId))) keys.add(work.workKey);
      }
    }
    return [...keys].sort();
  }

  private findAssociationRequest(reads: FreshReads, workKey: string, sourceJobKey?: string): AssociationRequest | null {
    const matches = buildAssociationRequests({ snapshot: reads.snapshot, queues: reads.queues, cache: [] }).filter((request) =>
      (!sourceJobKey || request.sourceJobKey === sourceJobKey) && request.lookup.workReferencesByIndex.some((ref) => ref.workKey === workKey));
    return matches.length === 1 ? matches[0]! : null;
  }

  private associationEvidence(request: AssociationRequest): NonNullable<OperatorObservation['associationEvidence']> {
    return {
      arr: request.arr, sourceJobKey: request.sourceJobKey, materialSignature: request.materialSignature,
      contextSignature: request.contextSignature, promptVersion: request.promptVersion,
      queueRefs: [...request.lookup.queueRefsByIndex],
      mediaReferences: request.lookup.mediaReferencesByIndex.map((ref) => ({ ...ref })),
      workReferences: request.lookup.workReferencesByIndex.map((ref) => ({ ...ref })),
    };
  }

  private makeHumanDecision(request: AssociationRequest, reviewKey: string, proposed: { mediaIndex: number; targetIndices: number[] }, reads: FreshReads): AssociationDecision {
    if (!Number.isSafeInteger(proposed.mediaIndex) || proposed.mediaIndex < 0 || proposed.mediaIndex >= request.media.length || !Array.isArray(proposed.targetIndices) || proposed.targetIndices.length === 0 || new Set(proposed.targetIndices).size !== proposed.targetIndices.length) throw new Error('Invalid proposed association indices');
    const mediaRef = request.lookup.mediaReferencesByIndex[proposed.mediaIndex];
    if (!mediaRef || mediaRef.arr !== request.arr) throw new Error('Proposed media index is outside the prepared lookup');
    const queueRef = request.lookup.queueRefsByIndex[0];
    const observedQueue = reads.observation.queueEvidence.find((row) => row.arr === request.arr && row.ref === queueRef);
    if (!queueRef || !observedQueue) throw new Error('Prepared queue row is absent from current trusted evidence');
    if (observedQueue.serviceId !== null && observedQueue.serviceId !== mediaRef.serviceId) throw new Error('Proposed media contradicts a known provider service id');
    if (request.arr === 'sonarr' && observedQueue.episodeId !== null) {
      const episode = reads.snapshot.sonarr.series.flatMap((entry) => entry.known ? entry.episodes ?? [] : []).find(({ id }) => id === observedQueue.episodeId);
      if (!episode || episode.seriesId !== mediaRef.serviceId || (observedQueue.seasonNumber !== null && episode.seasonNumber !== observedQueue.seasonNumber)) throw new Error('Proposed media contradicts known episode or season ids');
    }
    const targetRefs = proposed.targetIndices.map((index) => {
      if (!Number.isSafeInteger(index) || index < 0 || index >= request.lookup.workReferencesByIndex.length) throw new Error('Proposed target index is outside the prepared lookup');
      const ref = request.lookup.workReferencesByIndex[index]!;
      const unit = request.lookup.workUnitsByIndex[index]!;
      if (ref.workKey !== reviewKey || ref.arr !== mediaRef.arr || ref.serviceId !== mediaRef.serviceId || ref.externalId !== mediaRef.externalId || unit.key !== ref.workKey) throw new Error('Proposed target contradicts the prepared media/work lookup');
      return ref;
    });
    const queueEvidenceRef = request.lookup.queueRefsByIndex[0];
    if (!queueEvidenceRef || request.queue.length !== 1) throw new Error('Prepared association is not one exact queue job');
    return {
      arr: request.arr, queueRef: queueEvidenceRef, outcome: 'matched', mediaReferences: [mediaRef], workReferences: targetRefs,
      // Human association establishes initial media scope, never episode coverage or remote-job provenance.
      potentialScope: request.arr === 'radarr' ? 'movie' : 'series', seasonNumber: null,
      episodeIds: null, basis: null, uncertainty: 'human association; episode coverage and submission provenance remain unverified',
    };
  }

}

function same(left: unknown, right: unknown): boolean { return stableJson(left) === stableJson(right); }
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}
function digest(value: string): string { return createHash('sha256').update(value).digest('hex'); }
function workLabel(work: ReturnType<State['getWorkItem']>, snapshot: LibrarySnapshot): string {
  if (!work) return 'Work item';
  const title = work.unit.kind === 'tv'
    ? snapshot.sonarr.series.find(({ series }) => series.id === work.unit.serviceId)?.series.title ?? work.unit.title
    : snapshot.radarr.movies.find(({ id }) => id === work.unit.serviceId)?.title ?? work.unit.title;
  return work.unit.kind === 'tv' ? `${title} — Season ${work.unit.season?.seasonNumber ?? 'unknown'}` : title;
}
function safeName(value: string): string {
  return value.replace(/\b[a-z][a-z\d+.-]{1,15}:\/\/\S+/giu, '[URL]').replace(/magnet:\?\S+/giu, '[URL]')
    .replace(/(?:^|[\s("'=])\/(?:[^/\s]+\/)+[^/\s]+/gu, ' [PATH]').replace(/[A-Za-z]:\\(?:[^\\\s]+\\)*[^\\\s]+/gu, '[PATH]')
    .replace(/\b(?:[\da-f]{64}|[\da-f]{40}|[\da-f]{32})\b/giu, '[HASH]').replace(/[\u0000-\u001f\u007f]/gu, ' ').replace(/\s+/gu, ' ').trim().slice(0, 120);
}
