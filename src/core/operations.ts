import type { State, WorkAction } from './state';
import type { IntentCoverage, WorkItem, WorkStatus } from './work-queue-types';

const STATUSES: WorkStatus[] = ['ready', 'waiting-release', 'searching', 'cooldown', 'backoff', 'manual', 'fulfilled', 'inactive'];
const RETRY_REASONS = new Set(['picker-manual', 'no-suitable-release', 'repeated-operation-failure', 'missing-download-client', 'reverify-failed', 'unparseable-title']);
const SAFE_HOLDS = new Set(['queue-unknown', 'queue-active', 'queue-ambiguous', 'active-intent', 'waiting-release', 'manual-review', 'content-identity-changed', 'queue-review', 'library-unknown']);

export interface Page<T> { items: T[]; total: number }
export interface WorkRow {
  workKey: string; title: string; mediaType: 'movie' | 'tv'; season?: number; status: WorkStatus; missingCount: number;
  nextSearchAt: string | null; lastSearchAt: string | null; holdReason: string | null; observedAt: string | null;
  queueObservationKnown: boolean; queueObservedAt: string | null;
  observationState: 'known' | 'unknown' | 'stale'; coverage: { observed: number; reserved: number };
  actions: Record<WorkAction, { allowed: boolean; reason?: string }>;
}
export interface ReviewRow {
  id: number; workKey: string; title: string; reason: string; summary: string; createdAt: string; resolvedAt: string | null;
  actions: { retry: { allowed: boolean; reason?: string }; reset: { allowed: boolean; reason?: string }; associate: { allowed: boolean; reason?: string }; release: { allowed: boolean; reason?: string } };
}

export class OperationsDashboard {
  constructor(private readonly state: State, private readonly now: () => Date = () => new Date()) {}

  work(input: { status?: string; q?: string; limit: number; offset: number }): Page<WorkRow> & { counts: Record<string, number>; openReviewCount: number; generatedAt: string } {
    const work = this.state.listWorkItems();
    const workByKey = new Map(work.map((item) => [item.workKey, item]));
    const persistedQueue = this.state.listWorkQueueObservations();
    const reservations = this.state.listGrabIntents().filter((intent) => !intent.releasedAt && !['failed', 'fulfilled'].includes(intent.status));
    const visibleWork = work.filter((item) => !item.resetPendingAt);
    const allRows = visibleWork.map((item): WorkRow => {
      const action = this.state.getWorkActionEligibility(item.workKey);
      const observationState = !item.queueObservationKnown || item.blockedReason === 'library-unknown' ? 'unknown' :
        Date.parse(this.now().toISOString()) - Date.parse(item.lastObservedAt) > 24 * 60 * 60_000 ||
          (item.lastQueueObservedAt !== null && Date.parse(this.now().toISOString()) - Date.parse(item.lastQueueObservedAt) > 24 * 60 * 60_000) ? 'stale' : 'known';
      const observedIds = new Set(persistedQueue.flatMap((observation) => observation.coverage.flatMap((coverage) => coverageTargets(coverage, item, workByKey))));
      const reservedIds = new Set(reservations.flatMap((intent) => intent.coverage.flatMap((coverage) => coverageTargets(coverage, item, workByKey))));
      const movie = item.unit.kind === 'movie';
      return {
        workKey: item.workKey, title: safeTitle(item.unit.title), mediaType: item.unit.kind, ...(item.unit.kind === 'tv' ? { season: item.unit.season?.seasonNumber } : {}),
        status: item.status, missingCount: item.status === 'fulfilled' || item.status === 'inactive' ? 0 : movie ? 1 : item.unit.season?.missing.length ?? 0,
        nextSearchAt: item.nextSearchAt, lastSearchAt: item.lastSearchAt, holdReason: item.blockedReason === null ? null : SAFE_HOLDS.has(item.blockedReason) ? item.blockedReason : 'blocked',
        observedAt: item.lastObservedAt, queueObservationKnown: item.queueObservationKnown, queueObservedAt: item.lastQueueObservedAt, observationState,
        coverage: { observed: observedIds.size, reserved: reservedIds.size }, actions: action,
      };
    });
    const counts: Record<string, number> = Object.fromEntries(STATUSES.map((status) => [status, 0]));
    for (const item of allRows) counts[item.status] = (counts[item.status] ?? 0) + 1;
    const query = input.q?.toLocaleLowerCase() ?? '';
    const rows = allRows.filter((item) => (!input.status || item.status === input.status) && (!query || `${item.workKey} ${item.title}`.toLocaleLowerCase().includes(query)));
    return { items: rows.slice(input.offset, input.offset + input.limit), total: rows.length, counts, openReviewCount: this.state.listManualReview(false).length, generatedAt: this.now().toISOString() };
  }

  reviews(input: { resolved: boolean; q?: string; limit: number; offset: number }, operatorEnabled: boolean): Page<ReviewRow> & { generatedAt: string } {
    const rows = this.state.listManualReview(input.resolved).filter((review) => {
      if (!input.resolved && review.resolvedAt !== null) return false;
      if (input.resolved && review.resolvedAt === null) return false;
      const query = input.q?.toLocaleLowerCase();
      if (!query) return true;
      const title = this.state.getWorkItem(review.workKey)?.unit.title ?? review.workKey;
      return `${review.workKey} ${title} ${review.reason}`.toLocaleLowerCase().includes(query);
    });
    const projected = rows.map((review): ReviewRow => {
      const work = this.state.getWorkItem(review.workKey);
      const ordinary = RETRY_REASONS.has(review.reason);
      const actions = this.state.getWorkActionEligibility(review.workKey);
      const canAssociate = operatorEnabled && review.resolvedAt === null && review.reason === 'queue-review';
      const linkedIntent = review.subjectKind === 'intent' && review.subjectKey
        ? this.state.listGrabIntents().find(({ id }) => id === review.subjectKey) : undefined;
      const canRelease = operatorEnabled && review.resolvedAt === null && !!linkedIntent && !linkedIntent.releasedAt &&
        linkedIntent.confirmedAt === null && !['failed', 'fulfilled', 'active', 'import-blocked'].includes(linkedIntent.status) &&
        Date.parse(this.now().toISOString()) >= Date.parse(linkedIntent.queueDeadlineAt);
      return {
        id: review.id, workKey: review.workKey, title: safeTitle(work?.unit.title ?? review.workKey), reason: safeReason(review.reason),
        summary: reviewSummary(review.reason), createdAt: review.createdAt, resolvedAt: review.resolvedAt,
        actions: {
          retry: review.resolvedAt === null && ordinary ? actions.retry : { allowed: false, reason: ordinary ? 'review-resolved' : 'review-not-eligible' },
          reset: review.resolvedAt === null && ordinary ? actions.reset : { allowed: false, reason: ordinary ? 'review-resolved' : 'review-not-eligible' },
          associate: canAssociate ? { allowed: true } : { allowed: false, reason: operatorEnabled ? 'action-not-eligible' : 'operator-actions-disabled' },
          release: canRelease ? { allowed: true } : { allowed: false, reason: operatorEnabled ? 'action-not-eligible' : 'operator-actions-disabled' },
        },
      };
    });
    return { items: projected.slice(input.offset, input.offset + input.limit), total: projected.length, generatedAt: this.now().toISOString() };
  }
}

function coverageTargets(coverage: IntentCoverage, target: WorkItem, workByKey: Map<string, WorkItem>): string[] {
  const source = workByKey.get(coverage.workKey);
  if (!source || source.unit.arr !== target.unit.arr || source.unit.serviceId !== target.unit.serviceId) return [];
  if (target.unit.kind === 'movie') return coverage.episodeIds === null ? ['movie'] : [];
  if (source.unit.kind !== 'tv' || coverage.episodeIds === null) return [];
  const currentIds = new Set(target.unit.season?.missing.map(({ episodeId }) => episodeId) ?? []);
  return coverage.episodeIds.filter((id) => currentIds.has(id)).map(String);
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
