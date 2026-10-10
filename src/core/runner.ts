import type { Logger } from 'pino';
import type { ProwlarrClient } from '../clients/prowlarr';
import type { SonarrClient } from '../clients/sonarr';
import type { RadarrClient } from '../clients/radarr';
import type { Release } from '../types/prowlarr';
import type { RadarrQueueRecord } from '../types/radarr';
import type { SonarrQueueRecord } from '../types/sonarr';
import { ApiError } from '../http';
import type { Picker, Candidate, PickVerdict } from './picker';
import type { Planner } from './planner';
import { parseReleaseTitle } from './parser';
import { isGrabbable, verifyRelease } from './guardrails';
import { reviewEvidenceMatchesWorkKey, WORK_OBSERVATION_STALE_AFTER_MS, type State } from './state';
import type { IntentCoverage, IntentStatus, QueueRead, WorkItem } from './work-queue-types';
import { candidateOverlapsQueue, reconcileWork, type QueueReads, type ReconciledWork } from './work-queue';
import { eligibleWorkUnits, type LibrarySnapshot, type Watcher, type WorkUnit } from './watcher';
import type { AssociationCacheEntry, AssociationDecision, GroupCandidate, PlanningContext, WorkGroup } from './group-types';
import type { GroupSelection, GroupPlannedQuery } from '../types/group-llm';
import { buildAssociationRequests, QueueAssociator } from './queue-association';
import { buildPlanningContext, buildWorkGroups } from './media-context';
import { parseReleaseCoverage } from './parser';
import { verifyGroupCoverage } from './guardrails';

export interface CycleSummary {
  units: number;
  searched: number;
  grabbed: number;
  dryRunGrabs: number;
  manualFlagged: number;
  skipped: number;
}

export type GrabOutcome = 'grabbed' | 'dry-run' | 'reverify-failed' | 'missing-download-client';
type UnitOutcome = 'processed' | 'rate-limited';

export interface ManualPickResult {
  outcome: GrabOutcome;
  releaseTitle: string;
  coveredEpisodeNumbers: number[] | null;
  coverageBasis: 'explicit-episodes' | 'inferred-season-pack' | null;
}

export interface RunnerDeps {
  watcher: Watcher;
  planner: Planner;
  picker: Picker;
  associator?: Pick<QueueAssociator, 'associate'>;
  prowlarr: ProwlarrClient;
  sonarr?: Pick<SonarrClient, 'getQueue'>;
  radarr?: Pick<RadarrClient, 'getQueue'>;
  state: State;
  config: {
    dryRun: boolean;
    minRetryHours: number;
    failureBackoffMin?: number;
    failureBackoffMaxMin?: number;
    queueGraceMin?: number;
  };
  clientNames: { tv: string; movie: string };
  logger: Logger;
  now?: () => Date;
}

const PICKER_CANDIDATE_CAP = 100;

interface PhysicalQueueScope {
  relevant: boolean;
  conflict: boolean;
  seasonNumber: number | null;
}

type EpisodePhysicalScope = { serviceId: number; seasonNumber: number };

function episodePhysicalScopes(snapshot: LibrarySnapshot): Map<number, EpisodePhysicalScope> {
  return new Map(snapshot.sonarr.series.flatMap(({ series, episodes }) => (episodes ?? []).map((episode) => [
    episode.id, { serviceId: series.id, seasonNumber: episode.seasonNumber },
  ] as const)));
}

/** Raw and library-mapped episode fields must agree before either can narrow physical scope. */
function physicalQueueScope(row: SonarrQueueRecord, episodeScopes: ReadonlyMap<number, EpisodePhysicalScope>, serviceId: number): PhysicalQueueScope {
  const episodeScope = row.episodeId == null ? undefined : episodeScopes.get(row.episodeId);
  const rawServiceId = row.seriesId ?? null;
  const mappedServiceId = episodeScope?.serviceId ?? null;
  const rawSeasonNumber = row.seasonNumber ?? null;
  const mappedSeasonNumber = episodeScope?.seasonNumber ?? null;
  const conflict = (rawServiceId !== null && mappedServiceId !== null && rawServiceId !== mappedServiceId) ||
    (rawSeasonNumber !== null && mappedSeasonNumber !== null && rawSeasonNumber !== mappedSeasonNumber);
  const relevant = rawServiceId === serviceId || mappedServiceId === serviceId;
  return {
    relevant,
    conflict,
    seasonNumber: conflict ? null : rawSeasonNumber ?? mappedSeasonNumber,
  };
}

function safeErrorCode(error: unknown): string {
  if (error instanceof ApiError) return error.status === 0 ? 'network-error' : `http-${error.status}`;
  return 'operation-failed';
}

function parseReviewObservationTime(value: unknown): number | null {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,9})?Z$/.test(value)) return null;
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return null;
  try { if (new Date(value).toISOString().slice(0, 19) !== value.slice(0, 19)) return null; } catch { return null; }
  return time;
}

function isRateLimited(error: unknown): boolean {
  return error instanceof ApiError && (error.status === 429 || error.retryAfter !== undefined);
}

function safeErrorType(error: unknown): string {
  if (error instanceof ApiError) return 'ApiError';
  if (error instanceof Error && ['TypeError', 'RangeError', 'SyntaxError'].includes(error.name)) return error.name;
  return error instanceof Error ? 'Error' : typeof error;
}

function safeFailureMetadata(stage: string, error: unknown): Record<string, string | number> {
  const status = error instanceof ApiError && error.status > 0 ? error.status : undefined;
  const retryAfterSeconds = error instanceof ApiError && error.retryAfter !== undefined && Number.isFinite(error.retryAfter) && error.retryAfter >= 0
    ? error.retryAfter
    : undefined;
  return {
    stage,
    errorCode: safeErrorCode(error),
    errorType: safeErrorType(error),
    ...(status === undefined ? {} : { status }),
    ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }),
  };
}

function safeFailureDetails(stage: string, error: unknown): string {
  return JSON.stringify(safeFailureMetadata(stage, error));
}

const MAX_CONSECUTIVE_OPERATION_FAILURES = 3;

type FailureOutcome = 'operation-failure' | 'rate-limited';
type BackoffFailure = { error: unknown; stage: string; disposition?: 'already-counted' | 'uncertain' };

function failureOutcome(error: unknown): FailureOutcome {
  return isRateLimited(error) ? 'rate-limited' : 'operation-failure';
}

function nextFailureCount(work: WorkItem, outcome: FailureOutcome): number {
  return work.lastOutcome === outcome ? work.failCount + 1 : 1;
}

function candidateCoverage(unit: WorkUnit, candidate: Candidate): IntentCoverage[] {
  return [{
    workKey: unit.key,
    episodeIds: unit.kind === 'tv' ? (candidate.coveredEpisodes?.map((episode) => episode.episodeId) ?? []) : null,
    basis: unit.kind === 'tv' ? candidate.coverageBasis : null,
  }];
}

function intentUpdateRelatesToWork(intent: import('./work-queue-types').GrabIntent, work: WorkItem, existing: WorkItem[], status: IntentStatus): boolean {
  return intent.coverage.some((coverage) => {
    if (coverage.workKey === work.workKey) return true;
    if (coverage.episodeIds === null || work.unit.kind !== 'tv') return false;
    const prior = existing.find((item) => item.workKey === coverage.workKey);
    if (!prior || prior.unit.kind !== 'tv' || prior.unit.arr !== work.unit.arr || prior.unit.serviceId !== work.unit.serviceId) return false;
    if (status === 'fulfilled') return true;
    const currentIds = new Set(work.unit.season?.missing.map((episode) => episode.episodeId) ?? []);
    return coverage.episodeIds.some((id) => currentIds.has(id));
  });
}

/** Runs queue reconciliation before any paid search; remote receipts use immutable intent ownership. */
export class Runner {
  private readonly logger: Logger;
  private readonly now: () => Date;
  private readonly failureBaseMin: number;
  private readonly failureCapMin: number;
  private readonly queueGraceMin: number;

  constructor(private readonly deps: RunnerDeps) {
    this.logger = deps.logger.child({ component: 'runner' });
    this.now = deps.now ?? (() => new Date());
    this.failureBaseMin = deps.config.failureBackoffMin ?? 5;
    this.failureCapMin = deps.config.failureBackoffMaxMin ?? 60;
    this.queueGraceMin = deps.config.queueGraceMin ?? 30;
  }

  async cycle(): Promise<CycleSummary> {
    const summary = this.emptySummary();
    let observed: { snapshot: LibrarySnapshot; queues: QueueReads; rows: ReconciledWork[] };
    try {
      observed = await this.observeAndReconcile(false, [], Boolean(this.deps.associator));
    } catch (error) {
      this.logger.warn(safeFailureMetadata('library-observation', error), 'library observation or durable reconciliation failed');
      return summary;
    }
    const currentRows = observed.rows.filter((row) => row.work.status !== 'inactive' && row.work.status !== 'fulfilled');
    summary.units = currentRows.length;
    let groups = buildWorkGroups({ snapshot: observed.snapshot, rows: observed.rows, now: this.now().toISOString() });
    const associationMayUnblock = observed.rows.some((row) => (row.work.status === 'ready' || row.work.status === 'manual') &&
      row.eligibleUnit === null && row.blockedReason === 'queue-ambiguous' && this.snapshotHasEligible(observed.snapshot, row.work.workKey));
    if (groups.length === 0 && !associationMayUnblock) {
      summary.skipped += currentRows.length;
      return summary;
    }

    let allowlist: number[];
    try {
      allowlist = await this.healthyIndexers();
    } catch (error) {
      this.logger.warn(safeFailureMetadata('indexer-availability', error), 'indexer availability lookup failed; paid work skipped');
      summary.skipped += groups.reduce((count, group) => count + group.dueTargetIndices.length, 0);
      return summary;
    }
    if (allowlist.length === 0) {
      summary.skipped += groups.reduce((count, group) => count + group.dueTargetIndices.length, 0);
      return summary;
    }

    const cachedDecisions = await this.resolveAssociations(observed.snapshot, observed.queues);
    if (cachedDecisions.length || associationMayUnblock) {
      try {
        observed = await this.observeAndReconcile(false, cachedDecisions, Boolean(this.deps.associator));
        groups = buildWorkGroups({ snapshot: observed.snapshot, rows: observed.rows, now: this.now().toISOString() });
      } catch (error) {
        this.logger.warn(safeFailureMetadata('association-reconciliation', error), 'association reconciliation failed; grouped work skipped');
        return summary;
      }
    }
    const dueKeys = new Set(groups.flatMap((group) => group.dueTargetIndices.map((index) => group.targets[index]!.key)));
    summary.skipped += currentRows.filter((row) => !dueKeys.has(row.work.workKey)).length;
    if (groups.length === 0) return summary;

    let clients: { id: number; name: string }[];
    try {
      clients = await this.deps.prowlarr.getDownloadClients();
    } catch (error) {
      this.logger.warn(safeFailureMetadata('download-client-lookup', error), 'download-client lookup failed; paid work skipped');
      summary.skipped += groups.reduce((count, group) => count + group.dueTargetIndices.length, 0);
      return summary;
    }
    const clientId = { tv: this.resolveClientId(clients, this.deps.clientNames.tv), movie: this.resolveClientId(clients, this.deps.clientNames.movie) };

    for (const group of groups) {
      if (allowlist.length === 0) {
        summary.skipped += group.dueTargetIndices.length;
        continue;
      }
      const outcome = await this.processGroup(group, clientId, allowlist, cachedDecisions, summary);
      if (outcome === 'rate-limited') {
        try { allowlist = await this.healthyIndexers(); }
        catch (error) {
          this.logger.warn({ errorCode: safeErrorCode(error) }, 'indexer list refresh failed after rate limit; remaining groups deferred');
          allowlist = [];
        }
      }
    }
    return summary;
  }

  private snapshotHasEligible(snapshot: LibrarySnapshot, workKey: string): boolean {
    return eligibleWorkUnits(snapshot).some((unit) => unit.key === workKey);
  }

  private async recordedSearch(query: string, categories: number[], indexerIds: number[], units: WorkUnit[], source: 'cycle' | 'manual' = 'cycle'): Promise<Release[]> {
    let activityId: number | undefined;
    try {
      activityId = this.deps.state.startSearchActivity({ source, query, media: units.map(({ key, title }) => ({ workKey: key, title })), now: this.now().toISOString() });
    } catch { /* Activity is an independent bounded projection and never gates a decision. */ }
    try {
      const releases = await this.deps.prowlarr.search({ query, categories, indexerIds });
      if (activityId !== undefined) try { this.deps.state.finishSearchActivity({ id: activityId, now: this.now().toISOString(), resultCount: releases.length }); } catch { /* Keep search outcomes independent from activity persistence. */ }
      return releases;
    } catch (error) {
      if (activityId !== undefined) try { this.deps.state.finishSearchActivity({ id: activityId, now: this.now().toISOString(), resultCount: null, errorCode: safeErrorCode(error) }); } catch { /* Preserve the original upstream failure. */ }
      throw error;
    }
  }

  /** Resolve only due, otherwise-actionable source jobs; unknown reads and missing associators stay held. */
  private async resolveAssociations(snapshot: LibrarySnapshot, queues: QueueReads): Promise<AssociationDecision[]> {
    if (!this.deps.associator) return [];
    let existingCache: AssociationCacheEntry[];
    try { existingCache = this.deps.state.listAssociationCache(); }
    catch (error) {
      this.logger.warn(safeFailureMetadata('association-cache', error), 'association cache is corrupt; fuzzy queue work remains held');
      return [];
    }
    const requests = buildAssociationRequests({ snapshot, queues, cache: existingCache });
    const dueKeys = new Set(this.deps.state.listWorkItems().filter((work) => work.status === 'ready' &&
      (work.nextSearchAt === null || Date.parse(work.nextSearchAt) <= this.now().getTime())).map((work) => work.workKey));
    for (const arr of ['sonarr', 'radarr'] as const) {
      const sourceRequests = requests.filter((request) => request.arr === arr && request.lookup.workReferencesByIndex.some((reference) => dueKeys.has(reference.workKey)));
      if (sourceRequests.length === 0) continue;
      const leaseKey = `association:${arr}`;
      const claims = this.deps.state.claimUnits({ keys: [leaseKey], now: this.now() });
      if (!claims) continue;
      try {
        for (const request of sourceRequests) {
          const retry = this.deps.state.getAssociationRetry({ arr, sourceJobKey: request.sourceJobKey });
          if (retry && retry.materialSignature === request.materialSignature && retry.contextSignature === request.contextSignature &&
            retry.promptVersion === request.promptVersion && retry.nextAttemptAt && Date.parse(retry.nextAttemptAt) > this.now().getTime()) continue;
          try {
            const decisions = await this.deps.associator.associate(request);
            this.deps.state.putAssociationCache({
              entry: { arr, sourceJobKey: request.sourceJobKey, materialSignature: request.materialSignature, contextSignature: request.contextSignature, promptVersion: request.promptVersion, cachedAt: this.now().toISOString(), decisions },
              leaseKey, ownerToken: claims.ownerToken, now: this.now().toISOString(),
            });
          } catch (error) {
            const failCount = Math.min(30, (retry?.failCount ?? 0) + 1);
            const delay = Math.min(this.failureCapMin, this.failureBaseMin * 2 ** Math.max(0, failCount - 1));
            try {
              this.deps.state.recordAssociationFailure({ request, leaseKey, ownerToken: claims.ownerToken, now: this.now().toISOString(), nextAttemptAt: this.dateAfter(delay), failCount });
            } catch { /* A lost/expired lease cannot authorize a stale cache write. */ }
            this.logger.warn({ arr, ...safeFailureMetadata('queue-association', error) }, 'queue association failed; scoped ambiguity remains held');
          }
        }
      } finally {
        try { this.deps.state.releaseClaims({ keys: claims.keys, ownerToken: claims.ownerToken }); } catch { /* Owner-checked release must not affect a successor. */ }
      }
    }

    return this.applicableAssociationDecisions(snapshot, queues);
  }

  private applicableAssociationDecisions(snapshot: LibrarySnapshot, queues: QueueReads): AssociationDecision[] {
    try {
      const cache = this.deps.state.listAssociationCache();
      const currentRequests = buildAssociationRequests({ snapshot, queues, cache: [] });
      const applicable = new Map(currentRequests.map((request) => [`${request.arr}\0${request.sourceJobKey}`, request]));
      const decisions: AssociationDecision[] = [];
      for (const entry of cache) {
        const request = applicable.get(`${entry.arr}\0${entry.sourceJobKey}`);
        if (!request || request.materialSignature !== entry.materialSignature || request.contextSignature !== entry.contextSignature || request.promptVersion !== entry.promptVersion) continue;
        decisions.push(...entry.decisions);
      }
      return decisions;
    } catch (error) {
      this.logger.warn(safeFailureMetadata('association-cache', error), 'association cache could not be applied; fuzzy queue work remains held');
      return [];
    }
  }

  private async processGroup(
    initialGroup: WorkGroup,
    clientId: { tv: number | undefined; movie: number | undefined },
    allowlist: number[],
    associations: AssociationDecision[],
    summary: CycleSummary,
  ): Promise<UnitOutcome> {
    const coordinationKey = `group:${initialGroup.key}`;
    const keys = [...new Set([coordinationKey, ...initialGroup.members.map((member) => member.work.workKey)])];
    const claims = this.deps.state.claimUnits({ keys, now: this.now() });
    if (!claims) { summary.skipped += initialGroup.dueTargetIndices.length; return 'processed'; }
    let startedKeys: string[] = [];
    let backoffKeys = new Set<string>();
    let selectedForDeferral: number[] = [];
    let selection: GroupSelection | null = null;
    let actualProgress = false;
    let stage = 'observation';
    const backoffFailures = new Map<string, BackoffFailure>();
    try {
      const fresh = await this.refreshGroupObservation(claims);
      if (!fresh) { summary.skipped += initialGroup.dueTargetIndices.length; return 'processed'; }
      const currentGroup = this.rebuildClaimedGroup(initialGroup, fresh.rows, claims.keys);
      if (!currentGroup || currentGroup.members.some((member) => !claims.keys.includes(member.work.workKey))) {
        summary.skipped += initialGroup.dueTargetIndices.length;
        return 'processed';
      }
      if (currentGroup.dueTargetIndices.length === 0) { summary.skipped += initialGroup.dueTargetIndices.length; return 'processed'; }
      if (!this.deps.state.renewClaims({ keys: claims.keys, ownerToken: claims.ownerToken, now: this.now() })) {
        summary.skipped += currentGroup.dueTargetIndices.length;
        return 'processed';
      }
      const workByKey = new Map(currentGroup.members.map((member) => [member.work.workKey, member.work]));
      for (const index of currentGroup.dueTargetIndices) {
        const work = workByKey.get(currentGroup.targets[index]!.key);
        if (!work) continue;
        this.deps.state.startSearch({ key: work.workKey, token: claims.ownerToken, now: this.now().toISOString(), recoveryAt: this.dateAfter(this.failureBaseMin) });
        startedKeys.push(work.workKey);
      }

      stage = 'context';
      const context = buildPlanningContext({ snapshot: fresh.snapshot, rows: fresh.rows, queues: fresh.queues, intents: this.openGrabIntents(), associations });
      let planned: GroupPlannedQuery[];
      stage = 'planner';
      try {
        planned = await this.deps.planner.planGroup({ group: currentGroup, context });
        summary.searched += 1;
      } catch (error) {
        await this.finishGroupBackoff(currentGroup, startedKeys, claims.ownerToken, error, summary, undefined, 'planner');
        startedKeys = [];
        summary.skipped += currentGroup.dueTargetIndices.length;
        this.logger.warn({ groupKey: currentGroup.key, ...safeFailureMetadata('planner', error) }, 'group planning failure handled');
        return 'processed';
      }

      const releases: Release[] = [];
      stage = 'search';
      try {
        for (const query of planned) {
          const seenTargets = new Set<number>();
          const queryTargets = query.targetIndices.map((index) => {
            if (!Number.isSafeInteger(index) || index < 0 || index >= currentGroup.targets.length || seenTargets.has(index)) throw new Error('planner group query has invalid target attribution');
            seenTargets.add(index);
            const target = currentGroup.targets[index];
            if (!target) throw new Error('planner group query has invalid target attribution');
            return target;
          });
          releases.push(...await this.recordedSearch(query.query, query.categories, allowlist, queryTargets));
        }
      } catch (error) {
        await this.finishGroupBackoff(currentGroup, startedKeys, claims.ownerToken, error, summary, error instanceof ApiError ? error.retryAfter : undefined, 'search');
        startedKeys = [];
        summary.skipped += currentGroup.dueTargetIndices.length;
        this.logger.warn({ workKey: currentGroup.targets[currentGroup.dueTargetIndices[0]!]?.key, ...safeFailureMetadata('search', error) }, 'Prowlarr group search batch aborted');
        if (isRateLimited(error)) return 'rate-limited';
        this.logger.warn({ groupKey: currentGroup.key, ...safeFailureMetadata('search', error) }, 'group search batch failure handled');
        return 'processed';
      }

      stage = 'candidate-filter';
      const candidates = this.buildGroupCandidates(currentGroup, context, releases, summary, fresh.snapshot, fresh.queues);
      if (candidates.length === 0) {
        this.finishNoSuitableRelease(startedKeys, claims.ownerToken, releases.length, summary);
        startedKeys = [];
        summary.skipped += currentGroup.dueTargetIndices.length;
        return 'processed';
      }
      stage = 'picker';
      try {
        selection = await this.deps.picker.pickGroup({ group: currentGroup, context, candidates });
      } catch (error) {
        await this.finishGroupBackoff(currentGroup, startedKeys, claims.ownerToken, error, summary, undefined, 'picker');
        startedKeys = [];
        summary.skipped += currentGroup.dueTargetIndices.length;
        this.logger.warn({ groupKey: currentGroup.key, ...safeFailureMetadata('picker', error) }, 'group selection failure handled');
        return 'processed';
      }
      const fullFootprints = selection.releaseIndices.map((index) => {
        const candidate = candidates[index];
        if (!candidate) return null;
        const proof = verifyGroupCoverage({ originalUnits: currentGroup.members.map((member) => member.work.unit), actionableUnits: currentGroup.targets, parsed: candidate.parsed });
        return proof.kind === 'covered' ? proof.requestedFootprint : null;
      });
      if (fullFootprints.some((footprint) => footprint === null) || this.groupFootprintsOverlap(fullFootprints as NonNullable<(typeof fullFootprints)[number]>[])) {
        await this.finishGroupBackoff(currentGroup, startedKeys, claims.ownerToken, new Error('selected group releases have overlapping original requested footprints'), summary, undefined, 'selection-validation');
        startedKeys = [];
        summary.skipped += currentGroup.dueTargetIndices.length;
        return 'processed';
      }
      selectedForDeferral = selection.deferredTargetIndices;
      let newPickerReviews = 0;
      for (const targetIndex of selection.manualTargetIndices) {
        const workKey = currentGroup.targets[targetIndex]!.key;
        if (this.flagReviewOnce(workKey, 'picker-manual', selection.reason)) newPickerReviews += 1;
      }
      if (selection.verdict === 'manual' || selection.verdict === 'skip') {
        await this.finishGroupDecision(currentGroup, startedKeys, claims.ownerToken, selection, 'picker-manual', new Set(), new Map(), summary);
        startedKeys = [];
        if (selection.verdict === 'manual') summary.manualFlagged += newPickerReviews;
        else summary.skipped += currentGroup.dueTargetIndices.length;
        return 'processed';
      }
      if (this.deps.config.dryRun) {
        await this.finishGroupDecision(currentGroup, startedKeys, claims.ownerToken, selection, 'dry-run', new Set(), new Map(), summary);
        startedKeys = [];
        summary.dryRunGrabs += selection.releaseIndices.length;
        for (const index of selection.releaseIndices) {
          const chosen = candidates[index]!;
          const target = currentGroup.targets.find((unit) => unit.key === chosen.capture[0]?.workKey);
          const episodeNumbers = target?.kind === 'tv'
            ? target.season?.missing.filter((episode) => chosen.capture.some((coverage) => coverage.workKey === target.key && coverage.episodeIds?.includes(episode.episodeId))).map((episode) => episode.episodeNumber) ?? []
            : null;
          this.logger.info({ workKey: target?.key ?? currentGroup.key, releaseTitle: sanitizeGrabReason(chosen.release, chosen.release.title), coveredEpisodes: episodeNumbers, coverageBasis: chosen.capture[0]?.basis ?? null, reason: sanitizeGrabReason(chosen.release, selection.reason) }, 'DRY_RUN: grouped scheduling only; no grab intent created');
        }
        return 'processed';
      }

      stage = 'grab';
      for (const candidateIndex of selection.releaseIndices) {
        if (!this.deps.state.renewClaims({ keys: claims.keys, ownerToken: claims.ownerToken, now: this.now() })) break;
        const latest = await this.refreshGroupObservation(claims);
        if (!latest) break;
        const latestGroup = this.rebuildClaimedGroup(currentGroup, latest.rows, claims.keys);
        const candidate = candidates[candidateIndex];
        if (!latestGroup || !candidate || latestGroup.members.some((member) => !claims.keys.includes(member.work.workKey))) break;
        const refreshed = this.refreshSelectedCoverage(latestGroup, candidate, context, latest);
        if (!refreshed || refreshed.capture.length === 0) break;
        const targetUnit = latestGroup.targets.find((target) => target.key === refreshed.capture[0]!.workKey);
        if (!targetUnit) break;
        const targetId = targetUnit.kind === 'tv' ? clientId.tv : clientId.movie;
        if (targetId === undefined) {
          if (this.flagReviewOnce(targetUnit.key, 'missing-download-client', targetUnit.kind === 'tv' ? this.deps.clientNames.tv : this.deps.clientNames.movie)) summary.manualFlagged += 1;
          try { this.deps.state.finishSearch({ key: targetUnit.key, token: claims.ownerToken, status: 'manual', nextSearchAt: null, failCount: this.deps.state.getWorkItem(targetUnit.key)?.failCount ?? 0, outcome: 'missing-download-client', now: this.now().toISOString(), decision: { workKey: targetUnit.key, verdict: 'manual', grabbed: false } }); } catch { /* Manual hold is best effort under the owned lease. */ }
          break;
        }
        const fingerprints: Record<string, string> = {};
        for (const capture of refreshed.capture) {
          const work = this.deps.state.getWorkItem(capture.workKey);
          if (!work) { backoffKeys.add(capture.workKey); continue; }
          fingerprints[capture.workKey] = work.missingFingerprint;
        }
        if (Object.keys(fingerprints).length !== refreshed.capture.length) break;
        const now = this.now().toISOString();
        const reserved = this.deps.state.beginGroupGrab({
          claims,
          fingerprints,
          release: { arr: targetUnit.arr, indexerId: candidate.release.indexerId, guid: candidate.release.guid, infoHash: candidate.release.infoHash, releaseTitle: candidate.release.title },
          coverage: refreshed.capture,
          declaredScope: candidate.parsed,
          now,
          deadline: new Date(Date.parse(now) + this.queueGraceMin * 60_000).toISOString(),
        });
        if (!reserved.ok) { for (const entry of refreshed.capture) backoffKeys.add(entry.workKey); break; }
        try {
          await this.deps.prowlarr.grab(candidate.release, targetId);
          this.deps.state.confirmGrab({ intentId: reserved.intentId, ownerToken: claims.ownerToken, now: this.now().toISOString() });
          actualProgress = true;
          summary.grabbed += 1;
        } catch (error) {
          if (error instanceof ApiError && error.status >= 400 && error.status < 500) {
            const outcome = failureOutcome(error);
            const failureUpdates = refreshed.capture.flatMap((coverage) => {
              const work = this.deps.state.getWorkItem(coverage.workKey);
              if (!work) return [];
              const failCount = nextFailureCount(work, outcome);
              return [{ workKey: coverage.workKey, outcome, failCount, nextSearchAt: this.failureRetryAt(failCount, error.retryAfter) }];
            });
            this.deps.state.rejectGrab({ intentId: reserved.intentId, ownerToken: claims.ownerToken, nextSearchAt: this.failureRetryAt(1, error.retryAfter), now: this.now().toISOString(), failureUpdates });
            for (const coverage of refreshed.capture) backoffKeys.add(coverage.workKey);
            for (const coverage of refreshed.capture) backoffFailures.set(coverage.workKey, { error, stage: 'grab', disposition: 'already-counted' });
          } else {
            this.deps.state.markGrabUncertain({ intentId: reserved.intentId, ownerToken: claims.ownerToken, now: this.now().toISOString() });
            for (const coverage of refreshed.capture) backoffKeys.add(coverage.workKey);
            for (const coverage of refreshed.capture) backoffFailures.set(coverage.workKey, { error, stage: 'grab', disposition: 'uncertain' });
          }
          summary.skipped += 1;
          this.logger.warn({ workKey: refreshed.capture[0]?.workKey, ...safeFailureMetadata('grab', error) }, isRateLimited(error)
            ? 'Prowlarr grouped grab rate limit; remaining selected releases stopped'
            : 'Prowlarr grouped grab failed; selected releases stopped');
          if (isRateLimited(error)) {
            await this.finishGroupDecision(currentGroup, startedKeys, claims.ownerToken, selection, 'grab-rate-limited', backoffKeys, backoffFailures, summary);
            startedKeys = [];
            return 'rate-limited';
          }
          break;
        }
      }
      await this.finishGroupDecision(currentGroup, startedKeys, claims.ownerToken, selection, actualProgress ? 'group-grabbed' : 'group-no-grab', backoffKeys, backoffFailures, summary, selectedForDeferral, actualProgress);
      startedKeys = [];
      return 'processed';
    } catch (error) {
      if (startedKeys.length) await this.finishGroupBackoff(initialGroup, startedKeys, claims.ownerToken, error, summary, undefined, stage);
      this.logger.warn({ groupKey: initialGroup.key, ...safeFailureMetadata(stage, error) }, 'group processing failed; continuing cycle');
      summary.skipped += initialGroup.dueTargetIndices.length;
      return isRateLimited(error) ? 'rate-limited' : 'processed';
    } finally {
      try { this.deps.state.releaseClaims({ keys: claims.keys, ownerToken: claims.ownerToken }); } catch { /* Expiry or successor ownership is safe; stale cleanup never deletes another owner. */ }
    }
  }

  private async refreshGroupObservation(claims: import('./work-queue-types').ClaimSet): Promise<{ snapshot: LibrarySnapshot; queues: QueueReads; rows: ReconciledWork[] } | null> {
    if (!this.deps.state.renewClaims({ keys: claims.keys, ownerToken: claims.ownerToken, now: this.now() })) return null;
    const snapshot = await this.deps.watcher.getSnapshot();
    const queues = await this.readQueues();
    const existing = this.deps.state.listWorkItems();
    const intents = this.openGrabIntents();
    const observations = this.deps.state.listWorkQueueObservations();
    const manualKeys = this.manualReviewKeys(this.deps.state.listManualReview(), false);
    const applicableAssociations = this.applicableAssociationDecisions(snapshot, queues);
    const result = reconcileWork({
      snapshot, queues, existingWorkItems: existing, intents, associationDecisions: applicableAssociations,
      previousQueueCoverage: new Map(observations.map((entry) => [entry.workKey, entry.coverage])),
      previousQueueFailureRefs: new Map(observations.map((entry) => [entry.workKey, entry.failedQueueRefs])),
      now: this.now().toISOString(), minRetryHours: this.deps.config.minRetryHours,
      failureBackoffMin: this.failureBaseMin, failureBackoffMaxMin: this.failureCapMin,
      queueGraceMin: this.queueGraceMin, manualReviewKeys: manualKeys,
    });
    let staleObservation = false;
    for (const row of result.items) {
      if (!claims.keys.includes(row.work.workKey)) continue;
      const persisted = existing.find((item) => item.workKey === row.work.workKey);
      if (persisted && Date.parse(snapshot.observedAt) < Date.parse(persisted.lastObservedAt) && persisted.missingFingerprint !== row.work.missingFingerprint) {
        staleObservation = true;
        continue;
      }
      const related = result.intentUpdates.filter((update) => {
        const intent = intents.find((entry) => entry.id === update.id);
        return intent !== undefined && intentUpdateRelatesToWork(intent, row.work, existing, update.status);
      });
      this.deps.state.applyWorkReconciliation({ key: row.work.workKey, token: claims.ownerToken, work: row.work, intentUpdates: related });
      const queue = queues[row.work.unit.arr];
      this.deps.state.applyWorkQueueObservation({ key: row.work.workKey, token: claims.ownerToken, observedAt: queue.observedAt, known: row.work.queueObservationKnown && queue.kind === 'known', coverage: row.queueCoverage, failedQueueRefs: row.queueFailureRefs });
    }
    if (staleObservation) return null;
    return { snapshot, queues, rows: result.items };
  }

  private rebuildClaimedGroup(base: WorkGroup, rows: ReconciledWork[], claimKeys: string[]): WorkGroup | null {
    const rowByKey = new Map(rows.map((row) => [row.work.workKey, row]));
    const family = base.members[0]?.work.unit;
    if (!family) return null;
    const members = rows.filter((row) => row.work.unit.arr === family.arr && row.work.unit.serviceId === family.serviceId &&
      !['inactive', 'fulfilled'].includes(row.work.status));
    if (members.some((member) => !claimKeys.includes(member.work.workKey))) return null;
    const targets: WorkUnit[] = [];
    const dueTargetIndices: number[] = [];
    for (let oldIndex = 0; oldIndex < base.targets.length; oldIndex += 1) {
      const original = base.targets[oldIndex]!;
      const row = rowByKey.get(original.key);
      if (!row?.eligibleUnit || ![null, 'queue-active', 'active-intent'].includes(row.blockedReason) ||
        !['ready', 'cooldown', 'searching'].includes(row.work.status)) continue;
      let unit = row.eligibleUnit;
      if (original.kind === 'tv' && unit.kind === 'tv') {
        const previousIds = new Set(original.season?.missing.map((episode) => episode.episodeId) ?? []);
        const missing = (unit.season?.missing ?? []).filter((episode) => previousIds.has(episode.episodeId));
        if (!missing.length) continue;
        unit = { ...unit, season: { seasonNumber: unit.season!.seasonNumber, missing } };
      }
      const newIndex = targets.length;
      targets.push(unit);
      if (base.dueTargetIndices.includes(oldIndex) && ['ready', 'searching'].includes(row.work.status)) dueTargetIndices.push(newIndex);
    }
    if (!dueTargetIndices.length) return null;
    return { key: base.key, members, targets, dueTargetIndices };
  }

  private buildGroupCandidates(group: WorkGroup, context: PlanningContext, releases: Release[], summary: CycleSummary, snapshot: LibrarySnapshot, queues: QueueReads): GroupCandidate[] {
    const originals = group.members.map((member) => member.work.unit);
    const held = group.members.flatMap((member) => member.activeCoverage);
    const seenSources = new Set<string>();
    const slots = new Map<string, number>();
    const candidates: GroupCandidate[] = [];
    for (const release of releases) {
      if (release.protocol !== 'torrent' || !isGrabbable(release) || this.deps.state.hasRelease(release.indexerId, release.guid) ||
        (release.infoHash !== null && this.deps.state.hasHash(release.infoHash))) continue;
      const sourceKey = JSON.stringify([release.indexerId, release.guid]);
      if (seenSources.has(sourceKey)) continue;
      seenSources.add(sourceKey);
      const physicalKey = release.infoHash ? `hash:${release.infoHash.toLowerCase()}` : `source:${sourceKey}`;
      let physicalSlot = slots.get(physicalKey);
      if (physicalSlot === undefined) { physicalSlot = slots.size; slots.set(physicalKey, physicalSlot); }
      const parsed = parseReleaseCoverage(release.title);
      if (group.members[0]?.work.unit.kind === 'tv' && (parsed.kind === 'invalid' || parsed.kind === 'none')) {
        for (const targetIndex of group.dueTargetIndices) this.flagUnparseable(group.targets[targetIndex]!, release.title, summary);
        continue;
      }
      const verified = verifyGroupCoverage({ originalUnits: originals, actionableUnits: group.targets, parsed });
      if (verified.kind !== 'covered') continue;
      if (candidateOverlapsQueue(verified.requestedFootprint, held)) continue;
      const heldSeasons = this.groupHeldSeasons(group, snapshot, queues);
      if (verified.extraSeasons.some((season) => heldSeasons.has(season)) ||
        (parsed.kind === 'claims' && parsed.wholeSeries && heldSeasons.size > 0)) continue;
      if ((verified.extraSeasons.length > 0 || (parsed.kind === 'claims' && parsed.wholeSeries)) && this.hasUnscopedQueueForGroup(group, snapshot, queues)) continue;
      const promptFootprint = verified.requestedFootprint.flatMap((coverage) => {
        const target = group.targets.find((unit) => unit.key === coverage.workKey);
        if (!target) return [];
        if (target.kind === 'movie') return coverage.episodeIds === null ? [coverage] : [];
        if (coverage.episodeIds === null) return [];
        const allowed = new Set(target.season?.missing.map((episode) => episode.episodeId) ?? []);
        const episodeIds = coverage.episodeIds.filter((id) => allowed.has(id));
        return episodeIds.length ? [{ ...coverage, episodeIds }] : [];
      });
      if (!promptFootprint.length) continue;
      candidates.push({ release, physicalSlot, parsed, requestedFootprint: promptFootprint, capture: verified.capture, extraSeasons: verified.extraSeasons });
    }
    return this.diverseGroupCandidates(candidates, context);
  }

  private groupHeldSeasons(group: WorkGroup, snapshot: LibrarySnapshot, queues: QueueReads): Set<number> {
    const held = new Set<number>();
    for (const member of group.members) {
      const seasonNumber = member.work.unit.kind === 'tv' ? member.work.unit.season?.seasonNumber : undefined;
      if (seasonNumber !== undefined && member.activeCoverage.length > 0) held.add(seasonNumber);
    }
    const first = group.members[0]?.work.unit;
    if (!first || first.kind !== 'tv' || queues.sonarr.kind !== 'known') return held;
    const episodeScopes = episodePhysicalScopes(snapshot);
    for (const row of queues.sonarr.records) {
      if (row.status === 'failed' || row.trackedDownloadState === 'failed') continue;
      const scope = physicalQueueScope(row, episodeScopes, first.serviceId);
      if (scope.relevant && !scope.conflict && scope.seasonNumber !== null) held.add(scope.seasonNumber);
    }
    return held;
  }

  private hasUnscopedQueueForGroup(group: WorkGroup, snapshot: LibrarySnapshot, queues: QueueReads): boolean {
    const first = group.members[0]?.work.unit;
    if (!first || first.kind !== 'tv' || queues.sonarr.kind !== 'known') return true;
    const episodeScopes = episodePhysicalScopes(snapshot);
    return queues.sonarr.records.some((row) => {
      if (row.status === 'failed' || row.trackedDownloadState === 'failed') return false;
      const scope = physicalQueueScope(row, episodeScopes, first.serviceId);
      return scope.relevant && (scope.conflict || scope.seasonNumber === null);
    });
  }

  private diverseGroupCandidates(candidates: GroupCandidate[], _context: PlanningContext): GroupCandidate[] {
    const remaining = [...candidates];
    const selected: GroupCandidate[] = [];
    const covered = new Set<string>();
    while (remaining.length && selected.length < PICKER_CANDIDATE_CAP) {
      remaining.sort((left, right) => {
        const score = (candidate: GroupCandidate) => candidate.capture.reduce((sum, coverage) => sum + (coverage.episodeIds?.filter((id) => !covered.has(`${coverage.workKey}:${id}`)).length ?? 1), 0);
        return score(right) - score(left) || (right.release.seeders ?? -1) - (left.release.seeders ?? -1);
      });
      const next = remaining.shift()!;
      selected.push(next);
      for (const coverage of next.capture) for (const id of coverage.episodeIds ?? []) covered.add(`${coverage.workKey}:${id}`);
    }
    return selected;
  }

  private refreshSelectedCoverage(group: WorkGroup, selected: GroupCandidate, _context: PlanningContext, fresh: { snapshot: LibrarySnapshot; queues: QueueReads; rows: ReconciledWork[] }): GroupCandidate | null {
    const originals = group.members.map((member) => member.work.unit);
    const verified = verifyGroupCoverage({ originalUnits: originals, actionableUnits: group.targets, parsed: parseReleaseCoverage(selected.release.title) });
    if (verified.kind !== 'covered') return null;
    const parsed = parseReleaseCoverage(selected.release.title);
    const advertisedExtraSeasons = new Set([...(selected.extraSeasons ?? []), ...verified.extraSeasons]);
    const wholeSeries = [selected.parsed, parsed].some((coverage) => coverage.kind === 'claims' && coverage.wholeSeries);
    const latestCapture = new Map(verified.capture.map((coverage) => [coverage.workKey, coverage]));
    const capture = selected.capture.flatMap((old) => {
      const latest = latestCapture.get(old.workKey);
      if (!latest || old.episodeIds === null || latest.episodeIds === null) return old.episodeIds === null && latest?.episodeIds === null ? [old] : [];
      const ids = old.episodeIds.filter((id) => latest.episodeIds!.includes(id));
      return ids.length ? [{ ...old, episodeIds: ids }] : [];
    });
    const active = group.members.flatMap((member) => member.activeCoverage);
    if (candidateOverlapsQueue(verified.requestedFootprint, active)) return null;
    // A complete fresh queue is mandatory immediately before reserving a physical release.
    if (fresh.queues[group.members[0]!.work.unit.arr].kind !== 'known') return null;
    const source = group.members[0]!.work.unit.arr === 'sonarr' ? fresh.snapshot.sonarr : fresh.snapshot.radarr;
    if (!source.known || (group.members[0]!.work.unit.arr === 'sonarr' && fresh.snapshot.sonarr.series.some((entry) =>
      entry.series.id === group.members[0]!.work.unit.serviceId && (!entry.known || entry.episodes === null)))) return null;
    const heldSeasons = this.groupHeldSeasons(group, fresh.snapshot, fresh.queues);
    if ([...advertisedExtraSeasons].some((season) => heldSeasons.has(season)) || (wholeSeries && heldSeasons.size > 0)) return null;
    if ((advertisedExtraSeasons.size > 0 || wholeSeries) && this.hasUnscopedQueueForGroup(group, fresh.snapshot, fresh.queues)) return null;
    return capture.length ? { ...selected, capture } : null;
  }

  private groupFootprintsOverlap(footprints: import('./group-types').TargetCoverage[][]): boolean {
    const atoms = footprints.map((footprint) => new Set(footprint.flatMap((coverage) => coverage.episodeIds === null
      ? [`movie:${coverage.workKey}`]
      : coverage.episodeIds.map((id) => `episode:${id}`))));
    for (let left = 0; left < atoms.length; left += 1) for (let right = left + 1; right < atoms.length; right += 1) {
      for (const atom of atoms[left]!) if (atoms[right]!.has(atom)) return true;
    }
    return false;
  }

  private finishNoSuitableRelease(keys: string[], token: string, searchResultCount: number, summary: CycleSummary): void {
    const details = JSON.stringify({ stage: 'candidate-filter', searchResultCount, candidateCount: 0 });
    for (const key of keys) {
      try {
        const result = this.deps.state.finishSearchWithReview({
          key,
          token,
          expectedStatus: 'searching',
          nextSearchAt: null,
          failCount: 0,
          outcome: 'no-suitable-release',
          now: this.now().toISOString(),
          decision: { workKey: key, verdict: 'manual', grabbed: false },
          review: { reason: 'no-suitable-release', details },
        });
        if (result.reviewCreated) summary.manualFlagged += 1;
      } catch (error) {
        this.logger.warn({ workKey: key, ...safeFailureMetadata('no-suitable-release', error) }, 'could not persist no-suitable-release hold under the owned lease');
      }
    }
  }

  private async finishGroupBackoff(_group: WorkGroup, keys: string[], token: string, error: unknown, summary: CycleSummary, retryAfter?: number, stage = 'group-processing'): Promise<void> {
    await this.finishOperationFailure(keys, token, error, stage, summary, retryAfter ?? (error instanceof ApiError ? error.retryAfter : undefined));
  }

  private async finishOperationFailure(
    keys: string[],
    token: string,
    error: unknown,
    stage: string,
    summary: CycleSummary,
    retryAfter?: number,
    alreadyCounted = false,
  ): Promise<void> {
    for (const key of keys) {
      const work = this.deps.state.getWorkItem(key);
      if (!work) continue;
      const expectedStatus = alreadyCounted ? 'backoff' : 'searching';
      if (work.status !== expectedStatus) continue;
      const hasUnresolvedIntent = this.deps.state.listGrabIntents().some((intent) => !intent.releasedAt && intent.status !== 'failed' && intent.status !== 'fulfilled' && intent.coverage.some((coverage) => coverage.workKey === key));
      if (!alreadyCounted && (work.blockedReason !== null || hasUnresolvedIntent)) continue;
      const failureKind: FailureOutcome = alreadyCounted
        ? work.lastOutcome === 'rate-limited' ? 'rate-limited' : 'operation-failure'
        : failureOutcome(error);
      const failCount = alreadyCounted ? work.failCount : nextFailureCount(work, failureKind);
      if (alreadyCounted && work.lastOutcome !== failureKind) continue;
      const escalated = failureKind === 'operation-failure' && !hasUnresolvedIntent && failCount >= MAX_CONSECUTIVE_OPERATION_FAILURES;
      const finalOutcome = escalated ? 'repeated-operation-failure' : failureKind;
      if (alreadyCounted && !escalated) continue; // rejectGrab already wrote the bounded backoff and counted exactly once.
      if (escalated) {
        try {
          const result = this.deps.state.finishSearchWithReview({
            key,
            token,
            expectedStatus,
            ...(alreadyCounted ? { expectedOutcome: work.lastOutcome ?? undefined, expectedFailCount: work.failCount } : {}),
            nextSearchAt: null,
            failCount,
            outcome: finalOutcome,
            now: this.now().toISOString(),
            review: { reason: 'repeated-operation-failure', details: safeFailureDetails(stage, error) },
          });
          if (result.reviewCreated) summary.manualFlagged += 1;
        } catch (writeError) {
          this.logger.warn({ workKey: key, ...safeFailureMetadata('failure-review', writeError) }, 'could not persist repeated-failure review under the owned lease');
        }
        continue;
      }
      try {
        this.deps.state.finishSearch({
          key,
          token,
          status: 'backoff',
          nextSearchAt: this.failureRetryAt(failCount, retryAfter),
          failCount,
          outcome: finalOutcome,
          now: this.now().toISOString(),
          expectedStatus,
        });
      } catch (writeError) {
        this.logger.warn({ workKey: key, ...safeFailureMetadata('failure-schedule', writeError) }, 'could not persist operation failure schedule under the owned lease');
      }
    }
  }

  private async finishGroupDecision(group: WorkGroup, keys: string[], token: string, selection: GroupSelection, outcome: string, backoffKeys: Set<string>, backoffFailures: Map<string, BackoffFailure>, summary: CycleSummary, deferred: number[] = [], actualProgress = false): Promise<void> {
    const manualKeys = new Set(selection.manualTargetIndices.map((index) => group.targets[index]?.key).filter((key): key is string => Boolean(key)));
    const deferredKeys = new Set(deferred.map((index) => group.targets[index]?.key).filter((key): key is string => Boolean(key)));
    for (const key of keys) {
      const work = this.deps.state.getWorkItem(key);
      if (!work) continue;
      if (backoffKeys.has(key)) {
        const failure = backoffFailures.get(key) ?? { error: new Error('group release failed'), stage: 'grab' };
        if (failure.disposition === 'uncertain') {
          if (work.status !== 'searching') continue;
          try {
            this.deps.state.finishSearch({ key, token, status: 'backoff', nextSearchAt: this.dateAfter(this.failureBaseMin), failCount: work.failCount, outcome: 'uncertain-grab', now: this.now().toISOString(), expectedStatus: 'searching' });
          } catch (writeError) {
            this.logger.warn({ workKey: key, ...safeFailureMetadata('uncertain-grab', writeError) }, 'could not persist uncertain-grab hold under the owned lease');
          }
        } else {
          await this.finishOperationFailure([key], token, failure.error, failure.stage, summary, failure.error instanceof ApiError ? failure.error.retryAfter : undefined, failure.disposition === 'already-counted');
        }
        continue;
      } else if (manualKeys.has(key)) {
        if (work.status !== 'searching') continue;
        try { this.deps.state.finishSearch({ key, token, status: 'manual', nextSearchAt: null, failCount: work.failCount, outcome: 'picker-manual', now: this.now().toISOString(), decision: { workKey: key, verdict: 'manual', grabbed: false } }); } catch { /* Safe on expiry. */ }
      } else {
        if (work.status !== 'searching') continue;
        const delay = actualProgress && deferredKeys.has(key) ? 5 : this.deps.config.minRetryHours * 60;
        const decision = outcome === 'group-grabbed' || outcome === 'group-no-grab' || outcome === 'group-release-failed' ? undefined : { workKey: key, verdict: selection.verdict, grabbed: false };
        try { this.deps.state.finishSearch({ key, token, status: 'cooldown', nextSearchAt: this.dateAfter(delay), failCount: 0, outcome, now: this.now().toISOString(), decision }); } catch { /* Safe on expiry. */ }
      }
    }
  }

  /** Human picks can bypass scheduling/manual status only; queue, coverage and ownership holds still apply. */
  async manualPick(workKey: string, releaseIndex: number): Promise<ManualPickResult> {
    const observed = await this.observeAndReconcile(true);
    const row = observed.rows.find((candidate) => candidate.work.workKey === workKey);
    if (!row) throw new Error(`work unit not currently eligible (no missing inventory or unknown key): ${workKey}`);
    if (row.blockedReason === 'claim-held') throw new Error('work unit is currently in-flight elsewhere');
    if (!row.eligibleUnit || (row.blockedReason !== null && row.blockedReason !== 'queue-active' && row.blockedReason !== 'active-intent')) throw new Error('work is held by current library or queue observations');
    if (!['ready', 'cooldown', 'manual'].includes(row.work.status)) throw new Error('manual pick bypasses cooldown only; work is not currently actionable');
    const clients = await this.deps.prowlarr.getDownloadClients();
    const clientId = { tv: this.resolveClientId(clients, this.deps.clientNames.tv), movie: this.resolveClientId(clients, this.deps.clientNames.movie) };
    const allowlist = await this.healthyIndexers();
    if (allowlist.length === 0) throw new Error('no healthy indexers; all cooling down');
    const token = this.deps.state.claimUnit(workKey, this.now());
    if (!token) throw new Error('work unit is currently in-flight elsewhere');
    try {
      const freshExisting = this.deps.state.listWorkItems();
      const freshIntents = this.openGrabIntents();
      const freshObservations = this.deps.state.listWorkQueueObservations();
      const freshManualKeys = this.manualReviewKeys(this.deps.state.listManualReview(), true);
      const freshResult = reconcileWork({
        snapshot: observed.snapshot, queues: observed.queues, existingWorkItems: freshExisting, intents: freshIntents,
        previousQueueCoverage: new Map(freshObservations.map((observation) => [observation.workKey, observation.coverage])),
        previousQueueFailureRefs: new Map(freshObservations.map((observation) => [observation.workKey, observation.failedQueueRefs])),
        now: this.now().toISOString(), minRetryHours: this.deps.config.minRetryHours,
        failureBackoffMin: this.failureBaseMin, failureBackoffMaxMin: this.failureCapMin,
        queueGraceMin: this.queueGraceMin, manualReviewKeys: freshManualKeys,
      });
      const freshRow = freshResult.items.find((candidate) => candidate.work.workKey === workKey);
      if (!freshRow?.eligibleUnit || (freshRow.blockedReason !== null && freshRow.blockedReason !== 'queue-active' && freshRow.blockedReason !== 'active-intent')) throw new Error('work is held by current library or queue observations');
      const persisted = this.deps.state.getWorkItem(workKey);
      if (!persisted || persisted.missingFingerprint !== freshRow.work.missingFingerprint) throw new Error('work changed before manual pick');
      if (!['ready', 'cooldown', 'manual'].includes(persisted.status)) throw new Error('manual pick bypasses cooldown only; work is not currently actionable');
      const recoveryAt = this.dateAfter(this.failureBaseMin);
      this.deps.state.startSearch({ key: workKey, token, now: this.now().toISOString(), recoveryAt });
      const unit = freshRow.eligibleUnit;
      const queries = await this.deps.planner.plan(unit);
      const releases: Release[] = [];
       for (const planned of queries) releases.push(...await this.recordedSearch(planned.query, planned.categories, allowlist, [unit], 'manual'));
      const candidates = this.admitCandidates(freshRow.work.unit, unit, this.buildCandidates(freshRow.work.unit, releases, this.emptySummary()), freshRow.activeCoverage);
      const judged = this.orderCandidates(candidates, unit.key);
      const candidate = judged[releaseIndex];
      if (!candidate) throw new Error(`releaseIndex ${releaseIndex} out of range (0..${judged.length - 1})`);
      const outcome = await this.grabPath(freshRow.work, freshRow.work.unit, judged, { verdict: 'grab', releaseIndex, reason: 'manual pick' }, clientId, token, observed.snapshot, observed.queues, this.emptySummary());
      return { outcome, releaseTitle: candidate.release.title, coveredEpisodeNumbers: candidate.coveredEpisodes?.map((episode) => episode.episodeNumber) ?? null, coverageBasis: candidate.coverageBasis };
    } catch (error) {
      await this.backoffClaimed(workKey, token, 'manual-pick-failed');
      throw error;
    } finally {
      this.deps.state.releaseClaim(workKey, token);
    }
  }

  private emptySummary(): CycleSummary {
    return { units: 0, searched: 0, grabbed: 0, dryRunGrabs: 0, manualFlagged: 0, skipped: 0 };
  }

  private async observeAndReconcile(manual: boolean, associationDecisions: AssociationDecision[] = [], deferAssociationReview = false): Promise<{ snapshot: LibrarySnapshot; queues: QueueReads; rows: ReconciledWork[] }> {
    const snapshot = await this.deps.watcher.getSnapshot();
    const queues = await this.readQueues();
    this.resolveImportedUnparseableReviews(snapshot);
    const initialWork = this.deps.state.listWorkItems();
    const initialIntents = this.openGrabIntents();
    const initialObservations = this.deps.state.listWorkQueueObservations();
    const initialReviews = this.deps.state.listManualReview();
    const initialManualKeys = this.manualReviewKeys(initialReviews, manual);
    const initial = reconcileWork({
      snapshot, queues, existingWorkItems: initialWork, intents: initialIntents, associationDecisions,
      previousQueueCoverage: new Map(initialObservations.map((observation) => [observation.workKey, observation.coverage])),
      previousQueueFailureRefs: new Map(initialObservations.map((observation) => [observation.workKey, observation.failedQueueRefs])),
      now: this.now().toISOString(), minRetryHours: this.deps.config.minRetryHours,
      failureBackoffMin: this.failureBaseMin, failureBackoffMaxMin: this.failureCapMin,
      queueGraceMin: this.queueGraceMin, manualReviewKeys: initialManualKeys,
    });
    const rows: ReconciledWork[] = [];
    for (const candidate of initial.items) {
      const key = candidate.work.workKey;
      const token = this.deps.state.claimUnit(key, this.now());
      if (!token) {
        rows.push({ ...candidate, eligibleUnit: null, blockedReason: 'claim-held' });
        continue;
      }
      try {
        // A claim only serializes writers; policy is recalculated from the current durable version under that claim.
        const existing = this.deps.state.listWorkItems();
        const intents = this.openGrabIntents();
        const observations = this.deps.state.listWorkQueueObservations();
        const reviewKeys = this.manualReviewKeys(this.deps.state.listManualReview(), manual);
        const persisted = existing.find((work) => work.workKey === key);
        const legacyDecisionAt = new Map<string, string>();
        if (!persisted) {
          const decidedAt = this.deps.state.lastDecisionAt(key);
          if (decidedAt) legacyDecisionAt.set(key, decidedAt);
        }
        const fresh = reconcileWork({
          snapshot, queues, existingWorkItems: existing, intents, associationDecisions,
          previousQueueCoverage: new Map(observations.map((observation) => [observation.workKey, observation.coverage])),
          previousQueueFailureRefs: new Map(observations.map((observation) => [observation.workKey, observation.failedQueueRefs])),
          now: this.now().toISOString(), minRetryHours: this.deps.config.minRetryHours,
          failureBackoffMin: this.failureBaseMin, failureBackoffMaxMin: this.failureCapMin,
          queueGraceMin: this.queueGraceMin, legacyDecisionAt, manualReviewKeys: reviewKeys,
        });
        const row = fresh.items.find((item) => item.work.workKey === key);
        if (!row) continue;
        if (persisted && Date.parse(snapshot.observedAt) < Date.parse(persisted.lastObservedAt) && row.work.missingFingerprint !== persisted.missingFingerprint) {
          rows.push({ ...row, work: persisted, eligibleUnit: null, blockedReason: 'library-observation-stale' });
          continue;
        }
        const queueRead = queues[row.work.unit.arr];
        if (row.blockedReason === 'library-unknown') {
          this.deps.state.applyWorkQueueObservation({ key, token, observedAt: queueRead.observedAt, known: false, coverage: [], failedQueueRefs: [] });
          rows.push(row);
          continue;
        }
        const related = fresh.intentUpdates.filter((update) => {
          const intent = intents.find((entry) => entry.id === update.id);
          return intent !== undefined && intentUpdateRelatesToWork(intent, row.work, existing, update.status);
        });
         this.deps.state.applyWorkReconciliation({ key, token, work: row.work, intentUpdates: related });
          this.deps.state.applyWorkQueueObservation({ key, token, observedAt: queueRead.observedAt, known: row.work.queueObservationKnown && queueRead.kind === 'known', coverage: row.queueCoverage, failedQueueRefs: row.queueFailureRefs });
         if (row.manualReviewReason && !(deferAssociationReview && row.blockedReason === 'queue-ambiguous')) {
           const reviewNow = this.now().toISOString();
           const linkedUncertain = queueRead.kind === 'known' && intents.find((intent) => intent.status === 'uncertain' && !intent.releasedAt && intent.confirmedAt === null && Date.parse(intent.queueDeadlineAt) <= Date.parse(reviewNow) && intent.coverage.some((capture) => capture.workKey === key));
           if (linkedUncertain) this.flagLinkedReviewOnce(key, row.manualReviewReason, linkedUncertain.id);
           else this.flagReviewOnce(key, row.manualReviewReason);
         }
        rows.push(row);
      } finally {
        this.deps.state.releaseClaim(key, token);
      }
    }
    return { snapshot, queues, rows };
  }

  private manualReviewKeys(reviews: Array<{ workKey: string; reason: string }>, manual: boolean): Set<string> {
    return new Set(reviews.filter((review) => manual
      ? ['queue-review', 'content-identity-changed'].includes(review.reason)
      : ['picker-manual', 'missing-download-client', 'reverify-failed', 'queue-review', 'content-identity-changed', 'no-suitable-release', 'repeated-operation-failure'].includes(review.reason)).map((review) => review.workKey));
  }

  private async readQueues(): Promise<QueueReads> {
    const observedAt = this.now().toISOString();
    const read = async <T>(arr: 'sonarr' | 'radarr', client: { getQueue(): Promise<T[]> } | undefined): Promise<QueueRead<T>> => {
      if (!client) return { kind: 'unknown', observedAt, errorCode: 'queue-client-missing' };
      try { return { kind: 'known', records: await client.getQueue(), observedAt: this.now().toISOString() }; }
      catch (error) {
        const code = `queue-${safeErrorCode(error)}`;
        this.logger.warn({ arr, ...safeFailureMetadata('queue-observation', error) }, 'Arr queue observation is unknown');
        return { kind: 'unknown', observedAt: this.now().toISOString(), errorCode: code };
      }
    };
    const [sonarr, radarr] = await Promise.all([read('sonarr', this.deps.sonarr), read('radarr', this.deps.radarr)]);
    return { sonarr: sonarr as QueueRead<SonarrQueueRecord>, radarr: radarr as QueueRead<RadarrQueueRecord> };
  }

  private resolveClientId(clients: { id: number; name: string }[], name: string): number | undefined {
    return clients.find((client) => client.name === name)?.id;
  }

  private async healthyIndexers(): Promise<number[]> {
    const [indexers, statuses] = await Promise.all([this.deps.prowlarr.getIndexers(), this.deps.prowlarr.getIndexerStatuses()]);
    const cooling = new Set(statuses.filter((status) => status.disabledTill !== null && Date.parse(status.disabledTill) > this.now().getTime()).map((status) => status.indexerId));
    return indexers.filter((indexer) => indexer.enable && !cooling.has(indexer.id)).map((indexer) => indexer.id);
  }

  private orderCandidates(candidates: Candidate[], workKey: string): Candidate[] {
    const ordered = [...candidates].sort((a, b) => (b.release.seeders ?? -1) - (a.release.seeders ?? -1));
    if (ordered.length > PICKER_CANDIDATE_CAP) {
      this.logger.info({ workKey, kept: PICKER_CANDIDATE_CAP, dropped: ordered.length - PICKER_CANDIDATE_CAP }, 'candidate list truncated before picker');
      ordered.length = PICKER_CANDIDATE_CAP;
    }
    return ordered;
  }

  private buildCandidates(unit: WorkUnit, releases: Release[], summary: CycleSummary): Candidate[] {
    const { state } = this.deps;
    const seenReleaseIds = new Set<string>();
    const filtered = releases.filter((release) => {
      if (release.protocol !== 'torrent' || !isGrabbable(release)) return false;
      const releaseId = JSON.stringify([release.indexerId, release.guid]);
      if (seenReleaseIds.has(releaseId) || state.hasRelease(release.indexerId, release.guid)) return false;
      seenReleaseIds.add(releaseId);
      return true;
    });
    const candidates: Candidate[] = [];
    for (const release of filtered) {
      const parsed = parseReleaseTitle(release.title);
      if (unit.kind === 'tv' && parsed.season === null && parsed.seasonEpisodes === null && parsed.absoluteEpisodes === null && parsed.seasonPack !== true) {
        this.flagUnparseable(unit, release.title, summary);
        continue;
      }
      const verified = verifyRelease({ unit, release, parsed });
      if (!verified.ok || (release.infoHash !== null && state.hasHash(release.infoHash))) continue;
      candidates.push({ release, coveredEpisodes: verified.kind === 'tv' ? verified.covered : null, coverageBasis: verified.kind === 'tv' ? verified.coverageBasis : null });
    }
    return candidates;
  }

  /** Parses against original inventory for overlap safety, but admits only currently actionable targets. */
  private admitCandidates(original: WorkUnit, actionable: WorkUnit, candidates: Candidate[], held: IntentCoverage[]): Candidate[] {
    const actionableIds = actionable.kind === 'tv' ? new Set(actionable.season?.missing.map((episode) => episode.episodeId) ?? []) : null;
    return candidates.flatMap((candidate) => {
      const originalCoverage = candidateCoverage(original, candidate);
      if (candidateOverlapsQueue(originalCoverage, held)) return [];
      if (original.kind === 'movie') return [candidate];
      if (actionableIds === null) return [];
      const coveredEpisodes = candidate.coveredEpisodes?.filter((episode) => actionableIds.has(episode.episodeId)) ?? [];
      return coveredEpisodes.length ? [{ ...candidate, coveredEpisodes }] : [];
    });
  }

  private flagUnparseable(unit: WorkUnit, releaseTitle: string, summary: CycleSummary): void {
    const evidence = { arr: unit.arr, serviceId: unit.serviceId, externalId: unit.externalId,
      episodeIds: unit.kind === 'tv' ? (unit.season?.missing.map(({ episodeId }) => episodeId) ?? []) : null };
    if (unit.kind === 'tv' && (!evidence.episodeIds || evidence.episodeIds.length === 0)) return;
    if (this.deps.state.flagUnparseableReview({ workKey: unit.key, details: releaseTitle, evidence, at: this.now() })) summary.manualFlagged++;
  }

  /** Automatic cleanup is deliberately limited to positive, identity-matched file observations. */
  private resolveImportedUnparseableReviews(snapshot: LibrarySnapshot): void {
    const snapshotObservedAt = parseReviewObservationTime(snapshot.observedAt);
    const now = this.now();
    const nowMs = now.getTime();
    if (snapshotObservedAt === null || !Number.isFinite(nowMs) || snapshotObservedAt > nowMs) return;
    const open = this.deps.state.listOpenUnparseableReviews();
    for (const review of open) {
      const token = this.deps.state.claimUnit(review.workKey, now);
      if (!token) continue;
      try {
        this.deps.state.initializeLegacyUnparseableReviews({ workKey: review.workKey, token, now: now.toISOString() });
        const current = this.deps.state.getManualReview(review.id);
        const createdAt = parseReviewObservationTime(current?.createdAt);
        if (!current || current.resolvedAt || current.reason !== 'unparseable-title' || current.subjectKind || current.subjectKey || current.targetEvidenceInvalid ||
          createdAt === null || snapshotObservedAt < createdAt) continue;
        const work = this.deps.state.getWorkItem(current.workKey);
        const workObservedAt = work ? parseReviewObservationTime(work.lastObservedAt) : null;
        if (work && (workObservedAt === null || snapshotObservedAt < workObservedAt)) continue;
        const evidence = current.targetEvidence;
        if (current.targetEvidenceKind === 'legacy-ineligible') {
          // Lost historical targets are not a permanent human task. Discard the obsolete
          // title warning once the current, identity-matched season is positively complete.
          // This does not fulfill or release intents, nor infer their historical coverage.
          if (!work || nowMs - snapshotObservedAt > WORK_OBSERVATION_STALE_AFTER_MS ||
            work.blockedReason === 'content-identity-changed' || this.deps.state.hasOpenManualReview(current.workKey, 'content-identity-changed') ||
            work.unit.kind !== 'tv' || work.unit.arr !== 'sonarr' || !snapshot.sonarr.known) continue;
          const key = /^sonarr:(0|[1-9]\d*):s(0|[1-9]\d*)$/.exec(current.workKey);
          if (!key || !Number.isSafeInteger(Number(key[1])) || !Number.isSafeInteger(Number(key[2])) ||
            Number(key[1]) !== work.unit.serviceId || Number(key[2]) !== work.unit.season?.seasonNumber) continue;
          const observed = snapshot.sonarr.series.find(({ series }) => series.id === work.unit.serviceId);
          if (!observed?.known || !observed.episodes || observed.series.tvdbId !== work.unit.externalId) continue;
          const inventory = observed.episodes.filter(({ seasonNumber }) => seasonNumber === work.unit.season!.seasonNumber);
          if (!inventory.length || !inventory.every(({ hasFile, seriesId }) => hasFile && seriesId === work.unit.serviceId) ||
            !work.unit.season.missing.every(({ episodeId }) => observed.episodes!.some((ep) => ep.id === episodeId && ep.seriesId === work.unit.serviceId && ep.hasFile))) continue;
          this.deps.state.deleteIneligibleUnparseableReview({ id: current.id, workKey: current.workKey, token, now: now.toISOString() });
          continue;
        }
        if (evidence) {
          if (!reviewEvidenceMatchesWorkKey(current.workKey, evidence)) continue;
          if (current.targetEvidenceKind === 'legacy' && (!work || work.blockedReason === 'content-identity-changed' || this.deps.state.hasOpenManualReview(current.workKey, 'content-identity-changed'))) continue;
          if (work && (work.unit.arr !== evidence.arr || work.unit.serviceId !== evidence.serviceId || work.unit.externalId !== evidence.externalId ||
            (work.unit.kind === 'tv' ? evidence.episodeIds === null : evidence.episodeIds !== null))) continue;
          if (evidence.arr === 'sonarr') {
            if (!snapshot.sonarr.known) continue;
            const series = snapshot.sonarr.series.find(({ series: item }) => item.id === evidence.serviceId);
            if (!series?.known || !series.episodes || series.series.tvdbId !== evidence.externalId || !evidence.episodeIds || !evidence.episodeIds.every((id) => series.episodes!.some((episode) => episode.id === id && episode.hasFile))) continue;
            if (current.targetEvidenceKind === 'legacy') { const season = Number(/:s(\d+)$/.exec(current.workKey)?.[1]); const inventory = series.episodes.filter((episode) => episode.seasonNumber === season); if (!inventory.length || !inventory.every(({ hasFile }) => hasFile)) continue; }
          } else {
            if (!snapshot.radarr.known) continue;
            const movie = snapshot.radarr.movies.find((item) => item.id === evidence.serviceId);
            if (!movie || movie.tmdbId !== evidence.externalId || !movie.hasFile) continue;
          }
        } else continue;
        this.deps.state.resolveUnparseableReview({ id: current.id, workKey: current.workKey, token, now: now.toISOString() });
      } finally {
        this.deps.state.releaseClaim(review.workKey, token);
      }
    }
  }

  private flagReviewOnce(workKey: string, reason: string, details?: string): boolean {
    const safeDetails = details === undefined ? null : details.slice(0, 200);
    const exists = this.deps.state.listManualReview().some((row) => row.workKey === workKey && row.reason === reason && row.details === safeDetails);
    if (exists) return false;
    this.deps.state.flagManualReview(workKey, reason, safeDetails ?? undefined, this.now());
    return true;
  }

  private flagLinkedReviewOnce(workKey: string, reason: string, intentId: string): void {
    const exists = this.deps.state.listManualReview().some((review) => review.workKey === workKey && review.reason === reason && review.subjectKind === 'intent' && review.subjectKey === intentId);
    if (!exists) this.deps.state.flagManualReviewLinked({ workKey, reason, intentId, at: this.now() });
  }

  private openGrabIntents() {
    return this.deps.state.listGrabIntents().filter((intent) => !intent.releasedAt);
  }

  private async grabPath(work: WorkItem, unit: WorkUnit, candidates: Candidate[], verdict: PickVerdict, clientId: { tv: number | undefined; movie: number | undefined }, token: string, snapshot: LibrarySnapshot, initialQueues: QueueReads, summary: CycleSummary): Promise<GrabOutcome> {
    const candidate = candidates[verdict.releaseIndex ?? -1];
    if (!candidate) throw new Error(`picker returned invalid releaseIndex ${verdict.releaseIndex}`);
    const verified = verifyRelease({ unit, release: candidate.release, parsed: parseReleaseTitle(candidate.release.title) });
    if (!verified.ok) {
      this.flagReviewOnce(unit.key, 'reverify-failed', verified.reason);
      this.deps.state.finishSearch({ key: unit.key, token, status: 'manual', nextSearchAt: null, failCount: work.failCount, outcome: 'reverify-failed', now: this.now().toISOString(), decision: { workKey: unit.key, verdict: 'manual', grabbed: false } });
      summary.manualFlagged++;
      return 'reverify-failed';
    }
    const targetId = unit.kind === 'tv' ? clientId.tv : clientId.movie;
    if (targetId === undefined) {
      const name = unit.kind === 'tv' ? this.deps.clientNames.tv : this.deps.clientNames.movie;
      this.flagReviewOnce(unit.key, 'missing-download-client', name);
      this.deps.state.finishSearch({ key: unit.key, token, status: 'manual', nextSearchAt: null, failCount: work.failCount, outcome: 'missing-download-client', now: this.now().toISOString(), decision: { workKey: unit.key, verdict: 'manual', grabbed: false } });
      summary.manualFlagged++;
      return 'missing-download-client';
    }
    const coverage = candidateCoverage(unit, candidate);
    const originalCoverage: IntentCoverage[] = [{ workKey: unit.key, episodeIds: verified.kind === 'tv' ? verified.covered.map((episode) => episode.episodeId) : null, basis: verified.kind === 'tv' ? verified.coverageBasis : null }];
    const freshQueue = await this.readQueue(unit.arr);
    if (freshQueue.kind === 'unknown') {
      await this.finishBackoff(work, token, new Error(freshQueue.errorCode));
      summary.skipped++;
      return 'reverify-failed';
    }
    const freshQueues = { ...initialQueues, [unit.arr]: freshQueue } as QueueReads;
    const freshWorkItems = this.deps.state.listWorkItems();
    const freshIntents = this.openGrabIntents();
    const freshObservations = this.deps.state.listWorkQueueObservations();
    const latestResult = reconcileWork({ snapshot, queues: freshQueues, existingWorkItems: freshWorkItems, intents: freshIntents, previousQueueCoverage: new Map(freshObservations.map((observation) => [observation.workKey, observation.coverage])), previousQueueFailureRefs: new Map(freshObservations.map((observation) => [observation.workKey, observation.failedQueueRefs])), now: this.now().toISOString(), minRetryHours: this.deps.config.minRetryHours, failureBackoffMin: this.failureBaseMin, failureBackoffMaxMin: this.failureCapMin, queueGraceMin: this.queueGraceMin });
    const latest = latestResult.items.find((row) => row.work.workKey === unit.key);
    if (latest && latest.blockedReason !== 'library-unknown') {
      const related = latestResult.intentUpdates.filter((update) => {
        const intent = freshIntents.find((entry) => entry.id === update.id);
        return intent !== undefined && intentUpdateRelatesToWork(intent, latest.work, freshWorkItems, update.status);
      });
      this.deps.state.applyWorkReconciliation({ key: unit.key, token, work: latest.work, intentUpdates: related });
      this.deps.state.applyWorkQueueObservation({ key: unit.key, token, observedAt: freshQueue.observedAt, known: latest.work.queueObservationKnown && freshQueue.kind === 'known', coverage: latest.queueCoverage, failedQueueRefs: latest.queueFailureRefs });
    }
    if (latest?.manualReviewReason) this.flagReviewOnce(unit.key, latest.manualReviewReason);
    if (!latest || latest.work.status !== 'searching' || ['queue-unknown', 'queue-review', 'queue-ambiguous', 'content-identity-changed'].includes(latest.blockedReason ?? '') || candidateOverlapsQueue(originalCoverage, latest.activeCoverage)) {
      if (latest?.work.status === 'searching') await this.finishBackoff(work, token, new Error('queue-overlap-or-unknown'));
      summary.skipped++;
      return 'reverify-failed';
    }
    if (this.deps.config.dryRun) {
      this.logger.info({ workKey: unit.key, releaseTitle: candidate.release.title, coveredEpisodes: candidate.coveredEpisodes?.map((episode) => episode.episodeNumber) ?? null, coverageBasis: candidate.coverageBasis, reason: sanitizeGrabReason(candidate.release, verdict.reason), targetClient: { name: unit.kind === 'tv' ? this.deps.clientNames.tv : this.deps.clientNames.movie, id: targetId } }, 'DRY_RUN: scheduling and decision only; no grab intent created');
      summary.dryRunGrabs++;
      this.finishCooldown(work, token, 'dry-run', { workKey: unit.key, releaseTitle: candidate.release.title, infoHash: candidate.release.infoHash ?? undefined, verdict: 'grab', grabbed: false });
      return 'dry-run';
    }
    const now = this.now().toISOString();
    const reserved = this.deps.state.beginGrab({ key: unit.key, token, fingerprint: work.missingFingerprint, release: { arr: unit.arr, indexerId: candidate.release.indexerId, guid: candidate.release.guid, infoHash: candidate.release.infoHash, releaseTitle: candidate.release.title }, coverage, now, deadline: new Date(Date.parse(now) + this.queueGraceMin * 60_000).toISOString() });
    if (!reserved.ok) {
      await this.finishBackoff(work, token, new Error(`reservation-${reserved.reason}`));
      summary.skipped++;
      return 'reverify-failed';
    }
    try {
      await this.deps.prowlarr.grab(candidate.release, targetId);
      this.deps.state.confirmGrab({ intentId: reserved.intentId, ownerToken: token, now: this.now().toISOString() });
      summary.grabbed++;
      try { this.finishCooldown(work, token, 'grab-confirmed', undefined, true); } catch { /* Receipt is durable even when the processing lease expired during the POST. */ }
      this.logger.info({ workKey: unit.key, releaseTitle: candidate.release.title, coverageBasis: candidate.coverageBasis, reason: sanitizeGrabReason(candidate.release, verdict.reason), downloadClientId: targetId }, 'grab confirmed via Prowlarr');
      return 'grabbed';
    } catch (error) {
      const attemptAt = this.now().toISOString();
      if (error instanceof ApiError && error.status >= 400 && error.status < 500) {
        const nextSearchAt = this.failureRetryAt(work.failCount + 1, error.retryAfter);
        this.deps.state.rejectGrab({ intentId: reserved.intentId, ownerToken: token, nextSearchAt, now: attemptAt });
        if (error.status === 429 || error.retryAfter !== undefined) {
          this.logger.warn({ workKey: unit.key, status: error.status, retryAfter: error.retryAfter }, 'Prowlarr grab rate limit; definitive rejection recorded');
          throw error;
        }
        throw new DefinitiveGrabError(error.status);
      }
      this.deps.state.markGrabUncertain({ intentId: reserved.intentId, ownerToken: token, now: attemptAt });
      throw new AmbiguousGrabError();
    }
  }

  private finishCooldown(work: WorkItem, token: string, outcome: string, decision?: { workKey: string; releaseTitle?: string; infoHash?: string; verdict: string; grabbed: boolean }, noDecision = false): void {
    this.deps.state.finishSearch({ key: work.workKey, token, status: 'cooldown', nextSearchAt: this.dateAfter(this.deps.config.minRetryHours * 60), failCount: 0, outcome, now: this.now().toISOString(), decision: noDecision ? undefined : decision });
  }

  private async finishBackoff(work: WorkItem, token: string, error: unknown, retryAfter?: number): Promise<void> {
    if (error instanceof DefinitiveGrabError || error instanceof AmbiguousGrabError) return;
    const failCount = work.failCount + 1;
    const retry = retryAfter ?? (error instanceof ApiError ? error.retryAfter : undefined);
    this.deps.state.finishSearch({ key: work.workKey, token, status: 'backoff', nextSearchAt: this.failureRetryAt(failCount, retry), failCount, outcome: safeErrorCode(error), now: this.now().toISOString() });
  }

  private async backoffClaimed(key: string, token: string, reason: string, error?: unknown): Promise<void> {
    const work = this.deps.state.getWorkItem(key);
    if (!work) return;
    try { await this.finishBackoff(work, token, error ?? new Error(reason)); }
    catch { /* The claim may have expired; never overwrite a successor's schedule. */ }
  }

  private failureRetryAt(failCount: number, retryAfter?: number): string {
    const exponential = Math.min(this.failureCapMin, this.failureBaseMin * 2 ** Math.max(0, failCount - 1));
    const delay = Math.max(exponential * 60, retryAfter ?? 0);
    return new Date(this.now().getTime() + delay * 1000).toISOString();
  }

  private dateAfter(minutes: number): string {
    return new Date(this.now().getTime() + minutes * 60_000).toISOString();
  }

  private async readQueue(arr: 'sonarr' | 'radarr'): Promise<QueueRead<SonarrQueueRecord | RadarrQueueRecord>> {
    const client = arr === 'sonarr' ? this.deps.sonarr : this.deps.radarr;
    const observedAt = this.now().toISOString();
    if (!client) return { kind: 'unknown', observedAt, errorCode: 'queue-client-missing' };
    try { return { kind: 'known', records: await client.getQueue(), observedAt: this.now().toISOString() }; }
    catch (error) { return { kind: 'unknown', observedAt: this.now().toISOString(), errorCode: `queue-${safeErrorCode(error)}` }; }
  }
}

class DefinitiveGrabError extends Error { constructor(readonly status: number) { super('definitive-grab-rejection'); } }
class AmbiguousGrabError extends Error { constructor() { super('ambiguous-grab-acknowledgment'); } }

function sanitizeGrabReason(release: Release, reason: string): string {
  let sanitized = reason;
  for (const secret of [release.guid, release.infoHash, release.magnetUrl, release.downloadUrl]) if (secret) sanitized = sanitized.split(secret).join('[redacted]');
  return sanitized.replace(/\bhttps?:\/\/\S+/gi, '[redacted]').replace(/\bmagnet:\S+/gi, '[redacted]').replace(/\b[0-9a-f]{8}-[0-9a-f-]{27,}\b/gi, '[redacted]').replace(/\b[0-9a-f]{32,}\b/gi, '[redacted]').slice(0, 500);
}
