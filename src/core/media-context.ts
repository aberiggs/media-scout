import type { SonarrQueueRecord } from '../types/sonarr';
import type { RadarrQueueRecord } from '../types/radarr';
import type {
  ActiveDownloadSummary,
  ActiveWorkReference,
  AssociationDecision,
  ExpectedTargetDescription,
  GroupCandidate,
  OpenWorkSummary,
  PlanningContext,
  SourceKnowledge,
  TargetCoverage,
  WorkGroup,
} from './group-types';
import type { GrabIntent, IntentCoverage, WorkStatus } from './work-queue-types';
import type { QueueReads, ReconciledWork } from './work-queue';
import { eligibleWorkUnits, type LibrarySnapshot, type WorkUnit } from './watcher';

const OPEN_STATUSES: readonly WorkStatus[] = ['ready', 'waiting-release', 'searching', 'cooldown', 'backoff', 'manual'];
const SAFE_TARGET_BLOCKS = new Set([null, 'queue-active', 'active-intent']);

/** Stable IDs are scoped to one already-grouped work family, never guessed from titles. */
export function trimWorkUnitByActiveCoverage(unit: WorkUnit, coverage: IntentCoverage[]): WorkUnit | null {
  if (unit.kind === 'movie') {
    return coverage.some((entry) => entry.workKey === unit.key && entry.episodeIds === null) ? null : unit;
  }
  const held = new Set(coverage.flatMap((entry) => entry.episodeIds ?? []));
  const missing = (unit.season?.missing ?? []).filter((episode) => !held.has(episode.episodeId));
  return missing.length === 0 ? null : { ...unit, season: { seasonNumber: unit.season!.seasonNumber, missing } };
}

function groupKey(unit: WorkUnit): string {
  return `${unit.arr}:${unit.serviceId}`;
}

function isOpen(row: ReconciledWork): boolean {
  return OPEN_STATUSES.includes(row.work.status);
}

function rowCanSupplyTarget(row: ReconciledWork): boolean {
  return (row.work.status === 'ready' || row.work.status === 'cooldown') &&
    row.eligibleUnit !== null && SAFE_TARGET_BLOCKS.has(row.blockedReason);
}

/** Groups only supplied, aired/available residual targets; unready siblings remain members/context. */
export function buildWorkGroups(input: { snapshot: LibrarySnapshot; rows: ReconciledWork[]; now: string }): WorkGroup[] {
  const eligibleByKey = new Map(eligibleWorkUnits(input.snapshot).map((unit) => [unit.key, unit]));
  const groups = new Map<string, ReconciledWork[]>();
  for (const row of input.rows) {
    if (!isOpen(row)) continue;
    const key = groupKey(row.work.unit);
    const members = groups.get(key) ?? [];
    members.push(row);
    groups.set(key, members);
  }

  const result: WorkGroup[] = [];
  for (const [key, members] of groups) {
    const relatedCoverage = members.flatMap((member) => member.activeCoverage);
    const targets: WorkUnit[] = [];
    const dueTargetIndices: number[] = [];
    for (const member of members) {
      if (!rowCanSupplyTarget(member)) continue;
      const original = eligibleByKey.get(member.work.workKey);
      if (!original) continue;
      const activeResidual = trimWorkUnitByActiveCoverage(original, relatedCoverage);
      if (!activeResidual) continue;

      // The reconciler's residual is the policy ceiling; stable IDs prevent widening it.
      let target = activeResidual;
      if (original.kind === 'tv') {
        const allowedIds = new Set(member.eligibleUnit?.season?.missing.map((episode) => episode.episodeId) ?? []);
        const missing = (activeResidual.season?.missing ?? []).filter((episode) => allowedIds.has(episode.episodeId));
        if (missing.length === 0) continue;
        target = { ...activeResidual, season: { seasonNumber: activeResidual.season!.seasonNumber, missing } };
      }
      const targetIndex = targets.length;
      targets.push(target);
      const due = member.work.status === 'ready' &&
        (member.work.nextSearchAt === null || Date.parse(member.work.nextSearchAt) <= Date.parse(input.now));
      if (due) dueTargetIndices.push(targetIndex);
    }
    if (dueTargetIndices.length > 0) result.push({ key, members, targets, dueTargetIndices });
  }
  return result;
}

function expectedTargets(unit: WorkUnit): ExpectedTargetDescription[] {
  if (unit.kind === 'movie') return [{ description: unit.title, seasonNumber: null, episodeNumber: null, absoluteEpisodeNumber: null }];
  return (unit.season?.missing ?? []).map((episode) => ({
    description: episode.title,
    seasonNumber: unit.season!.seasonNumber,
    episodeNumber: episode.episodeNumber,
    absoluteEpisodeNumber: episode.absoluteEpisodeNumber,
  }));
}

function openWorkSummary(row: ReconciledWork): OpenWorkSummary {
  const missingCount = row.work.unit.kind === 'movie' ? 1 : row.work.unit.season?.missing.length ?? 0;
  const eligibleCount = row.eligibleUnit === null ? 0 : row.eligibleUnit.kind === 'movie' ? 1 : row.eligibleUnit.season?.missing.length ?? 0;
  return {
    workKey: row.work.workKey,
    title: row.work.unit.title,
    kind: row.work.unit.kind,
    seriesType: row.work.unit.seriesType ?? null,
    seasonNumber: row.work.unit.season?.seasonNumber ?? null,
    missingCount,
    eligibleCount,
    heldCount: Math.max(0, missingCount - eligibleCount),
    expectedTargets: expectedTargets(row.work.unit),
    status: row.work.status,
    nextSearchAt: row.work.nextSearchAt,
  };
}

function knownSource(arr: 'sonarr' | 'radarr', snapshot: LibrarySnapshot, queues: QueueReads): SourceKnowledge {
  const queue = queues[arr];
  if (arr === 'sonarr') {
    const failedObservation = snapshot.sonarr.series.find((observation) => !observation.known);
    const known = snapshot.sonarr.known && failedObservation === undefined;
    return {
      arr,
      library: known
        ? { kind: 'known', observedAt: snapshot.observedAt }
        : { kind: 'unknown', observedAt: snapshot.observedAt, errorCode: snapshot.sonarr.errorCode ?? failedObservation?.errorCode ?? 'library-observation-unknown' },
      queue: queue.kind === 'known'
        ? { kind: 'known', observedAt: queue.observedAt }
        : { kind: 'unknown', observedAt: queue.observedAt, errorCode: queue.errorCode },
    };
  }
  return {
    arr,
    library: snapshot.radarr.known
      ? { kind: 'known', observedAt: snapshot.observedAt }
      : { kind: 'unknown', observedAt: snapshot.observedAt, errorCode: snapshot.radarr.errorCode ?? 'library-observation-unknown' },
    queue: queue.kind === 'known'
      ? { kind: 'known', observedAt: queue.observedAt }
      : { kind: 'unknown', observedAt: queue.observedAt, errorCode: queue.errorCode },
  };
}

function publicTitle(value: string | null | undefined, secrets: Array<string | null | undefined> = []): string | null {
  if (value == null) return null;
  let result = value;
  for (const secret of secrets) if (secret) result = result.split(secret).join('[redacted]');
  result = result
    .replace(/https?:\/\/\S+/gi, '[redacted-url]')
    .replace(/magnet:\S+/gi, '[redacted-magnet]')
    .replace(/\b[0-9a-f]{8}-[0-9a-f-]{27,}\b/gi, '[redacted-id]')
    .replace(/\b[0-9a-f]{32,}\b/gi, '[redacted-hash]')
    .replace(/([?&]apikey=)[^&\s]+/gi, '$1[redacted]');
  return result;
}

function queueReference(arr: 'sonarr' | 'radarr', row: SonarrQueueRecord | RadarrQueueRecord, index: number): string {
  return row.downloadId ? `download:${row.downloadId}` : row.id !== undefined && row.id !== null ? `row:${row.id}` : `${arr}-row:${index}`;
}

function queueStatusUnknown(status: string | null, trackedStatus: string | null, trackedState: string | null): boolean {
  const statuses = new Set(['unknown', 'queued', 'paused', 'downloading', 'completed', 'failed', 'warning', 'delay', 'downloadClientUnavailable', 'fallback']);
  const tracking = new Set(['ok', 'warning', 'error']);
  const states = new Set(['downloading', 'importBlocked', 'importPending', 'importing', 'imported', 'failedPending', 'failed', 'ignored']);
  return status === null || status === 'unknown' || !statuses.has(status) ||
    (trackedStatus !== null && !tracking.has(trackedStatus)) ||
    (trackedState !== null && !states.has(trackedState)) || trackedState === 'ignored' || trackedState === 'failedPending';
}

function suppliedWorkReference(rows: ReconciledWork[], workKey: string): ReconciledWork | undefined {
  return rows.find((row) => row.work.workKey === workKey && isOpen(row));
}

function workReference(row: ReconciledWork, scope: ActiveWorkReference['scope'], episodeIds: number[] | null, basis: ActiveWorkReference['basis']): ActiveWorkReference {
  const seasonNumber = scope === 'series' || scope === 'unknown' ? null : row.work.unit.season?.seasonNumber ?? null;
  return { workKey: row.work.workKey, scope, seasonNumber, episodeIds, basis };
}

function addUniqueReference(target: ActiveWorkReference[], reference: ActiveWorkReference): void {
  if (!target.some((item) => item.workKey === reference.workKey && item.scope === reference.scope && JSON.stringify(item.episodeIds) === JSON.stringify(reference.episodeIds))) target.push(reference);
}

function directQueueReferences(
  arr: 'sonarr' | 'radarr',
  record: SonarrQueueRecord | RadarrQueueRecord,
  snapshot: LibrarySnapshot,
  rows: ReconciledWork[],
): ActiveWorkReference[] {
  const refs: ActiveWorkReference[] = [];
  if (arr === 'radarr') {
    const movieId = (record as RadarrQueueRecord).movieId;
    if (movieId === undefined || movieId === null) return refs;
    const row = suppliedWorkReference(rows, `radarr:${movieId}`);
    if (row) addUniqueReference(refs, workReference(row, 'movie', null, null));
    return refs;
  }

  const tvRecord = record as SonarrQueueRecord;
  const episode = tvRecord.episodeId == null
    ? undefined
    : snapshot.sonarr.series.flatMap((observation) => observation.episodes ?? []).find((item) => item.id === tvRecord.episodeId && (tvRecord.seriesId == null || item.seriesId === tvRecord.seriesId));
  if (episode) {
    const row = suppliedWorkReference(rows, `sonarr:${episode.seriesId}:s${episode.seasonNumber}`);
    if (row) addUniqueReference(refs, workReference(row, 'episodes', [episode.id], 'explicit-episodes'));
    return refs;
  }
  if (tvRecord.seriesId == null) return refs;
  for (const row of rows) {
    if (!isOpen(row) || row.work.unit.arr !== 'sonarr' || row.work.unit.kind !== 'tv' || row.work.unit.serviceId !== tvRecord.seriesId) continue;
    if (tvRecord.seasonNumber != null && row.work.unit.season?.seasonNumber !== tvRecord.seasonNumber) continue;
    addUniqueReference(refs, workReference(row, tvRecord.seasonNumber === null ? 'series' : 'season', null, null));
  }
  return refs;
}

interface QueueAggregate {
  arr: 'sonarr' | 'radarr';
  refs: Set<string>;
  title: string | null;
  status: string | null;
  trackedStatus: string | null;
  trackedState: string | null;
  workReferences: ActiveWorkReference[];
  uncertainty: ActiveDownloadSummary['uncertainty'];
  surrogate: string;
}

function addDecisionReferences(aggregate: QueueAggregate, reference: string, decisions: AssociationDecision[], rows: ReconciledWork[]): void {
  const decision = decisions.find((item) => item.arr === aggregate.arr && item.queueRef === reference);
  if (!decision || decision.outcome === 'unrelated') return;
  for (const validated of decision.workReferences) {
    const row = suppliedWorkReference(rows, validated.workKey);
    if (!row || row.work.unit.arr !== validated.arr || row.work.unit.serviceId !== validated.serviceId || row.work.unit.externalId !== validated.externalId) continue;
    const episodes = decision.potentialScope === 'episodes' && row.work.unit.kind === 'tv'
      ? (decision.episodeIds ?? []).filter((id) => row.work.unit.kind === 'tv' && row.work.unit.season?.missing.some((episode) => episode.episodeId === id))
      : null;
    addUniqueReference(aggregate.workReferences, workReference(row, decision.potentialScope, episodes?.length ? episodes : null, episodes?.length ? decision.basis : null));
  }
  if (decision.outcome === 'uncertain' && aggregate.workReferences.length === 0) aggregate.uncertainty = 'unknown-association';
}

/** Builds safe queue and intent summaries while keeping all source identifiers private. */
function activeSummaries(input: { snapshot: LibrarySnapshot; rows: ReconciledWork[]; queues: QueueReads; intents: GrabIntent[]; associations: AssociationDecision[] }): ActiveDownloadSummary[] {
  const aggregates = new Map<string, QueueAggregate>();
  const queueRefToAggregate = new Map<string, QueueAggregate>();
  let nextSurrogate = 0;
  const addQueueRecord = (arr: 'sonarr' | 'radarr', record: SonarrQueueRecord | RadarrQueueRecord, index: number): void => {
    const queueRef = queueReference(arr, record, index);
    if (record.status === 'failed' || record.trackedDownloadState === 'failed') return;
    const identity = record.downloadId ? `${arr}:download:${record.downloadId}` : `${arr}:${queueRef}`;
    let aggregate = aggregates.get(identity);
    if (!aggregate) {
      const status = record.status ?? null;
      const trackedStatus = record.trackedDownloadStatus ?? null;
      const trackedState = record.trackedDownloadState ?? null;
      aggregate = {
        arr, refs: new Set(), title: publicTitle(record.title, [record.downloadId]), status, trackedStatus, trackedState,
        workReferences: [],
        uncertainty: queueStatusUnknown(status, trackedStatus, trackedState) ? 'unknown-status' : 'none',
        surrogate: `queue-${nextSurrogate++}`,
      };
      aggregates.set(identity, aggregate);
    }
    aggregate.refs.add(queueRef);
    queueRefToAggregate.set(queueRef, aggregate);
    for (const ref of directQueueReferences(arr, record, input.snapshot, input.rows)) addUniqueReference(aggregate.workReferences, ref);
    addDecisionReferences(aggregate, queueRef, input.associations, input.rows);
    if (aggregate.workReferences.length === 0 && aggregate.uncertainty === 'none') aggregate.uncertainty = 'unknown-association';
  };

  if (input.queues.sonarr.kind === 'known') input.queues.sonarr.records.forEach((record, index) => addQueueRecord('sonarr', record, index));
  if (input.queues.radarr.kind === 'known') input.queues.radarr.records.forEach((record, index) => addQueueRecord('radarr', record, index));

  const openIntents = input.intents.filter((intent) => !['failed', 'fulfilled'].includes(intent.status));
  for (const intent of openIntents) {
    const matched = intent.queueRefs.map((ref) => queueRefToAggregate.get(ref)).find((aggregate) => aggregate?.arr === intent.arr);
    const aggregate = matched ?? {
      arr: intent.arr,
      refs: new Set<string>(),
      title: publicTitle(intent.releaseTitle, [intent.guid, intent.infoHash, intent.ownerToken]),
      status: `intent-${intent.status}`,
      trackedStatus: null,
      trackedState: null,
      workReferences: [],
      uncertainty: intent.status === 'uncertain' ? 'unknown-association' as const : 'none' as const,
      surrogate: `intent-${nextSurrogate++}`,
    };
    if (!matched) aggregates.set(`${intent.arr}:intent:${nextSurrogate}`, aggregate);
    for (const coverage of intent.coverage) {
      const row = suppliedWorkReference(input.rows, coverage.workKey);
      if (!row || row.work.unit.arr !== intent.arr) continue;
      addUniqueReference(aggregate.workReferences, workReference(row, coverage.episodeIds === null ? 'movie' : coverage.episodeIds.length === 1 ? 'episodes' : 'episodes', coverage.episodeIds, coverage.basis));
    }
    if (intent.status === 'uncertain') aggregate.uncertainty = 'unknown-association';
  }
  return [...aggregates.values()].map(({ surrogate, title, status, trackedStatus, trackedState, workReferences, uncertainty, arr }) => ({
    surrogate: `${arr}-${surrogate}`,
    title,
    status,
    trackedStatus,
    trackedState,
    workReferences,
    uncertainty,
  }));
}

/** Global work, active queue, and source-read context; no absent queue becomes an empty known read. */
export function buildPlanningContext(input: {
  snapshot: LibrarySnapshot;
  rows: ReconciledWork[];
  queues: QueueReads;
  intents: GrabIntent[];
  associations?: AssociationDecision[];
}): PlanningContext {
  const openWork = input.rows.filter(isOpen).map(openWorkSummary);
  return {
    openWork,
    activeDownloads: activeSummaries({ ...input, associations: input.associations ?? [] }),
    sourceKnowledge: [knownSource('sonarr', input.snapshot, input.queues), knownSource('radarr', input.snapshot, input.queues)],
  };
}

function sanitizeExpectedTarget(target: ExpectedTargetDescription, kind: WorkUnit['kind']): Record<string, unknown> {
  return kind === 'tv'
    ? {
        seasonNumber: target.seasonNumber,
        episodeNumber: target.episodeNumber,
        absoluteEpisodeNumber: target.absoluteEpisodeNumber,
        expectedEpisodeTitle: publicTitle(target.description),
      }
    : { libraryTargetDescription: publicTitle(target.description) };
}

function publicOpenWork(context: PlanningContext): Array<Record<string, unknown>> {
  return context.openWork.map((work) => ({
    workKey: work.workKey,
    title: publicTitle(work.title),
    kind: work.kind,
    seriesType: work.seriesType,
    seasonNumber: work.seasonNumber,
    missingCount: work.missingCount,
    eligibleCount: work.eligibleCount,
    heldCount: work.heldCount,
    expectedTargets: work.expectedTargets.map((target) => sanitizeExpectedTarget(target, work.kind)),
    status: work.status,
    nextSearchAt: work.nextSearchAt,
  }));
}

function publicContext(context: PlanningContext): Record<string, unknown> {
  return {
    openWork: publicOpenWork(context),
    activeDownloads: context.activeDownloads.map((download) => ({
      surrogate: download.surrogate,
      title: publicTitle(download.title),
      status: download.status,
      trackedStatus: download.trackedStatus,
      trackedState: download.trackedState,
      workReferences: download.workReferences.map((reference) => ({
        workKey: reference.workKey,
        scope: reference.scope,
        seasonNumber: reference.seasonNumber,
        episodeIds: reference.episodeIds,
        basis: reference.basis,
      })),
      uncertainty: download.uncertainty,
    })),
    sourceKnowledge: context.sourceKnowledge.map((source) => ({
      arr: source.arr,
      library: source.library,
      queue: source.queue,
    })),
  };
}

function publicTarget(unit: WorkUnit, targetIndex: number): Record<string, unknown> {
  return {
    targetIndex,
    title: publicTitle(unit.title),
    altTitles: unit.altTitles.map((title) => publicTitle(title)),
    kind: unit.kind,
    year: unit.year ?? null,
    tmdbId: unit.kind === 'movie' ? unit.externalId : null,
    tvdbId: unit.kind === 'tv' ? unit.externalId : null,
    seriesType: unit.seriesType ?? null,
    seasonNumber: unit.season?.seasonNumber ?? null,
    expectedTargets: expectedTargets(unit).map((target) => sanitizeExpectedTarget(target, unit.kind)),
  };
}

/** Sanitized JSON text shared with the planner. Only supplied target indices can be addressed. */
export function serializeGroupPlannerInput(input: { group: WorkGroup; context: PlanningContext }): string {
  return JSON.stringify({
    dueTargetIndices: [...input.group.dueTargetIndices],
    targets: input.group.targets.map(publicTarget),
    context: publicContext(input.context),
  });
}

function coverageForPrompt(coverages: TargetCoverage[], group: WorkGroup): Array<Record<string, unknown>> {
  return coverages.map((coverage) => {
    type PromptTargetCoverage = { targetIndex: number; episodeNumbers: number[] | null; basis: TargetCoverage['basis'] };
    const matches = group.targets.flatMap<PromptTargetCoverage>((unit, targetIndex): PromptTargetCoverage[] => {
      if (unit.key !== coverage.workKey) return [];
      if (unit.kind === 'movie') return coverage.episodeIds === null ? [{ targetIndex, episodeNumbers: null, basis: coverage.basis }] : [];
      const episodes = new Set(unit.season?.missing.filter((episode) => coverage.episodeIds?.includes(episode.episodeId)).map((episode) => episode.episodeNumber) ?? []);
      return episodes.size > 0 ? [{ targetIndex, episodeNumbers: [...episodes].sort((a, b) => a - b), basis: coverage.basis }] : [];
    });
    return { targets: matches };
  });
}

function advertisedScope(candidate: GroupCandidate): Record<string, unknown> {
  if (candidate.parsed.kind !== 'claims') return { kind: candidate.parsed.kind };
  return {
    kind: 'claims',
    seasonClaims: candidate.parsed.seasonClaims,
    absoluteEpisodes: candidate.parsed.absoluteEpisodes,
    unqualifiedEpisodes: candidate.parsed.unqualifiedEpisodes,
    wholeSeries: candidate.parsed.wholeSeries,
  };
}

function safeRelease(candidate: GroupCandidate, index: number, group: WorkGroup): Record<string, unknown> {
  const release = candidate.release;
  return {
    index,
    physicalSlot: candidate.physicalSlot,
    observedReleaseTitle: publicTitle(release.title, [release.guid, release.infoHash]),
    tvdbId: release.tvdbId,
    tmdbId: release.tmdbId,
    size: release.size,
    seeders: release.seeders,
    leechers: release.leechers,
    grabs: release.grabs,
    age: release.age,
    indexer: publicTitle(release.indexer),
    indexerFlags: release.indexerFlags.map((flag) => publicTitle(flag)),
    protocol: release.protocol,
    magnetUrlPresent: release.magnetUrl !== null && release.magnetUrl !== '',
    downloadUrlPresent: release.downloadUrl !== null && release.downloadUrl !== '',
    parsedAdvertisedScope: advertisedScope(candidate),
    requestedFootprint: coverageForPrompt(candidate.requestedFootprint, group),
    capture: coverageForPrompt(candidate.capture, group),
    extraSeasons: candidate.extraSeasons,
  };
}

/** Sanitized JSON text; private identity, URLs, hashes, GUIDs, and raw work DTOs are omitted. */
export function serializeGroupPickerInput(input: {
  group: WorkGroup;
  context: PlanningContext;
  candidates: GroupCandidate[];
  mediaPreferences?: string;
}): string {
  return JSON.stringify({
    targets: input.group.targets.map(publicTarget),
    dueTargetIndices: [...input.group.dueTargetIndices],
    context: publicContext(input.context),
    candidates: input.candidates.map((candidate, index) => safeRelease(candidate, index, input.group)),
    mediaPreferences: publicTitle(input.mediaPreferences ?? '') ?? '',
  });
}
