import type { RadarrQueueRecord } from '../types/radarr';
import type { SonarrQueueRecord } from '../types/sonarr';
import type { GrabIntent, IntentCoverage, IntentStatus, QueueRead, WorkItem } from './work-queue-types';
import type { AssociationDecision } from './group-types';
import type { LibrarySnapshot, WorkUnit } from './watcher';
import { eligibleWorkUnits } from './watcher';

export interface QueueReads {
  sonarr: QueueRead<SonarrQueueRecord>;
  radarr: QueueRead<RadarrQueueRecord>;
}

export interface IntentUpdate {
  id: string;
  status: IntentStatus;
  lastSeenAt?: string | null;
  queueRefs?: string[];
}

export interface ReconciledWork {
  work: WorkItem;
  eligibleUnit: WorkUnit | null;
  queueCoverage: IntentCoverage[];
  queueFailureRefs: string[];
  activeCoverage: IntentCoverage[];
  blockedReason: string | null;
  intentUpdates: IntentUpdate[];
  manualReviewReason: string | null;
}

export interface ReconcileWorkInput {
  snapshot: LibrarySnapshot;
  queues: QueueReads;
  existingWorkItems: WorkItem[];
  intents: GrabIntent[];
  previousQueueCoverage?: ReadonlyMap<string, IntentCoverage[]>;
  previousQueueFailureRefs?: ReadonlyMap<string, string[]>;
  now: string;
  minRetryHours: number;
  failureBackoffMin?: number;
  failureBackoffMaxMin?: number;
  queueGraceMin: number;
  legacyDecisionAt?: ReadonlyMap<string, string>;
  manualReviewKeys?: ReadonlySet<string>;
  associationDecisions?: AssociationDecision[];
}

interface QueueAssociation {
  arr: 'sonarr' | 'radarr';
  queueRef: string;
  downloadId: string | null;
  healthy: boolean;
  scopeConflict: boolean;
  authoritative: boolean;
  workKey: string | null;
  coverage: IntentCoverage | null;
  scopeServiceId: number | null;
  scopeSeasonNumber: number | null;
  scopeUnknown: boolean;
  conflictWorkKey: string | null;
  directScopeServiceId: number | null;
  directScopeUnknown: boolean;
  directEpisodeId: number | null;
  stableQueueRef: boolean;
  status: 'active' | 'import-blocked' | 'failed' | 'uncertain';
  lastSeenAt: string;
}

function codeForQueue(row: { status?: string | null; trackedDownloadStatus?: string | null; trackedDownloadState?: string | null }): QueueAssociation['status'] {
  const state = row.trackedDownloadState;
  const status = row.status;
  if (state === 'failed' || status === 'failed') return 'failed';
  if (state === 'importBlocked' || row.trackedDownloadStatus === 'error') return 'import-blocked';
  const known = new Set(['unknown', 'queued', 'paused', 'downloading', 'completed', 'warning', 'delay', 'downloadClientUnavailable', 'fallback']);
  const knownStates = new Set(['downloading', 'importPending', 'importBlocked', 'importing', 'imported', 'failedPending', 'failed', 'ignored']);
  if ((status !== undefined && status !== null && !known.has(status)) || (state !== undefined && state !== null && !knownStates.has(state)) || status === 'unknown' || state === 'ignored' || state === 'failedPending') return 'uncertain';
  return 'active';
}

function healthyQueueRow(row: { status?: string | null; trackedDownloadStatus?: string | null; trackedDownloadState?: string | null }): boolean {
  const healthyStatuses = new Set(['queued', 'downloading', 'paused', 'completed', 'delay', 'fallback']);
  const healthyStates = new Set(['downloading', 'importPending', 'importing', 'imported']);
  return row.trackedDownloadStatus === 'ok' && typeof row.status === 'string' && healthyStatuses.has(row.status) &&
    typeof row.trackedDownloadState === 'string' && healthyStates.has(row.trackedDownloadState);
}

function makeQueueAssociations(snapshot: LibrarySnapshot, queues: QueueReads, now: string, decisions: AssociationDecision[] = []): QueueAssociation[] {
  const associations: QueueAssociation[] = [];
  if (queues.sonarr.kind === 'known') {
    const episodes = new Map<number, { serviceId: number; seasonNumber: number; episodeId: number }>();
    for (const observation of snapshot.sonarr.series) for (const episode of observation.episodes ?? []) episodes.set(episode.id, { serviceId: observation.series.id, seasonNumber: episode.seasonNumber, episodeId: episode.id });
    queues.sonarr.records.forEach((row, index) => {
      const downloadId = row.downloadId?.trim() || null;
      const queueRef = downloadId ? `download:${downloadId}` : row.id !== undefined && row.id !== null ? `row:${row.id}` : `sonarr-row:${index}`;
      const seriesId = row.seriesId ?? null;
      const episode = row.episodeId == null ? undefined : episodes.get(row.episodeId);
      const scopeConflict = Boolean(episode && ((seriesId !== null && episode.serviceId !== seriesId) ||
        (row.seasonNumber != null && row.seasonNumber !== episode.seasonNumber)));
      const knownEpisode = episode && !scopeConflict ? episode : undefined;
      const workKey = knownEpisode ? `sonarr:${knownEpisode.serviceId}:s${knownEpisode.seasonNumber}` : null;
      associations.push({
        arr: 'sonarr', queueRef, downloadId, healthy: healthyQueueRow(row), scopeConflict, authoritative: knownEpisode !== undefined,
        stableQueueRef: downloadId !== null || (row.id !== undefined && row.id !== null),
        workKey: knownEpisode ? workKey : null,
        coverage: knownEpisode ? { workKey: workKey!, episodeIds: [knownEpisode.episodeId], basis: 'explicit-episodes' } : null,
        scopeServiceId: seriesId ?? knownEpisode?.serviceId ?? null,
        scopeSeasonNumber: row.seasonNumber ?? knownEpisode?.seasonNumber ?? null,
        scopeUnknown: seriesId === null && row.episodeId == null,
        conflictWorkKey: scopeConflict && episode ? `sonarr:${episode.serviceId}:s${episode.seasonNumber}` : null,
        directScopeServiceId: seriesId ?? knownEpisode?.serviceId ?? null,
        directScopeUnknown: seriesId === null && row.episodeId == null,
        directEpisodeId: row.episodeId ?? null,
        status: codeForQueue(row), lastSeenAt: now,
      });
    });
  }
  if (queues.radarr.kind === 'known') {
    queues.radarr.records.forEach((row, index) => {
      const downloadId = row.downloadId?.trim() || null;
      const queueRef = downloadId ? `download:${downloadId}` : row.id !== undefined && row.id !== null ? `row:${row.id}` : `radarr-row:${index}`;
      const movieId = row.movieId ?? null;
      associations.push({
        arr: 'radarr', queueRef, downloadId, healthy: healthyQueueRow(row), scopeConflict: false, authoritative: movieId !== null,
        stableQueueRef: downloadId !== null || (row.id !== undefined && row.id !== null),
        workKey: movieId === null ? null : `radarr:${movieId}`,
        coverage: movieId === null ? null : { workKey: `radarr:${movieId}`, episodeIds: null, basis: null },
        scopeServiceId: movieId, scopeSeasonNumber: null, scopeUnknown: movieId === null,
        conflictWorkKey: null,
        directScopeServiceId: movieId, directScopeUnknown: movieId === null,
        directEpisodeId: null,
        status: codeForQueue(row), lastSeenAt: now,
      });
    });
  }
  // Apply only validated, durable decisions to rows which lacked an authoritative
  // media association. The original Arr records remain untouched; direct IDs always
  // win and fuzzy decisions can only add scoped holds, never prove fulfillment.
  const byQueueRef = new Map(decisions.map((decision) => [`${decision.arr}\0${decision.queueRef}`, decision]));
  const resolved: QueueAssociation[] = [];
  for (const association of associations) {
    const decision = byQueueRef.get(`${association.arr}\0${association.queueRef}`);
    if (decision && decision.arr !== association.arr) {
      resolved.push(association);
      continue;
    }
    if (decision?.outcome === 'unrelated' && association.status === 'active' && association.coverage === null && association.workKey === null && association.scopeServiceId === null && association.scopeUnknown) continue;
    if (!decision || decision.outcome !== 'matched' || association.coverage !== null || association.workKey !== null) {
      resolved.push(association);
      continue;
    }
    if (decision.arr !== association.arr || decision.mediaReferences.length !== 1) {
      resolved.push(association);
      continue;
    }
    const media = decision.mediaReferences[0]!;
    if (media.arr !== association.arr || (association.scopeServiceId !== null && association.scopeServiceId !== media.serviceId)) {
      resolved.push(association);
      continue;
    }
    if (decision.workReferences.length === 0) {
      resolved.push({ ...association, scopeServiceId: media.serviceId, scopeSeasonNumber: decision.seasonNumber, scopeUnknown: decision.potentialScope === 'unknown' });
      continue;
    }
    let appliedReference = false;
    for (const reference of decision.workReferences) {
      const work = inputWorkUnit(snapshot, reference.workKey);
      if (!work || work.arr !== association.arr || work.serviceId !== media.serviceId ||
        work.externalId !== media.externalId || work.kind !== (association.arr === 'sonarr' ? 'tv' : 'movie')) continue;
      let coverage: IntentCoverage | null = null;
      if (work.kind === 'movie' && decision.potentialScope === 'movie') coverage = { workKey: work.key, episodeIds: null, basis: null };
      else if (work.kind === 'tv' && decision.potentialScope === 'episodes' && decision.episodeIds?.length) {
        const ids = decision.episodeIds.filter((id) => work.season?.missing.some((episode) => episode.episodeId === id));
        if (ids.length) coverage = { workKey: work.key, episodeIds: ids, basis: decision.basis };
      } else if (work.kind === 'tv' && (decision.potentialScope === 'season' || decision.potentialScope === 'series')) {
        const scopeMatches = decision.potentialScope === 'series' || decision.seasonNumber === work.season?.seasonNumber;
        if (scopeMatches && (work.season?.missing.length ?? 0) > 0) coverage = {
          workKey: work.key,
          episodeIds: work.season!.missing.map((episode) => episode.episodeId),
          basis: decision.basis,
        };
      }
      resolved.push({
        ...association,
        workKey: coverage?.workKey ?? null,
        coverage,
        scopeServiceId: media.serviceId,
        scopeSeasonNumber: decision.seasonNumber,
        scopeUnknown: decision.potentialScope === 'unknown' || coverage === null,
      });
      appliedReference = true;
    }
    if (decision.workReferences.length === 0 || !appliedReference) resolved.push(association);
  }
  return resolved;
}

function inputWorkUnit(snapshot: LibrarySnapshot, workKey: string): WorkUnit | null {
  if (workKey.startsWith('radarr:')) {
    const id = Number(workKey.slice('radarr:'.length));
    const movie = snapshot.radarr.movies.find((entry) => entry.id === id);
    return movie ? { key: workKey, kind: 'movie', arr: 'radarr', serviceId: movie.id, externalId: movie.tmdbId, title: movie.title, year: movie.year, altTitles: [] } : null;
  }
  const match = /^sonarr:(\d+):s(-?\d+)$/.exec(workKey);
  if (!match) return null;
  const serviceId = Number(match[1]);
  const seasonNumber = Number(match[2]);
  const observation = snapshot.sonarr.series.find((entry) => entry.series.id === serviceId && entry.known && entry.episodes !== null);
  if (!observation) return null;
  const missing = observation.episodes!.filter((episode) => episode.seasonNumber === seasonNumber && episode.monitored && !episode.hasFile)
    .map((episode) => ({ episodeId: episode.id, episodeNumber: episode.episodeNumber, absoluteEpisodeNumber: episode.absoluteEpisodeNumber ?? null, title: episode.title }));
  return missing.length ? { key: workKey, kind: 'tv', arr: 'sonarr', serviceId, externalId: observation.series.tvdbId, title: observation.series.title, altTitles: observation.series.alternateTitles.map((alt) => alt.title), seriesType: observation.series.seriesType, season: { seasonNumber, missing } } : null;
}

function identity(unit: WorkUnit): string {
  return `${unit.arr}:${unit.serviceId}:${unit.externalId}:${unit.kind}`;
}

function missingFingerprint(unit: WorkUnit, eligibleIds: ReadonlySet<number>, movieEligible: boolean): string {
  const targets = unit.kind === 'tv'
    ? [...(unit.season?.missing ?? [])].sort((a, b) => a.episodeId - b.episodeId).map((episode) => [episode.episodeId, episode.episodeNumber, episode.absoluteEpisodeNumber, eligibleIds.has(episode.episodeId)])
    : [[unit.serviceId, movieEligible]];
  return JSON.stringify([identity(unit), targets]);
}

function copyUnit(unit: WorkUnit, missing: NonNullable<WorkUnit['season']>['missing']): WorkUnit {
  return unit.kind === 'tv' ? { ...unit, season: { seasonNumber: unit.season!.seasonNumber, missing } } : unit;
}

function terminalItem(old: WorkItem, status: 'fulfilled' | 'inactive', now: string): WorkItem {
  const unit = old.unit.kind === 'tv' ? { ...old.unit, season: { seasonNumber: old.unit.season!.seasonNumber, missing: [] } } : old.unit;
  return { ...old, unit, status, missingFingerprint: JSON.stringify([old.contentIdentity, []]), nextSearchAt: null, lastObservedAt: now, blockedReason: null,
    resetPendingAt: old.resetPendingAt && Date.parse(now) <= Date.parse(old.resetPendingAt) ? old.resetPendingAt : null };
}

function withQueueFreshness(
  work: WorkItem,
  snapshot: LibrarySnapshot,
  arr: 'sonarr' | 'radarr',
  queue: QueueRead<unknown>,
  now: string,
  previous: WorkItem = work,
): WorkItem {
  return queueReadFresh(snapshot, arr, queue, previous, now)
    ? { ...work, lastQueueObservedAt: queue.observedAt, queueObservationKnown: true }
    : { ...work, lastQueueObservedAt: previous.lastQueueObservedAt, queueObservationKnown: false };
}

function dueStatus(old: WorkItem | undefined, now: string, minRetryHours: number, legacyDecisionAt: string | undefined): Pick<WorkItem, 'status' | 'nextSearchAt' | 'lastSearchAt' | 'failCount' | 'lastOutcome'> {
  if (old) {
    let status = old.status;
    let nextSearchAt = old.nextSearchAt;
    if ((status === 'cooldown' || status === 'backoff' || status === 'searching') && (nextSearchAt === null || Date.parse(nextSearchAt) <= Date.parse(now))) {
      status = 'ready';
      nextSearchAt = null;
    }
    return { status, nextSearchAt, lastSearchAt: old.lastSearchAt, failCount: old.failCount, lastOutcome: old.lastOutcome };
  }
  if (legacyDecisionAt) {
    const nextSearchAt = new Date(Date.parse(legacyDecisionAt) + minRetryHours * 3_600_000).toISOString();
    if (Date.parse(nextSearchAt) > Date.parse(now)) return { status: 'cooldown', nextSearchAt, lastSearchAt: legacyDecisionAt, failCount: 0, lastOutcome: 'legacy-decision' };
  }
  return { status: 'ready', nextSearchAt: null, lastSearchAt: null, failCount: 0, lastOutcome: null };
}

function sameTargets(old: WorkItem, unit: WorkUnit): { added: boolean; removed: boolean } {
  const oldIds = new Set(old.unit.kind === 'tv' ? old.unit.season?.missing.map((episode) => episode.episodeId) ?? [] : [old.unit.serviceId]);
  const newIds = new Set(unit.kind === 'tv' ? unit.season?.missing.map((episode) => episode.episodeId) ?? [] : [unit.serviceId]);
  return { added: [...newIds].some((id) => !oldIds.has(id)), removed: [...oldIds].some((id) => !newIds.has(id)) };
}

function addsEligibleTargets(oldFingerprint: string, nextFingerprint: string): boolean {
  try {
    const oldValue: unknown = JSON.parse(oldFingerprint) as unknown;
    const nextValue: unknown = JSON.parse(nextFingerprint) as unknown;
    if (!Array.isArray(oldValue) || !Array.isArray(nextValue) || !Array.isArray(oldValue[1]) || !Array.isArray(nextValue[1])) return false;
    const oldTargets = new Map<unknown, unknown[]>();
    for (const target of oldValue[1]) if (Array.isArray(target)) oldTargets.set(target[0], target);
    return nextValue[1].some((target: unknown) => {
      if (!Array.isArray(target)) return false;
      const prior = oldTargets.get(target[0]);
      if (!prior) return target[target.length - 1] === true;
      return prior[prior.length - 1] !== true && target[target.length - 1] === true;
    });
  } catch {
    return false;
  }
}

function appliesToWork(row: QueueAssociation, work: WorkUnit): boolean {
  if (row.arr !== work.arr) return false;
  if (row.scopeConflict && row.conflictWorkKey === work.key) return true;
  if (row.scopeUnknown) return true;
  if (work.kind === 'movie') return row.workKey === work.key || row.scopeServiceId === work.serviceId;
  if (row.workKey === work.key) return true;
  if (row.scopeServiceId !== null && row.scopeServiceId === work.serviceId) return row.scopeSeasonNumber === null || row.scopeSeasonNumber === work.season?.seasonNumber;
  return false;
}

function coverageIntersects(left: IntentCoverage, right: IntentCoverage): boolean {
  if (left.workKey !== right.workKey) return false;
  if (left.episodeIds === null || right.episodeIds === null) return true;
  const ids = new Set(left.episodeIds);
  return right.episodeIds.some((id) => ids.has(id));
}

function subtractCoverage(prior: IntentCoverage[], observed: IntentCoverage[], captured: IntentCoverage[]): IntentCoverage[] {
  return mergeCoverage(prior.flatMap((previous) => {
    const blockers = [...observed, ...captured].filter((coverage) => coverage.workKey === previous.workKey);
    if (previous.episodeIds === null) return blockers.some((coverage) => coverage.episodeIds === null) ? [] : [previous];
    const ids = previous.episodeIds.filter((id) => !blockers.some((coverage) => coverage.episodeIds === null || coverage.episodeIds.includes(id)));
    return ids.length ? [{ ...previous, episodeIds: ids }] : [];
  }));
}

function sameWorkFamily(prior: WorkItem | undefined, current: WorkUnit): boolean {
  return Boolean(prior && prior.unit.kind === 'tv' && current.kind === 'tv' && prior.unit.arr === current.arr && prior.unit.serviceId === current.serviceId);
}

function projectCoverage(coverage: IntentCoverage, current: WorkUnit, existing: ReadonlyMap<string, WorkItem>): IntentCoverage | null {
  if (coverage.episodeIds === null) return current.kind === 'movie' && coverage.workKey === current.key ? { workKey: current.key, episodeIds: null, basis: null } : null;
  if (coverage.workKey !== current.key && !sameWorkFamily(existing.get(coverage.workKey), current)) return null;
  if (current.kind !== 'tv') return null;
  const currentIds = new Set(current.season?.missing.map((episode) => episode.episodeId) ?? []);
  const ids = coverage.episodeIds.filter((id) => currentIds.has(id));
  return ids.length ? { workKey: current.key, episodeIds: ids, basis: coverage.basis } : null;
}

function priorCoverageForCurrentWork(previous: ReadonlyMap<string, IntentCoverage[]>, existing: ReadonlyMap<string, WorkItem>, current: WorkUnit): IntentCoverage[] {
  return mergeCoverage([...previous.entries()].flatMap(([key, coverages]) => {
    if (key !== current.key && !sameWorkFamily(existing.get(key), current)) return [];
    return coverages.flatMap((coverage) => {
      const projected = projectCoverage(coverage, current, existing);
      return projected ? [projected] : [];
    });
  }));
}

function priorFailureRefsForCurrent(previous: ReadonlyMap<string, string[]>, existing: ReadonlyMap<string, WorkItem>, current: WorkUnit): Set<string> {
  const refs = new Set(previous.get(current.key) ?? []);
  if (current.kind === 'tv') for (const [key, values] of previous) {
    const prior = existing.get(key);
    if (key !== current.key && sameWorkFamily(prior, current)) {
      const targetIds = new Set(current.season?.missing.map((episode) => episode.episodeId) ?? []);
      for (const value of values) {
        const targetId = failureRefTargetId(value);
        if (typeof targetId === 'number' && targetIds.has(targetId)) refs.add(value);
      }
    }
  }
  return refs;
}

function failureEventRef(queueRef: string, targetId: number | string): string {
  return JSON.stringify([queueRef, targetId]);
}

function failureRefTargetId(value: string): number | string | null {
  try {
    const parsed: unknown = JSON.parse(value) as unknown;
    return Array.isArray(parsed) && parsed.length === 2 && typeof parsed[0] === 'string' && (typeof parsed[1] === 'number' || typeof parsed[1] === 'string') ? parsed[1] : null;
  } catch {
    return null;
  }
}

function mergeCoverage(coverages: IntentCoverage[]): IntentCoverage[] {
  const byKey = new Map<string, IntentCoverage>();
  for (const coverage of coverages) {
    const existing = byKey.get(coverage.workKey);
    if (!existing) {
      byKey.set(coverage.workKey, { ...coverage, episodeIds: coverage.episodeIds === null ? null : [...new Set(coverage.episodeIds)].sort((a, b) => a - b) });
    } else if (existing.episodeIds === null || coverage.episodeIds === null) {
      byKey.set(coverage.workKey, { workKey: coverage.workKey, episodeIds: null, basis: null });
    } else {
      byKey.set(coverage.workKey, { workKey: coverage.workKey, episodeIds: [...new Set([...existing.episodeIds, ...coverage.episodeIds])].sort((a, b) => a - b), basis: existing.basis === 'inferred-season-pack' || coverage.basis === 'inferred-season-pack' ? 'inferred-season-pack' : 'explicit-episodes' });
    }
  }
  return [...byKey.values()];
}

function capturedCoverageHasFiles(snapshot: LibrarySnapshot, intent: GrabIntent): boolean {
  return intent.coverage.every((coverage) => {
    if (coverage.episodeIds === null) return coverage.workKey.startsWith('radarr:') && snapshot.radarr.movies.some((movie) => `radarr:${movie.id}` === coverage.workKey && movie.hasFile);
    return coverage.episodeIds.every((id) => snapshot.sonarr.series.some((observation) => observation.known && observation.episodes?.some((episode) => episode.id === id && episode.hasFile)));
  });
}

interface QueueJob {
  arr: 'sonarr' | 'radarr';
  queueRef: string | null;
  rows: QueueAssociation[];
}

interface IntentQueueResolution {
  review: boolean;
  update?: IntentUpdate;
}

function remainingIntentCoverage(snapshot: LibrarySnapshot, intent: GrabIntent): IntentCoverage[] | null {
  const remaining = new Map<string, IntentCoverage>();
  for (const coverage of intent.coverage) {
    if (coverage.episodeIds === null) {
      if (intent.arr !== 'radarr' || !snapshot.radarr.known) return null;
      const movieMatch = /^radarr:(\d+)$/.exec(coverage.workKey);
      if (!movieMatch) return null;
      const movie = snapshot.radarr.movies.find((entry) => entry.id === Number(movieMatch[1]));
      if (!movie) return null;
      if (!movie.hasFile) remaining.set(coverage.workKey, { workKey: coverage.workKey, episodeIds: null, basis: null });
      continue;
    }
    if (intent.arr !== 'sonarr' || !snapshot.sonarr.known) return null;
    for (const episodeId of coverage.episodeIds) {
      let found: { workKey: string; hasFile: boolean } | null = null;
      for (const observation of snapshot.sonarr.series) {
        if (!observation.known || !observation.episodes) continue;
        const episode = observation.episodes.find((entry) => entry.id === episodeId);
        if (episode) {
          found = { workKey: `sonarr:${observation.series.id}:s${episode.seasonNumber}`, hasFile: episode.hasFile };
          break;
        }
      }
      if (!found) return null;
      if (found.hasFile) continue;
      const existing = remaining.get(found.workKey);
      if (existing?.episodeIds) existing.episodeIds.push(episodeId);
      else remaining.set(found.workKey, { workKey: found.workKey, episodeIds: [episodeId], basis: coverage.basis });
    }
  }
  return [...remaining.values()].map((coverage) => ({
    ...coverage,
    episodeIds: coverage.episodeIds === null ? null : [...new Set(coverage.episodeIds)].sort((a, b) => a - b),
  }));
}

function queueObservationsFresh(
  snapshot: LibrarySnapshot,
  queues: QueueReads,
  intent: GrabIntent,
  existingWorkItems: ReadonlyMap<string, WorkItem>,
  now: string,
): boolean {
  const queue = queues[intent.arr];
  if (!queueReadFresh(snapshot, intent.arr, queue, undefined, now)) return false;
  if (intent.arr === 'sonarr' && snapshot.sonarr.series.some((observation) => !observation.known || observation.episodes === null)) return false;
  const queueAt = Date.parse(queue.observedAt);
  if (intent.lastSeenAt && queueAt < Date.parse(intent.lastSeenAt)) return false;
  for (const coverage of intent.coverage) {
    const old = existingWorkItems.get(coverage.workKey);
    if (!queueReadFresh(snapshot, intent.arr, queue, old, now)) return false;
  }
  return true;
}

function queueReadFresh(
  snapshot: LibrarySnapshot,
  arr: 'sonarr' | 'radarr',
  queue: QueueRead<unknown>,
  old: WorkItem | undefined,
  now: string,
): boolean {
  if (queue.kind !== 'known' || (arr === 'sonarr' ? !snapshot.sonarr.known : !snapshot.radarr.known)) return false;
  const queueAt = Date.parse(queue.observedAt);
  const snapshotAt = Date.parse(snapshot.observedAt);
  const nowAt = Date.parse(now);
  if (![queueAt, snapshotAt, nowAt].every(Number.isFinite) || queueAt > nowAt || snapshotAt > nowAt || queueAt < snapshotAt) return false;
  if (old?.lastObservedAt && snapshotAt < Date.parse(old.lastObservedAt)) return false;
  if (old?.lastQueueObservedAt && queueAt < Date.parse(old.lastQueueObservedAt)) return false;
  return true;
}

function makeQueueJobs(associations: QueueAssociation[]): QueueJob[] {
  const jobs = new Map<string, QueueJob>();
  associations.forEach((row, index) => {
    const key = row.downloadId === null ? `${row.arr}\0row:${index}` : `${row.arr}\0download:${row.downloadId}`;
    const job = jobs.get(key) ?? { arr: row.arr, queueRef: row.downloadId === null ? null : row.queueRef, rows: [] };
    job.rows.push(row);
    jobs.set(key, job);
  });
  return [...jobs.values()];
}

function jobTouchesCoverage(job: QueueJob, coverage: IntentCoverage[], arr: 'sonarr' | 'radarr'): boolean {
  const directOverlap = job.rows.some((row) => row.authoritative && row.coverage && coverage.some((target) => coverageIntersects(target, row.coverage!)));
  if (job.rows.every((row) => row.authoritative && row.coverage !== null && !row.scopeConflict)) return directOverlap;
  if (directOverlap) return true;
  if (arr === 'radarr') {
    const movieIds = new Set(coverage.map((item) => item.workKey).filter((key) => key.startsWith('radarr:')).map((key) => Number(key.slice('radarr:'.length))));
    return job.rows.some((row) => row.directScopeServiceId !== null && movieIds.has(row.directScopeServiceId) || row.directScopeUnknown);
  }
  const episodeIds = new Set(coverage.flatMap((item) => item.episodeIds ?? []));
  const seriesIds = new Set(coverage.map((item) => /^sonarr:(\d+):s/.exec(item.workKey)?.[1]).filter((id): id is string => id !== undefined).map(Number));
  return job.rows.some((row) => row.directEpisodeId !== null && episodeIds.has(row.directEpisodeId) ||
    row.directScopeServiceId !== null && seriesIds.has(row.directScopeServiceId) || row.directScopeUnknown);
}

function jobHasDirectCoverage(job: QueueJob, coverage: IntentCoverage[], arr: 'sonarr' | 'radarr'): boolean {
  if (!job.queueRef || job.rows.length === 0 || job.rows.some((row) => row.scopeConflict || !row.authoritative || row.coverage === null)) return false;
  if (arr === 'radarr') {
    const movieKeys = new Set(coverage.filter((target) => target.episodeIds === null).map((target) => target.workKey));
    return job.rows.every((row) => row.coverage?.episodeIds === null && movieKeys.has(row.coverage.workKey)) &&
      coverage.every((target) => target.episodeIds === null && job.rows.some((row) => row.coverage?.workKey === target.workKey && row.coverage.episodeIds === null));
  }
  const seriesIds = new Set(coverage.map((target) => /^sonarr:(\d+):s/.exec(target.workKey)?.[1]).filter((id): id is string => id !== undefined));
  if (job.rows.some((row) => {
    const seriesId = row.coverage?.workKey.match(/^sonarr:(\d+):s/)?.[1];
    return row.coverage?.episodeIds === null || !seriesId || !seriesIds.has(seriesId);
  })) return false;
  return coverage.every((target) => target.episodeIds !== null && target.episodeIds.every((id) => job.rows.some((row) =>
    row.coverage?.workKey === target.workKey && row.coverage.episodeIds?.includes(id))));
}

function jobCoversAll(job: QueueJob, coverage: IntentCoverage[], arr: 'sonarr' | 'radarr'): boolean {
  return job.rows.every((row) => row.healthy) && jobHasDirectCoverage(job, coverage, arr);
}

function queueLinkResolutions(input: ReconcileWorkInput, associations: QueueAssociation[]): Map<string, IntentQueueResolution> {
  const resolutions = new Map<string, IntentQueueResolution>();
  const oldWork = new Map(input.existingWorkItems.map((work) => [work.workKey, work]));
  const jobsByArr = new Map<'sonarr' | 'radarr', QueueJob[]>([
    ['sonarr', makeQueueJobs(associations.filter((row) => row.arr === 'sonarr'))],
    ['radarr', makeQueueJobs(associations.filter((row) => row.arr === 'radarr'))],
  ]);
  for (const intent of input.intents) {
    if (!isOpenIntent(intent) || capturedCoverageHasFiles(input.snapshot, intent)) continue;
    if (!['submitting', 'awaiting-queue', 'active', 'import-blocked', 'uncertain'].includes(intent.status)) continue;
    if (!queueObservationsFresh(input.snapshot, input.queues, intent, oldWork, input.now)) continue;
    const remaining = remainingIntentCoverage(input.snapshot, intent);
    if (!remaining || remaining.length === 0) continue;
    const deadlinePassed = Date.parse(input.now) >= Date.parse(intent.queueDeadlineAt);
    const linkedRefs = [...new Set(intent.queueRefs)];
    if (intent.confirmedAt === null && linkedRefs.length === 0) {
      if (deadlinePassed) resolutions.set(intent.id, {
        review: true,
        ...(intent.status === 'uncertain' ? {} : { update: { id: intent.id, status: 'uncertain' } }),
      });
      continue;
    }
    if (intent.status === 'uncertain' && linkedRefs.length === 0) {
      if (deadlinePassed) resolutions.set(intent.id, { review: true });
      continue;
    }
    if (!['awaiting-queue', 'active', 'import-blocked', 'uncertain'].includes(intent.status)) continue;
    if (intent.coverage.some((coverage) => {
      const old = oldWork.get(coverage.workKey);
      const current = inputWorkUnit(input.snapshot, coverage.workKey);
      return old && current && old.contentIdentity !== identity(current);
    })) continue;
    if (intent.coverage.some((coverage) => oldWork.get(coverage.workKey)?.blockedReason === 'content-identity-changed' || oldWork.get(coverage.workKey)?.blockedReason === 'queue-unknown')) continue;

    const jobs = jobsByArr.get(intent.arr) ?? [];
    const potential = jobs.filter((job) => jobTouchesCoverage(job, remaining, intent.arr));
    let selected: QueueJob | undefined;
    let review = false;

    if (intent.status === 'import-blocked' && linkedRefs.length === 0) {
      review = true;
    } else if (linkedRefs.length > 0) {
      selected = linkedRefs.length === 1 ? jobs.find((job) => job.queueRef === linkedRefs[0]) : undefined;
      if (selected && jobHasDirectCoverage(selected, remaining, intent.arr) && selected.rows.some((row) => row.status === 'import-blocked')) {
        review = true;
        resolutions.set(intent.id, { review, update: { id: intent.id, status: 'import-blocked', lastSeenAt: input.queues[intent.arr].observedAt, queueRefs: linkedRefs } });
        continue;
      } else if (intent.status === 'import-blocked' && selected && jobHasDirectCoverage(selected, remaining, intent.arr)) {
        review = true;
        resolutions.set(intent.id, { review, update: { id: intent.id, status: 'import-blocked', lastSeenAt: input.queues[intent.arr].observedAt, queueRefs: linkedRefs } });
        continue;
      } else if (!selected || potential.length !== 1 || potential[0] !== selected || !jobHasDirectCoverage(selected, remaining, intent.arr)) review = true;
      else if (selected.rows.some((row) => row.status === 'failed' || row.status === 'uncertain') || !jobCoversAll(selected, remaining, intent.arr)) review = true;
    } else {
      const candidates = potential.filter((job) => jobCoversAll(job, remaining, intent.arr));
      const competingIntent = input.intents.some((other) => {
        if (other.id === intent.id || !isOpenIntent(other) || other.arr !== intent.arr) return false;
        if (other.queueRefs.some((ref) => candidates.some((job) => job.queueRef === ref))) return true;
        const otherCoverage = remainingIntentCoverage(input.snapshot, other);
        return Boolean(otherCoverage && candidates.some((job) => jobTouchesCoverage(job, otherCoverage, other.arr)));
      });
      const occupied = candidates.some((job) => input.intents.some((other) => other.id !== intent.id && isOpenIntent(other) && other.arr === intent.arr && other.queueRefs.includes(job.queueRef!)));
      if (potential.length === 1 && candidates.length === 1 && !competingIntent && !occupied) selected = candidates[0];
      else if (deadlinePassed) review = true;
    }

    if (selected && !review) {
      if (intent.confirmedAt !== null && intent.status !== 'uncertain') {
        const observedAt = input.queues[intent.arr].observedAt;
        resolutions.set(intent.id, { review: false, update: { id: intent.id, status: 'active', lastSeenAt: observedAt, queueRefs: [selected.queueRef!] } });
      }
    } else if (review || (deadlinePassed && linkedRefs.length > 0)) {
      resolutions.set(intent.id, { review: true });
    } else if (deadlinePassed) {
      resolutions.set(intent.id, { review: true, ...(intent.confirmedAt === null ? { update: { id: intent.id, status: 'uncertain' } } : {}) });
    }
  }
  return resolutions;
}

function isOpenIntent(intent: GrabIntent): boolean {
  return !intent.releasedAt && intent.status !== 'failed' && intent.status !== 'fulfilled';
}

/** Pure and conservative library/queue reconciliation. Unknown observations can hold work but never fulfill it. */
export function reconcileWork(input: ReconcileWorkInput): { items: ReconciledWork[]; intentUpdates: IntentUpdate[] } {
  const eligible = eligibleWorkUnits(input.snapshot);
  const eligibleByKey = new Map(eligible.map((unit) => [unit.key, unit]));
  const eligibleIdsByKey = new Map<string, Set<number>>();
  for (const unit of eligible) eligibleIdsByKey.set(unit.key, new Set(unit.season?.missing.map((episode) => episode.episodeId) ?? []));
  const currentUnits = new Map<string, WorkUnit>();
  for (const observation of input.snapshot.sonarr.series) {
    if (!observation.known || !observation.series.monitored || !observation.episodes) continue;
    const bySeason = new Map<number, NonNullable<WorkUnit['season']>>();
    for (const episode of observation.episodes) {
      if (!episode.monitored || episode.hasFile) continue;
      const season = bySeason.get(episode.seasonNumber) ?? { seasonNumber: episode.seasonNumber, missing: [] };
      season.missing.push({ episodeId: episode.id, episodeNumber: episode.episodeNumber, absoluteEpisodeNumber: episode.absoluteEpisodeNumber ?? null, title: episode.title });
      bySeason.set(episode.seasonNumber, season);
    }
    for (const season of bySeason.values()) currentUnits.set(`sonarr:${observation.series.id}:s${season.seasonNumber}`, {
      key: `sonarr:${observation.series.id}:s${season.seasonNumber}`, kind: 'tv', arr: 'sonarr', serviceId: observation.series.id,
      externalId: observation.series.tvdbId, title: observation.series.title, altTitles: observation.series.alternateTitles.map((alt) => alt.title),
      seriesType: observation.series.seriesType, season,
    });
  }
  if (input.snapshot.radarr.known) for (const movie of input.snapshot.radarr.movies) {
    if (movie.monitored && !movie.hasFile) currentUnits.set(`radarr:${movie.id}`, { key: `radarr:${movie.id}`, kind: 'movie', arr: 'radarr', serviceId: movie.id, externalId: movie.tmdbId, title: movie.title, year: movie.year, altTitles: [] });
  }
  const rawQueueAssociations = makeQueueAssociations(input.snapshot, input.queues, input.now);
  const associations = input.associationDecisions?.length
    ? makeQueueAssociations(input.snapshot, input.queues, input.now, input.associationDecisions)
    : rawQueueAssociations;
  const existing = new Map(input.existingWorkItems.map((work) => [work.workKey, work]));
  const intentQueueLinks = queueLinkResolutions(input, rawQueueAssociations);
  const allKeys = new Set([...currentUnits.keys(), ...existing.keys()]);
  const result: ReconciledWork[] = [];
  const intentUpdates: IntentUpdate[] = [];
  for (const intent of input.intents) {
    if (!isOpenIntent(intent)) continue;
    if (capturedCoverageHasFiles(input.snapshot, intent)) {
      intentUpdates.push({ id: intent.id, status: 'fulfilled', lastSeenAt: input.snapshot.observedAt });
      continue;
    }
    const update = intentQueueLinks.get(intent.id)?.update;
    if (update) intentUpdates.push(update);
  }

  for (const key of allKeys) {
    const old = existing.get(key);
    const savedQueueFailureRefs = input.previousQueueFailureRefs?.get(key) ?? [];
    const unit = currentUnits.get(key);
    const arr = old?.unit.arr ?? unit?.arr ?? (key.startsWith('radarr:') ? 'radarr' : 'sonarr');
    const source = arr === 'sonarr' ? input.snapshot.sonarr : input.snapshot.radarr;
    const seriesObservation = arr === 'sonarr' && old ? input.snapshot.sonarr.series.find((entry) => entry.series.id === old.unit.serviceId) : undefined;
    const sourceKnown = source.known && (arr !== 'sonarr' || !seriesObservation || seriesObservation.known);
    if (!sourceKnown) {
      if (old) result.push({ work: withQueueFreshness(old, input.snapshot, arr, { kind: 'unknown', observedAt: input.queues[arr].observedAt, errorCode: 'library-association-unknown' }, input.now, old), eligibleUnit: null, queueCoverage: [], queueFailureRefs: input.previousQueueFailureRefs?.get(key) ?? [], activeCoverage: [], blockedReason: 'library-unknown', intentUpdates: [], manualReviewReason: null });
      continue;
    }
    let current = unit;
    if (!current && old) {
      if (arr === 'sonarr' && seriesObservation?.series.monitored === false) {
        const item = terminalItem(old, 'inactive', input.snapshot.observedAt);
        result.push({ work: withQueueFreshness(item, input.snapshot, arr, input.queues[arr], input.now, old), eligibleUnit: null, queueCoverage: [], queueFailureRefs: savedQueueFailureRefs, activeCoverage: [], blockedReason: null, intentUpdates: [], manualReviewReason: null });
        continue;
      }
      if (arr === 'sonarr' && seriesObservation && seriesObservation.known && seriesObservation.episodes) {
        const observations = seriesObservation.episodes;
        const oldEpisodes = old.unit.season?.missing ?? [];
        const currentOld = oldEpisodes.map((prior) => observations.find((episode) => episode.id === prior.episodeId));
        if (currentOld.length > 0 && currentOld.every((episode) => episode?.hasFile === true)) {
          result.push({ work: withQueueFreshness(terminalItem(old, 'fulfilled', input.snapshot.observedAt), input.snapshot, arr, input.queues[arr], input.now, old), eligibleUnit: null, queueCoverage: [], queueFailureRefs: savedQueueFailureRefs, activeCoverage: [], blockedReason: null, intentUpdates: [], manualReviewReason: null });
          continue;
        }
        if (currentOld.every((episode) => episode === undefined || episode.monitored === false)) {
          result.push({ work: withQueueFreshness(terminalItem(old, 'inactive', input.snapshot.observedAt), input.snapshot, arr, input.queues[arr], input.now, old), eligibleUnit: null, queueCoverage: [], queueFailureRefs: savedQueueFailureRefs, activeCoverage: [], blockedReason: null, intentUpdates: [], manualReviewReason: null });
          continue;
        }
      }
      if (arr === 'radarr') {
        const movie = input.snapshot.radarr.movies.find((entry) => entry.id === old.unit.serviceId);
        if (!movie || !movie.monitored) {
          result.push({ work: withQueueFreshness(terminalItem(old, 'inactive', input.snapshot.observedAt), input.snapshot, arr, input.queues[arr], input.now, old), eligibleUnit: null, queueCoverage: [], queueFailureRefs: savedQueueFailureRefs, activeCoverage: [], blockedReason: null, intentUpdates: [], manualReviewReason: null });
          continue;
        }
        if (movie.hasFile) {
          result.push({ work: withQueueFreshness(terminalItem(old, 'fulfilled', input.snapshot.observedAt), input.snapshot, arr, input.queues[arr], input.now, old), eligibleUnit: null, queueCoverage: [], queueFailureRefs: savedQueueFailureRefs, activeCoverage: [], blockedReason: null, intentUpdates: [], manualReviewReason: null });
          continue;
        }
      }
      if (old) {
        // A season with no current missing targets is terminal after a complete positive library observation.
        const item = terminalItem(old, 'inactive', input.snapshot.observedAt);
        result.push({ work: withQueueFreshness(item, input.snapshot, arr, input.queues[arr], input.now, old), eligibleUnit: null, queueCoverage: [], queueFailureRefs: savedQueueFailureRefs, activeCoverage: [], blockedReason: null, intentUpdates: [], manualReviewReason: null });
      }
      continue;
    }
    if (!current) continue;
    const eligibleUnit = eligibleByKey.get(key) ?? null;
    const eligibleIds = eligibleIdsByKey.get(key) ?? new Set<number>();
    const contentIdentity = identity(current);
    const fingerprint = missingFingerprint(current, eligibleIds, current.kind === 'movie' && eligibleUnit !== null);
    let scheduling = dueStatus(old, input.now, input.minRetryHours, input.legacyDecisionAt?.get(key));
    const targetChange = old ? sameTargets(old, current) : { added: false, removed: false };
    let blockedReason: string | null = null;
    let manualReviewReason: string | null = null;
    if (old && old.contentIdentity !== contentIdentity) {
      blockedReason = 'content-identity-changed';
      for (const intent of input.intents) if (isOpenIntent(intent) && intent.coverage.some((coverage) => coverage.workKey === key) && intent.status !== 'failed' && intent.status !== 'fulfilled' && intent.confirmedAt === null) intentUpdates.push({ id: intent.id, status: 'uncertain' });
      manualReviewReason = 'content-identity-changed';
    } else if (old && old.missingFingerprint !== fingerprint && (targetChange.added || addsEligibleTargets(old.missingFingerprint, fingerprint))) {
      if (scheduling.status === 'cooldown') scheduling = { ...scheduling, status: 'ready', nextSearchAt: null };
    }
    if (eligibleUnit && (scheduling.status === 'waiting-release' || scheduling.status === 'fulfilled' || scheduling.status === 'inactive')) scheduling = { ...scheduling, status: 'ready', nextSearchAt: null };
    const queueFresh = queueReadFresh(input.snapshot, arr, input.queues[arr], old, input.now);
    if (!queueFresh) blockedReason = blockedReason ?? 'queue-unknown';
    const scopedQueue = queueFresh ? associations.filter((row) => appliesToWork(row, current!)) : [];
    const activeQueue = scopedQueue.filter((row) => row.status !== 'failed');
    let ambiguousQueue = scopedQueue.some((row) => row.coverage === null);
    const nowMs = Date.parse(input.now);
    const projectedIntents = new Map<string, { intent: GrabIntent; coverage: IntentCoverage[] }>();
    for (const intent of input.intents) {
      if (!isOpenIntent(intent)) continue;
      const belongs = intent.coverage.some((item) => item.workKey === key || (item.episodeIds !== null && sameWorkFamily(existing.get(item.workKey), current)));
      if (!belongs) continue;
      if (capturedCoverageHasFiles(input.snapshot, intent)) continue;
      const coverage = mergeCoverage(intent.coverage.flatMap((item) => {
        const projected = projectCoverage(item, current, existing);
        return projected ? [projected] : [];
      }));
      if (coverage.length === 0) continue;
      projectedIntents.set(intent.id, { intent, coverage });
    }
    const localIntents = [...projectedIntents.values()];
    const capturedCoverage = localIntents.flatMap((item) => item.coverage);
    const queueCoverage = mergeCoverage(activeQueue.flatMap((row) => row.coverage ? [row.coverage] : []).flatMap((coverage) => {
      const projected = projectCoverage(coverage, current!, existing);
      return projected ? [projected] : [];
    }));
    const observedQueueCoverage = mergeCoverage(activeQueue.flatMap((row) => row.coverage ? [row.coverage] : []).flatMap((coverage) => {
      const projected = projectCoverage(coverage, current!, existing);
      return projected ? [projected] : [];
    }));
    const previousQueueCoverage = priorCoverageForCurrentWork(input.previousQueueCoverage ?? new Map(), existing, current);
    const reviewWasResolved = old?.blockedReason === 'queue-review' && input.manualReviewKeys !== undefined && !input.manualReviewKeys.has(key);
    const vanishedCoverage = reviewWasResolved
      ? []
      : queueFresh && input.queues[arr].kind === 'known' && !ambiguousQueue
        ? subtractCoverage(previousQueueCoverage, observedQueueCoverage, capturedCoverage)
        : !queueFresh || ambiguousQueue ? previousQueueCoverage : [];
    const queueDisappeared = queueFresh && input.queues[arr].kind === 'known' && !ambiguousQueue && vanishedCoverage.length > 0;
    if (queueDisappeared) {
      blockedReason = 'queue-review';
      manualReviewReason = 'queue-review';
      scheduling = { ...scheduling, status: 'manual', nextSearchAt: null };
    }
    for (const { intent } of localIntents) {
      if (intentQueueLinks.get(intent.id)?.review) {
        blockedReason = 'queue-review';
        manualReviewReason = 'queue-review';
        scheduling = { ...scheduling, status: 'manual', nextSearchAt: null };
      }
    }
    const queueFailureRefs = priorFailureRefsForCurrent(input.previousQueueFailureRefs ?? new Map(), existing, current);
    const failedByQueueRef = new Map<string, QueueAssociation[]>();
    for (const row of scopedQueue) if (row.status === 'failed') {
      const group = failedByQueueRef.get(row.queueRef) ?? [];
      group.push(row);
      failedByQueueRef.set(row.queueRef, group);
    }
    for (const [queueRef, failedRows] of failedByQueueRef) {
      if (localIntents.some(({ intent }) => intent.queueRefs.includes(queueRef))) continue;
      const eventRefs = new Set<string>();
      for (const row of failedRows) {
        if (!row.coverage) continue;
        if (current.kind === 'movie' && row.coverage.episodeIds === null && row.coverage.workKey === current.key) eventRefs.add(failureEventRef(queueRef, current.key));
        else if (current.kind === 'tv' && row.coverage.episodeIds !== null) {
          const missingIds = new Set(current.season?.missing.map((episode) => episode.episodeId) ?? []);
          const intentHeldIds = new Set(localIntents
            .filter(({ intent }) => !intent.queueRefs.includes(queueRef))
            .flatMap(({ coverage }) => coverage.filter((item) => item.workKey === current.key).flatMap((item) => item.episodeIds ?? [])));
          for (const id of row.coverage.episodeIds) if (missingIds.has(id) && !intentHeldIds.has(id)) eventRefs.add(failureEventRef(queueRef, id));
        }
      }
      if (!failedRows.some((row) => row.stableQueueRef)) {
        if (eventRefs.size > 0) ambiguousQueue = true;
        continue;
      }
      const newEvents = [...eventRefs].filter((ref) => !queueFailureRefs.has(ref));
      if (newEvents.length === 0) continue;
      for (const ref of newEvents) queueFailureRefs.add(ref);
      const failCount = Math.max(1, (old?.failCount ?? 0) + 1);
      const delayMin = Math.min(input.failureBackoffMaxMin ?? 60, (input.failureBackoffMin ?? 5) * 2 ** (failCount - 1));
      scheduling = { status: 'backoff', nextSearchAt: new Date(nowMs + delayMin * 60_000).toISOString(), lastSearchAt: old?.lastSearchAt ?? null, failCount, lastOutcome: 'queue-failed' };
    }
    const heldQueueCoverage = mergeCoverage([...queueCoverage, ...vanishedCoverage]);
    const allCoverage = mergeCoverage([...heldQueueCoverage, ...capturedCoverage]);
    if (input.manualReviewKeys?.has(key)) {
      scheduling = { ...scheduling, status: 'manual' };
      blockedReason = blockedReason ?? 'manual-review';
    } else if (scheduling.status === 'manual' && (old?.status === 'manual' || reviewWasResolved)) {
      scheduling = { ...scheduling, status: 'ready', nextSearchAt: null };
    }
    if (old?.blockedReason === 'queue-review' && !reviewWasResolved) {
      scheduling = { ...scheduling, status: 'manual', nextSearchAt: null };
      blockedReason = 'queue-review';
      manualReviewReason = 'queue-review';
    }
    if (current.kind === 'movie' && !currentIsAvailable(input.snapshot, current)) {
      scheduling = { ...scheduling, status: 'waiting-release' };
      blockedReason = blockedReason ?? 'waiting-release';
    }
    const unsupportedAssocHold = ambiguousQueue || activeQueue.some((row) => row.status === 'uncertain');
    if (unsupportedAssocHold) {
      blockedReason = blockedReason ?? 'queue-ambiguous';
      manualReviewReason = manualReviewReason ?? 'queue-review';
    }
    else if (heldQueueCoverage.length > 0) blockedReason = blockedReason ?? 'queue-active';
    else if (localIntents.length > 0) blockedReason = blockedReason ?? 'active-intent';
    if (blockedReason === 'queue-review') {
      scheduling = { ...scheduling, status: 'manual', nextSearchAt: null };
    }
    let residual = eligibleUnit;
    if (eligibleUnit?.kind === 'tv') {
      const held = new Set(allCoverage.flatMap((coverage) => coverage.workKey === key ? coverage.episodeIds ?? [] : []));
      const remaining = (eligibleUnit.season?.missing ?? []).filter((episode) => !held.has(episode.episodeId));
      residual = remaining.length ? copyUnit(eligibleUnit, remaining) : null;
    } else if (eligibleUnit && allCoverage.some((coverage) => coverage.workKey === key && coverage.episodeIds === null)) residual = null;
    if (blockedReason === 'queue-unknown' || blockedReason === 'queue-ambiguous' || blockedReason === 'queue-review' || blockedReason === 'content-identity-changed' || blockedReason === 'manual-review') residual = null;
    if (localIntents.length > 0 && residual?.kind === 'tv' && (residual.season?.missing.length ?? 0) === 0) residual = null;
    if (!residual && !blockedReason && current.kind === 'tv' && eligibleUnit === null) {
      scheduling = { ...scheduling, status: 'waiting-release' };
      blockedReason = 'waiting-release';
    }
    const work: WorkItem = {
      workKey: key, contentIdentity, missingFingerprint: fingerprint, unit: current, ...scheduling,
      lastObservedAt: input.snapshot.observedAt,
      lastQueueObservedAt: queueFresh && input.queues[arr].kind === 'known' ? input.queues[arr].observedAt : old?.lastQueueObservedAt ?? null,
      queueObservationKnown: queueFresh,
      blockedReason,
      resetPendingAt: old?.resetPendingAt && Date.parse(input.snapshot.observedAt) <= Date.parse(old.resetPendingAt) ? old.resetPendingAt : null,
    };
    result.push({ work, eligibleUnit: residual, queueCoverage: heldQueueCoverage, queueFailureRefs: [...queueFailureRefs], activeCoverage: allCoverage, blockedReason, intentUpdates: [], manualReviewReason });
  }

  // A queue-wide unknown read still produces blocked rows for known work retained through source errors.
  const latestIntentUpdates = new Map<string, IntentUpdate>();
  const updatePriority: Record<IntentStatus, number> = { submitting: 0, 'awaiting-queue': 0, uncertain: 1, active: 2, 'import-blocked': 3, failed: 3, fulfilled: 4 };
  for (const update of intentUpdates) {
    const previous = latestIntentUpdates.get(update.id);
    if (!previous || updatePriority[update.status] >= updatePriority[previous.status]) latestIntentUpdates.set(update.id, update);
  }
  return { items: result, intentUpdates: [...latestIntentUpdates.values()] };
}

function currentIsAvailable(snapshot: LibrarySnapshot, unit: WorkUnit): boolean {
  if (unit.kind !== 'movie') return true;
  return snapshot.radarr.movies.find((movie) => movie.id === unit.serviceId)?.isAvailable ?? false;
}

/** Candidate admission is always checked against original missing inventory, not a queue-trimmed picker unit. */
export function candidateOverlapsQueue(candidate: IntentCoverage[], queued: IntentCoverage[]): boolean {
  return candidate.some((coverage) => queued.some((active) => coverageIntersects(coverage, active)));
}
