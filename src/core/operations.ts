import { WORK_OBSERVATION_STALE_AFTER_MS, type ManualReviewRow, type PersistedQueueObservation, type State, type WorkAction } from './state';
import type { GrabIntent, IntentCoverage, WorkItem, WorkStatus } from './work-queue-types';
import { projectEpisodes, type EpisodeSummary, type EpisodeRow } from './episode-progress-view';
export type { EpisodeSummary, EpisodeRow } from './episode-progress-view';

const STATUSES: WorkStatus[] = ['ready', 'waiting-release', 'searching', 'cooldown', 'backoff', 'manual', 'fulfilled', 'inactive'];
const RETRY_REASONS = new Set(['picker-manual', 'no-suitable-release', 'repeated-operation-failure', 'missing-download-client', 'reverify-failed', 'unparseable-title']);
const SAFE_HOLDS = new Set(['queue-unknown', 'queue-active', 'queue-ambiguous', 'active-intent', 'waiting-release', 'manual-review', 'content-identity-changed', 'queue-review', 'library-unknown']);

export interface Page<T> { items: T[]; total: number }
export type OperationsScope = 'active' | 'all';
export interface WorkRow {
  workKey: string; title: string; mediaType: 'movie' | 'tv'; season?: number; status: WorkStatus; missingCount: number;
  nextSearchAt: string | null; lastSearchAt: string | null; holdReason: string | null; observedAt: string | null;
  queueObservationKnown: boolean; queueObservedAt: string | null;
  observationState: 'known' | 'unknown' | 'stale'; coverage: { observed: number; reserved: number };
  actions: Record<WorkAction, { allowed: boolean; reason?: string }>;
  attentionRequired?: boolean; availability?: 'waiting-release' | 'available' | 'unknown';
  episodeProgress?: EpisodeSummary;
}
export interface ReviewRow {
  id: number; workKey: string; title: string; mediaType: 'movie' | 'tv' | 'unknown'; season?: number; reason: string; summary: string; createdAt: string; resolvedAt: string | null;
  actions: { retry: { allowed: boolean; reason?: string }; reset: { allowed: boolean; reason?: string }; associate: { allowed: boolean; reason?: string; requiresAssessment?: true }; release: { allowed: boolean; reason?: string } };
}
export interface ReviewGroup extends ReviewRow { reviews: ReviewRow[]; availability: 'waiting-release' | 'available' | 'unknown'; workStatus: WorkStatus | null }
const TERMINAL_STATUSES = new Set<WorkStatus>(['fulfilled', 'inactive']);

export class OperationsDashboard {
  constructor(private readonly state: State, private readonly now: () => Date = () => new Date()) {}

  work(input: { status?: string; q?: string; scope?: OperationsScope; limit: number; offset: number }, operatorEnabled: boolean, responseNow: Date = this.now()): Page<WorkRow> & { counts: Record<string, number>; openReviewCount: number; generatedAt: string; scope: OperationsScope; countScope: OperationsScope; freshness: { staleAfterHours: number } } {
    const safeNow = Number.isFinite(responseNow.getTime()) ? responseNow : new Date();
    const nowMs = safeNow.getTime();
    const generatedAt = safeNow.toISOString();
    const now = generatedAt;
    const work = this.state.listWorkItems();
    const workByKey = new Map(work.map((item) => [item.workKey, item]));
    const persistedQueue = this.state.listWorkQueueObservations();
    const reservations = this.state.listGrabIntents().filter((intent) => !intent.releasedAt && !['failed', 'fulfilled'].includes(intent.status));
    const episodeRows = this.state.listEpisodeProgress();
    const reviews = this.state.listManualReview(false);
    const blocking = blockingReviewKeys(reviews);
    const requestedScope = input.scope ?? 'active';
    const countScope: OperationsScope = requestedScope === 'all' || (input.status !== undefined && TERMINAL_STATUSES.has(input.status as WorkStatus)) ? 'all' : 'active';
    const visibleWork = work.filter((item) => !item.resetPendingAt && (countScope === 'all' || !TERMINAL_STATUSES.has(item.status)));
    const counts: Record<string, number> = Object.fromEntries(STATUSES.map((status) => [status, 0]));
    for (const item of visibleWork) counts[item.status] = (counts[item.status] ?? 0) + 1;
    const query = input.q?.toLocaleLowerCase() ?? '';
    const rows = visibleWork.filter((item) => {
      if (input.status && item.status !== input.status) return false;
      return !query || `${item.workKey} ${safeTitle(item.unit.title)}`.toLocaleLowerCase().includes(query);
    });
    const page = rows.slice(input.offset, input.offset + input.limit);
    const projected = page.map((item): WorkRow => {
      const action = operatorEnabled
        ? this.state.getWorkActionEligibility(item.workKey, now)
        : this.withOperatorGate({ retry: { allowed: false }, reset: { allowed: false } }, false);
      const observationState = observationFreshness(item, nowMs);
      const observedIds = new Set(persistedQueue.flatMap((observation) => observation.coverage.flatMap((coverage) => coverageTargets(coverage, item, workByKey))));
      const reservedIds = new Set(reservations.flatMap((intent) => intent.coverage.flatMap((coverage) => coverageTargets(coverage, item, workByKey))));
      const movie = item.unit.kind === 'movie';
      const episodeProgress = movie ? undefined : projectEpisodes({ work: item, episodes: episodeRows, now: nowMs,
        knowledge: observationState, ...episodeCoverage(item, workByKey, persistedQueue, reservations),
        blockingReview: blocking.has(item.workKey), safeTitle }).summary;
      return {
        workKey: item.workKey, title: safeTitle(item.unit.title), mediaType: item.unit.kind, ...(item.unit.kind === 'tv' ? { season: item.unit.season?.seasonNumber } : {}),
        status: item.status, attentionRequired: blocking.has(item.workKey), availability: availabilityFor(item, observationState, episodeProgress), missingCount: item.status === 'fulfilled' || item.status === 'inactive' ? 0 : movie ? 1 : item.unit.season?.missing.length ?? 0,
        nextSearchAt: item.nextSearchAt, lastSearchAt: item.lastSearchAt, holdReason: item.blockedReason === null ? null : SAFE_HOLDS.has(item.blockedReason) ? item.blockedReason : 'blocked',
        observedAt: item.lastObservedAt, queueObservationKnown: item.queueObservationKnown, queueObservedAt: item.lastQueueObservedAt, observationState,
        coverage: { observed: observedIds.size, reserved: reservedIds.size }, actions: action,
        ...(episodeProgress ? { episodeProgress } : {}),
      };
    });
    return {
      items: projected, total: rows.length, counts,
      openReviewCount: new Set(reviews.map(({ workKey }) => workKey)).size, generatedAt, scope: requestedScope, countScope,
      freshness: { staleAfterHours: WORK_OBSERVATION_STALE_AFTER_MS / 3_600_000 },
    };
  }

  episodes(workKey: string, limit: number, offset: number, responseNow: Date = this.now()): { workKey: string; items: EpisodeRow[]; total: number; generatedAt: string; summary: EpisodeSummary } | null {
    const work = this.state.getWorkItem(workKey);
    if (!work || work.unit.kind !== 'tv') return null;
    const now = Number.isFinite(responseNow.getTime()) ? responseNow : new Date();
    const workByKey = new Map(this.state.listWorkItems().map((item) => [item.workKey, item]));
    const reservations = this.state.listGrabIntents().filter((intent) => !intent.releasedAt && !['failed', 'fulfilled'].includes(intent.status));
    const { items, summary } = projectEpisodes({ work, episodes: this.state.listEpisodeProgress(workKey), now: now.getTime(),
      knowledge: observationFreshness(work, now.getTime()), ...episodeCoverage(work, workByKey, this.state.listWorkQueueObservations(), reservations),
      blockingReview: blockingReviewKeys(this.state.listManualReview(false)).has(workKey), safeTitle });
    return { workKey, items: items.slice(offset, offset + limit), total: items.length, generatedAt: now.toISOString(), summary };
  }

  reviews(input: { resolved: boolean; q?: string; limit: number; offset: number; grouped?: boolean }, operatorEnabled: boolean, responseNow: Date = this.now()): Page<ReviewRow | ReviewGroup> & { generatedAt: string } {
    const safeNow = Number.isFinite(responseNow.getTime()) ? responseNow : new Date();
    const nowMs = safeNow.getTime();
    const now = safeNow.toISOString();
    const sourceRows = this.state.listManualReview(input.resolved).filter((review) => {
      if (!input.resolved && review.resolvedAt !== null) return false;
      if (input.resolved && review.resolvedAt === null) return false;
      return true;
    });
    const intents = this.state.listGrabIntents();
    const matches = (review: typeof sourceRows[number]) => {
      const query = input.q?.toLocaleLowerCase();
      const title = this.state.getWorkItem(review.workKey)?.unit.title ?? review.workKey;
      return !query || `${review.workKey} ${title} ${review.reason}`.toLocaleLowerCase().includes(query);
    };
    const groups = new Map<string, typeof sourceRows>();
    if (input.grouped) for (const review of sourceRows) {
      const group = groups.get(review.workKey) ?? [];
      group.push(review);
      groups.set(review.workKey, group);
    }
    const rows = input.grouped ? [...groups.values()].filter((group) => group.some(matches)) : sourceRows.filter(matches);
    const page = rows.slice(input.offset, input.offset + input.limit);
    const eligibility = new Map<string, ReturnType<State['getWorkActionEligibility']>>();
    const workActions = (workKey: string) => {
      if (!eligibility.has(workKey)) eligibility.set(workKey, this.state.getWorkActionEligibility(workKey, now));
      return eligibility.get(workKey)!;
    };
    const project = (review: typeof sourceRows[number], grouped = false): ReviewRow => {
      const work = this.state.getWorkItem(review.workKey);
      const ordinary = RETRY_REASONS.has(review.reason);
      const canRetryOrReset = operatorEnabled && review.resolvedAt === null;
      const actions = canRetryOrReset ? workActions(review.workKey) : undefined;
      const canAssociate = operatorEnabled && review.resolvedAt === null && review.reason === 'queue-review' && !['queue-disappeared','intent-unresolved'].includes(review.queueEvidence?.cause ?? '');
      const linkedIntent = review.subjectKind === 'intent' && review.subjectKey
        ? intents.find(({ id }) => id === review.subjectKey) : undefined;
      const canRelease = operatorEnabled && review.resolvedAt === null && !!linkedIntent && !linkedIntent.releasedAt &&
        linkedIntent.confirmedAt === null && !['failed', 'fulfilled', 'active', 'import-blocked'].includes(linkedIntent.status) &&
        nowMs >= Date.parse(linkedIntent.queueDeadlineAt);
      const optOut = { allowed: false, reason: 'operator-actions-disabled' } as const;
      return {
        id: review.id, workKey: review.workKey, title: safeTitle(work?.unit.title ?? review.workKey),
        mediaType: work?.unit.kind ?? 'unknown', ...(work?.unit.kind === 'tv' ? { season: work.unit.season?.seasonNumber } : {}), reason: safeReason(review.reason),
        summary: grouped ? queueReviewSummary(review) : reviewSummary(review.reason), createdAt: review.createdAt, resolvedAt: review.resolvedAt,
        actions: {
          retry: !operatorEnabled ? optOut : canRetryOrReset && ordinary ? actions!.retry : { allowed: false, reason: ordinary ? 'review-resolved' : 'review-not-eligible' },
          reset: !operatorEnabled ? optOut : canRetryOrReset ? actions!.reset : { allowed: false, reason: 'review-resolved' },
          associate: canAssociate ? { allowed: true } : { allowed: false, reason: operatorEnabled ? 'action-not-eligible' : 'operator-actions-disabled' },
          release: canRelease ? { allowed: true } : { allowed: false, reason: operatorEnabled ? 'action-not-eligible' : 'operator-actions-disabled' },
        },
      };
    };
    const projected = input.grouped ? (page as typeof sourceRows[]).map((group): ReviewGroup => {
      const reviews = group.map((review) => project(review, true)).map((row) => row.actions.associate.allowed ? { ...row, actions: { ...row.actions, associate: { allowed: true, requiresAssessment: true as const } } } : row);
      const primary = reviews[0]!;
      const work = this.state.getWorkItem(primary.workKey);
      const episodeSummary = work?.unit.kind === 'tv' ? this.episodes(work.workKey, 1, 0, safeNow)?.summary : undefined;
      const actions = operatorEnabled && !input.resolved ? workActions(primary.workKey) : undefined;
      return { ...primary, ...(actions ? { actions: { ...primary.actions, ...actions } } : {}), reviews, workStatus: work?.status ?? null,
        availability: work ? availabilityFor(work, observationFreshness(work, nowMs), episodeSummary) : 'unknown' };
    }) : (page as typeof sourceRows[number][]).map((review) => project(review));
    return { items: projected, total: rows.length, generatedAt: safeNow.toISOString() };
  }

  private withOperatorGate(actions: Record<WorkAction, { allowed: boolean; reason?: string }>, enabled: boolean): Record<WorkAction, { allowed: boolean; reason?: string }> {
    if (enabled) return actions;
    return Object.fromEntries((['retry', 'reset'] as const).map((action) => [action, { allowed: false, reason: 'operator-actions-disabled' }])) as Record<WorkAction, { allowed: boolean; reason?: string }>;
  }
}

function observationFreshness(work: WorkItem, nowMs: number): WorkRow['observationState'] {
  if (!work.queueObservationKnown || work.lastQueueObservedAt === null || ['library-unknown', 'queue-unknown'].includes(work.blockedReason ?? '')) return 'unknown';
  const libraryAt = Date.parse(work.lastObservedAt);
  const queueAt = Date.parse(work.lastQueueObservedAt);
  if (![nowMs, libraryAt, queueAt].every(Number.isFinite) || libraryAt > nowMs || queueAt > nowMs) return 'unknown';
  return nowMs - libraryAt > WORK_OBSERVATION_STALE_AFTER_MS || nowMs - queueAt > WORK_OBSERVATION_STALE_AFTER_MS ? 'stale' : 'known';
}

function coverageTargets(coverage: IntentCoverage, target: WorkItem, workByKey: Map<string, WorkItem>): string[] {
  const source = workByKey.get(coverage.workKey);
  if (!source || source.unit.arr !== target.unit.arr || source.unit.serviceId !== target.unit.serviceId) return [];
  if (target.unit.kind === 'movie') return coverage.episodeIds === null ? ['movie'] : [];
  if (source.unit.kind !== 'tv' || coverage.episodeIds === null) return [];
  const currentIds = new Set(target.unit.season?.missing.map(({ episodeId }) => episodeId) ?? []);
  return coverage.episodeIds.filter((id) => currentIds.has(id)).map(String);
}
function episodeCoverage(work: WorkItem, workByKey: Map<string, WorkItem>, observations: PersistedQueueObservation[], reservations: GrabIntent[]) {
  return {
    observed: new Set(observations.flatMap((observation) => observation.coverage.flatMap((coverage) => coverageTargets(coverage, work, workByKey)))),
    reserved: new Set(reservations.flatMap((intent) => intent.coverage.flatMap((coverage) => coverageTargets(coverage, work, workByKey)))),
    uncertain: new Set(reservations.filter((intent) => ['uncertain', 'import-blocked'].includes(intent.status))
      .flatMap((intent) => intent.coverage.flatMap((coverage) => coverageTargets(coverage, work, workByKey)))),
  };
}
function blockingReviewKeys(reviews: Array<{ workKey: string; reason: string }>): Set<string> {
  return new Set(reviews.filter((review) => ['picker-manual', 'missing-download-client', 'reverify-failed', 'queue-review',
    'content-identity-changed', 'no-suitable-release', 'repeated-operation-failure'].includes(review.reason)).map((review) => review.workKey));
}
function availabilityFor(work: WorkItem, knowledge: WorkRow['observationState'], episodes?: EpisodeSummary): 'waiting-release' | 'available' | 'unknown' {
  if (knowledge !== 'known') return 'unknown';
  if (work.unit.kind === 'movie') {
    try {
      const fingerprint: unknown = JSON.parse(work.missingFingerprint);
      if (Array.isArray(fingerprint) && fingerprint[0] === work.contentIdentity && Array.isArray(fingerprint[1]) && fingerprint[1].length === 1) {
        const target = fingerprint[1][0];
        if (Array.isArray(target) && target[0] === work.unit.serviceId && typeof target[1] === 'boolean') return target[1] ? 'available' : 'waiting-release';
      }
    } catch { /* Legacy or corrupt availability is unknown, never inferred from status. */ }
  } else if (episodes?.knowledge === 'known' && episodes.counts) {
    if (episodes.counts.airedMissing > 0) return 'available';
    if (episodes.counts.future > 0) return 'waiting-release';
  }
  return 'unknown';
}

function queueReviewSummary(review: ManualReviewRow): string {
  if (review.reason !== 'queue-review') return reviewSummary(review.reason);
  if (review.queueEvidenceInvalid || !review.queueEvidence) return 'An older download review has no saved cause. Reset this item to reassess.';
  switch (review.queueEvidence.cause) {
    case 'queue-disappeared': return 'A previously tracked download is no longer visible; import is not confirmed.';
    case 'intent-unresolved': return 'A submitted download could not be confirmed.';
    case 'queue-ambiguous': return 'A download could not be matched safely to this item.';
  }
}

function safeTitle(value: string): string {
  return value.replace(/\b[a-z][a-z\d+.-]{1,15}:\/\/\S+/giu, '[URL]').replace(/magnet:\?\S+/giu, '[URL]')
    .replace(/(?:^|[\s("'=])\/(?:[^/\s]+\/)+[^/\s]+/gu, ' [PATH]').replace(/\b[A-Za-z]:\\(?:[^\\\s]+\\)*[^\\\s]+/gu, '[PATH]').replace(/\b(?:[\da-f]{64}|[\da-f]{40}|[\da-f]{32})\b/giu, '[HASH]')
    .replace(/[\u0000-\u001f\u007f]/gu, ' ').replace(/\s+/gu, ' ').trim().slice(0, 120);
}
function safeReason(reason: string): string { return /^[a-z-]{1,60}$/u.test(reason) ? reason : 'other'; }
function reviewSummary(reason: string): string {
  const summaries: Record<string, string> = {
    'picker-manual': 'A human decision is required for this work item.', 'no-suitable-release': 'No suitable release was found.',
    'repeated-operation-failure': 'Repeated operation failures require review.', 'missing-download-client': 'A configured download client is unavailable.',
    'reverify-failed': 'The selected release did not pass final verification.', 'unparseable-title': 'A release title could not be safely interpreted.',
    'queue-review': 'Queue coverage requires operator review.', 'content-identity-changed': 'Library identity changed and requires review.',
  };
  return summaries[reason] ?? 'This item requires operator review.';
}
