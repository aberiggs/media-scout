import { randomUUID } from 'node:crypto';
import type { SearchStore } from './store';
import type { ArrSnapshot, ArrTarget } from './arr';
import type { ArrObserver } from './arr';
import type { SearchLimits, SearchResult } from './service';
import type { SubmissionResult, SubmissionServerContext } from './submission';
import type { SearchRequest, SubmissionRequest } from './contracts';
import type { SearchServerContext } from './service';
import { safeText } from './service';

const MINUTE = 60_000;
const POLL_INTERVAL = 5 * MINUTE;
const ORDINARY_RETRY = 30 * MINUTE;
const SUBMISSION_GRACE = 30 * MINUTE;
const FAILURE_MIN = 5 * MINUTE;
const FAILURE_MAX = 60 * MINUTE;
const EXCLUSION = 24 * 60 * MINUTE;

export interface AutomationSearch { run(raw: SearchRequest, limits?: SearchLimits, signal?: AbortSignal, server?: SearchServerContext): Promise<SearchResult> }
export interface AutomationSubmit { submit(raw: SubmissionRequest, serverContext?: SubmissionServerContext): Promise<SubmissionResult> }
export interface AutomationPolicy { enabled: boolean; dryRun: boolean; preferences?: string; queueGraceMinutes?: number; searchRetryMinutes?: number; failureBackoffMinMinutes?: number; failureBackoffMaxMinutes?: number }
export interface ArrAutomationDependencies {
  store: SearchStore; observer: Pick<ArrObserver, 'observe' | 'validateTarget'> & Partial<Pick<ArrObserver, 'sourceFingerprint'>>; search: AutomationSearch; submission: AutomationSubmit;
  getPolicy(): AutomationPolicy; clock?: () => number;
}
export interface AutomationPass { observedAt: number; ran: boolean; reason?: string; targetKey?: string; search?: SearchResult; submission?: SubmissionResult; nextAttemptAt?: number }

/** One episode-first target per explicitly invoked pass. Never imports legacy work state. */
export class ArrAutomation {
  private lastPoll = 0;
  constructor(private readonly deps: ArrAutomationDependencies) {}

  async runPass(signal?: AbortSignal): Promise<AutomationPass> {
    const now = (this.deps.clock ?? Date.now)(), policy = this.deps.getPolicy();
    const ordinaryRetry = (policy.searchRetryMinutes ?? 30) * MINUTE;
    const failureDelay = (failures: number) => Math.min((policy.failureBackoffMaxMinutes ?? 60) * MINUTE, (policy.failureBackoffMinMinutes ?? 5) * MINUTE * 2 ** (failures - 1));
    if (!policy.enabled) return { observedAt: now, ran: false, reason: 'disabled' };
    if (now - this.lastPoll < POLL_INTERVAL) return { observedAt: now, ran: false, reason: 'poll-interval' };
    this.lastPoll = now;
    const snapshot: ArrSnapshot = await this.deps.observer.observe();
    this.reconcileReceipts(snapshot, now);
    const availableProviders = new Set<ArrTarget['provider']>();
    if (snapshot.sonarr.known) availableProviders.add('sonarr');
    if (snapshot.radarr.known) availableProviders.add('radarr');
    const due = snapshot.targets.filter(t => t.eligible && availableProviders.has(t.provider)).filter(t => {
      const state = this.deps.store.getAutomationAttempt(t.key);
      return (!state || state.deadline <= now && state.graceUntil <= now) &&
        (this.deps.store.getGrace('target', t.key, now) ?? 0) <= now &&
        (this.deps.store.getDeadline(t.key) ?? 0) <= now &&
        ['prowlarr', 'model', t.provider].every(provider => (this.deps.store.getProviderDeadline(provider) ?? 0) <= now);
    }).sort((a,b) => {
      const aa = this.deps.store.getAutomationAttempt(a.key)?.lastAttempt ?? 0;
      const ba = this.deps.store.getAutomationAttempt(b.key)?.lastAttempt ?? 0;
      return aa-ba || (a.airAt ?? 0)-(b.airAt ?? 0) || a.key.localeCompare(b.key);
    });
    const target = due[0];
    if (!target) return { observedAt: now, ran: false, reason: 'nothing-due' };
    const prior = this.deps.store.getAutomationAttempt(target.key);
    this.deps.store.setAutomationAttempt(target.key, { lastAttempt: now, failCount: prior?.failCount ?? 0, deadline: now, graceUntil: prior?.graceUntil ?? 0, physicalKey: prior?.physicalKey });
    if (signal?.aborted) return { observedAt: now, ran: false, reason: 'cancelled', targetKey: target.key };
    try {
      const title = safeText(String(target.context.title ?? 'this item'));
      const episodeTitle = safeText(String(target.context.episodeTitle ?? ''));
      const search = await this.deps.search.run({ prompt: `Find ${title}${episodeTitle ? ` — ${episodeTitle}` : ''}${target.provider === 'sonarr' ? ` S${String(target.context.seasonNumber).padStart(2,'0')}E${String(target.context.episodeNumber).padStart(2,'0')}` : ''}`, ...(policy.preferences?.trim() ? { preferences: { notes: safeText(policy.preferences).slice(0,2000) } } : {}), context: {
        kind: target.provider === 'sonarr' ? 'tv' : 'movie', titles: Array.isArray(target.context.titles) ? target.context.titles.map(s => safeText(String(s))) : [title],
        ...(typeof target.context.year === 'number' ? { year: target.context.year } : {}), externalIds: target.provider === 'sonarr' ? { tvdb: target.externalId } : { tmdb: target.externalId },
        scope: target.provider === 'sonarr' ? { type: 'episode', seasonNumber: target.context.seasonNumber as number, episodeNumber: target.context.episodeNumber as number, ...(typeof target.context.absoluteEpisodeNumber === 'number' ? { absoluteEpisodeNumber: target.context.absoluteEpisodeNumber } : {}) } : { type: 'movie' },
        targets: [{ targetId: target.key, ...(target.provider === 'sonarr' ? { seasonNumber: target.context.seasonNumber as number, episodeNumber: target.context.episodeNumber as number } : {}) }],
        ...(target.context.overview ? { overview: String(target.context.overview).slice(0,4000) } : {}),
        ...(target.context.originalLanguage ? { originalLanguage: String(target.context.originalLanguage) } : {}),
        ...(['standard', 'anime', 'daily'].includes(String(target.context.seriesType)) ? { seriesType: target.context.seriesType as 'standard'|'anime'|'daily' } : {}),
        ...(target.context.episodeTitle ? { episodeTitle: String(target.context.episodeTitle) } : {}),
        ...(target.context.profileContext && typeof target.context.profileContext === 'object' ? { profileContext: target.context.profileContext as { qualities?: string[]; customFormats?: string[]; unknown: boolean } } : {}),
      } }, {}, signal, { targetKeys: [target.key] });
      if (signal?.aborted) return { observedAt: now, ran: true, reason: 'cancelled-after-search', targetKey: target.key, search };
      if (['failed','budget-exhausted','interrupted'].includes(search.status)) {
        const failures = (prior?.failCount ?? 0) + 1;
        const completedAt = (this.deps.clock ?? Date.now)();
        const deadline = completedAt + failureDelay(failures);
        this.deps.store.setAutomationAttempt(target.key, { lastAttempt: completedAt, failCount: failures, deadline, graceUntil: 0, physicalKey: null });
        this.deps.store.setDeadline(target.key, deadline);
        return { observedAt: now, ran: true, targetKey: target.key, search, nextAttemptAt: deadline };
      }
      if (!this.deps.getPolicy().enabled) {
        this.deps.store.setAutomationAttempt(target.key, { lastAttempt: now, failCount: prior?.failCount ?? 0, deadline: 0, graceUntil: prior?.graceUntil ?? 0, physicalKey: prior?.physicalKey });
        this.deps.store.setDeadline(target.key, 0);
        return { observedAt: now, ran: true, reason: 'paused-after-search', targetKey: target.key, search };
      }
      if (this.deps.getPolicy().dryRun) {
        const completedAt = (this.deps.clock ?? Date.now)();
        const deadline = completedAt + ordinaryRetry;
        this.deps.store.setAutomationAttempt(target.key, { lastAttempt: completedAt, failCount: 0, deadline, graceUntil: 0, physicalKey: null });
        this.deps.store.setDeadline(target.key, deadline);
        return { observedAt: now, ran: true, reason: 'paused-after-search', targetKey: target.key, search, nextAttemptAt: deadline };
      }
      if (search.status !== 'matched') {
        const completedAt = (this.deps.clock ?? Date.now)();
        const deadline = completedAt + ordinaryRetry;
        this.deps.store.setAutomationAttempt(target.key, { lastAttempt: completedAt, failCount: 0, deadline, graceUntil: 0, physicalKey: null });
        this.deps.store.setDeadline(target.key, deadline);
        return { observedAt: now, ran: true, targetKey: target.key, search, nextAttemptAt: deadline };
      }
      const rankOne = search.options.find(o => o.rank === 1);
      if (!rankOne) throw new Error('matched-result-without-rank-one');
      const serverContext: SubmissionServerContext = {
        targets: [target.key], fingerprint: () => this.deps.observer.sourceFingerprint ? this.deps.observer.sourceFingerprint(target.provider) ?? 'source-removed' : target.sourceFingerprint, available: () => this.deps.getPolicy().enabled && !this.deps.getPolicy().dryRun,
        validate: async () => this.deps.observer.validateTarget(target),
      };
      const submission = await this.deps.submission.submit({ searchId: search.searchId, optionId: rankOne.optionId, idempotencyKey: randomUUID() }, serverContext);
      if (['failed', 'deferred', 'conflict'].includes(submission.outcome)) {
        const failures = (prior?.failCount ?? 0) + 1;
        const completedAt = (this.deps.clock ?? Date.now)();
        const deadline = completedAt + failureDelay(failures);
        this.deps.store.setAutomationAttempt(target.key, { lastAttempt: completedAt, failCount: failures, deadline, graceUntil: 0, physicalKey: null });
        this.deps.store.setDeadline(target.key, deadline);
        return { observedAt: now, ran: true, targetKey: target.key, search, submission, nextAttemptAt: deadline };
      }
      const graceUntil = submission.outcome === 'submitted' || submission.outcome === 'uncertain' ? now + Math.max(1, policy.queueGraceMinutes ?? 30)*MINUTE : 0;
      this.deps.store.setAutomationAttempt(target.key, { lastAttempt: now, failCount: submission.outcome === 'submitted' ? 0 : prior?.failCount ?? 0, deadline: graceUntil, graceUntil, physicalKey: null });
      return { observedAt: now, ran: true, targetKey: target.key, search, submission, ...(graceUntil ? { nextAttemptAt: graceUntil } : {}) };
    } catch (error) {
      if (signal?.aborted) return { observedAt: now, ran: false, reason: 'cancelled', targetKey: target.key };
      if (error instanceof Error && error.message === 'automation-capacity-deferred') {
        if (prior) this.deps.store.setAutomationAttempt(target.key, prior); else this.deps.store.deleteAutomationAttempt(target.key);
        this.deps.store.setDeadline(target.key, prior?.deadline ?? 0);
        return { observedAt: now, ran: false, reason: 'search-capacity', targetKey: target.key };
      }
      const failures = (prior?.failCount ?? 0)+1;
      const completedAt = (this.deps.clock ?? Date.now)();
      const deadline = completedAt + failureDelay(failures);
      this.deps.store.setAutomationAttempt(target.key, { lastAttempt: completedAt, failCount: failures, deadline, graceUntil: 0, physicalKey: null });
      this.deps.store.setDeadline(target.key, deadline);
      return { observedAt: now, ran: true, targetKey: target.key, reason: 'attempt-failed', nextAttemptAt: deadline };
    }
  }

  private reconcileReceipts(snapshot: ArrSnapshot, now: number): void {
    const current = new Map(snapshot.targets.map(target => [target.key, target]));
    for (const receipt of this.deps.store.listSubmissions()) {
      if (!['submitted', 'uncertain', 'submitting'].includes(receipt.outcome)) continue;
      if (receipt.outcome === 'submitting' && this.deps.store.hasLiveLease(`submission:${receipt.idempotencyKey}`, now)) continue;
      const payload = receipt.payload as { targets?: unknown; physicalReleases?: unknown };
      const targets = Array.isArray(payload.targets) ? payload.targets.filter((id): id is string => typeof id === 'string') : [];
      const releases = Array.isArray(payload.physicalReleases) ? payload.physicalReleases.filter((id): id is string => typeof id === 'string') : [];
      if (!targets.length || !targets.every(key => snapshot[key.startsWith('sonarr:') ? 'sonarr' : 'radarr'].known)) continue;
      const marker = `arr-receipt:${receipt.idempotencyKey}`;
      if (this.deps.store.getSetting(`${marker}:imported`)) continue;
      const observed = targets.map(key => current.get(key));
      if (observed.every(target => target?.hasFile)) {
        this.deps.store.setSetting(`${marker}:imported`, { observedAt: now });
        continue;
      }
      if (observed.some(target => !target || !target.eligible)) continue;
      const grace = targets.map(target => this.deps.store.getGrace('target', target, now));
      if (grace.some(until => until !== null)) continue;
      for (const target of targets) for (const release of releases) {
        const exclusionMarker = `${marker}:excluded:${target}:${release}`;
        if (!this.deps.store.getSetting(exclusionMarker)) {
          this.deps.store.saveExclusion(target, release, now + EXCLUSION, 'submission-not-observed-in-queue');
          this.deps.store.setSetting(exclusionMarker, { createdAt: now });
        }
      }
    }
  }
}

export const ARR_AUTOMATION_DEFAULTS = { pollIntervalMs: POLL_INTERVAL, ordinaryRetryMs: ORDINARY_RETRY, submissionGraceMs: SUBMISSION_GRACE, failureMinMs: FAILURE_MIN, failureMaxMs: FAILURE_MAX, exclusionMs: EXCLUSION } as const;
