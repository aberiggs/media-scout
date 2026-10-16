import type { AcquisitionStage, WorkGroup } from './group-types';
import type { EpisodeProgress } from './work-queue-types';
import type { GroupPlannedQuery } from '../types/group-llm';
import type { WorkUnit } from './watcher';

/** Stage targets never widen the original claimed target IDs or include cooldown-only siblings. */
export function acquisitionTargets(group: WorkGroup, ids?: ReadonlySet<number>, excludedKeys: ReadonlySet<string> = new Set()): WorkGroup {
  const targets = group.dueTargetIndices.map((index) => group.targets[index]!).filter((unit) => !excludedKeys.has(unit.key)).flatMap((unit) => {
    if (unit.kind === 'movie' || ids === undefined) return [unit];
    const missing = unit.season!.missing.filter((episode) => ids.has(episode.episodeId));
    return missing.length ? [{ ...unit, season: { ...unit.season!, missing } }] : [];
  });
  return { ...group, targets, dueTargetIndices: targets.map((_, index) => index) };
}

export function episodeStage(group: WorkGroup, progress: EpisodeProgress[], capacity: number, excludedIds: ReadonlySet<number>, excludedKeys: ReadonlySet<string>): WorkGroup {
  const rows = new Map(progress.filter((episode) => group.targets.some((unit) => unit.serviceId === episode.serviceId && unit.externalId === episode.externalId && unit.key === episode.workKey))
    .map((episode) => [episode.episodeId, episode]));
  const episodes = acquisitionTargets(group, undefined, excludedKeys).targets.flatMap((unit) => unit.season?.missing ?? [])
    .filter((episode) => !excludedIds.has(episode.episodeId))
    .sort((left, right) => {
      const a = rows.get(left.episodeId)?.lastSearchAt ?? '';
      const b = rows.get(right.episodeId)?.lastSearchAt ?? '';
      return a.localeCompare(b) || left.episodeId - right.episodeId;
    }).slice(0, capacity);
  return acquisitionTargets(group, new Set(episodes.map((episode) => episode.episodeId)), excludedKeys);
}

/** Call only after validateGroupPlan: indices are local to this exact stage, never durable IDs. */
export function queryTargets(group: WorkGroup, query: GroupPlannedQuery, stage?: AcquisitionStage): WorkUnit[] {
  return query.targetIndices.map((index) => {
    const unit = group.targets[index]!;
    if (stage !== 'episodes') return unit;
    const indices = new Set(query.episodeTargets!.find((target) => target.targetIndex === index)!.episodeIndices);
    return { ...unit, season: { ...unit.season!, missing: unit.season!.missing.filter((_, episodeIndex) => indices.has(episodeIndex)) } };
  });
}
