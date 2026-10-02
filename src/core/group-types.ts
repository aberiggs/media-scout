import type { Release } from '../types/prowlarr';
import type { WorkStatus, IntentCoverage } from './work-queue-types';
import type { ReconciledWork } from './work-queue';
import type { WorkUnit } from './watcher';

/** Raw parser evidence retained so group policy can distinguish absent and malformed claims. */
export type ParsedReleaseCoverage =
  | { kind: 'invalid' }
  | { kind: 'none' }
  | {
      kind: 'claims';
      seasonClaims: Array<{ seasonNumber: number; episodes: number[] | null }>;
      absoluteEpisodes: number[] | null;
      unqualifiedEpisodes: number[] | null;
      wholeSeries: boolean;
    };

export interface WorkGroup {
  key: string;
  members: ReconciledWork[];
  targets: WorkUnit[];
  dueTargetIndices: number[];
}

export interface ExpectedTargetDescription {
  description: string;
  seasonNumber: number | null;
  episodeNumber: number | null;
  absoluteEpisodeNumber: number | null;
}

export interface OpenWorkSummary {
  workKey: string;
  title: string;
  kind: WorkUnit['kind'];
  seriesType: WorkUnit['seriesType'] | null;
  seasonNumber: number | null;
  missingCount: number;
  eligibleCount: number;
  heldCount: number;
  expectedTargets: ExpectedTargetDescription[];
  status: WorkStatus;
  nextSearchAt: string | null;
}

export interface ActiveWorkReference {
  workKey: string;
  scope: 'movie' | 'series' | 'season' | 'episodes' | 'unknown';
  seasonNumber: number | null;
  episodeIds: number[] | null;
  basis: IntentCoverage['basis'];
}

export interface ActiveDownloadSummary {
  /** Opaque, cycle-local label. Never a hash, GUID, downloadId, or owner token. */
  surrogate: string;
  title: string | null;
  status: string | null;
  trackedStatus: string | null;
  trackedState: string | null;
  workReferences: ActiveWorkReference[];
  uncertainty: 'none' | 'unknown-association' | 'unknown-status' | 'incomplete-observation';
}

export type SourceReadKnowledge =
  | { kind: 'known'; observedAt: string }
  | { kind: 'unknown'; observedAt: string; errorCode: string };

export interface SourceKnowledge {
  arr: 'sonarr' | 'radarr';
  library: SourceReadKnowledge;
  queue: SourceReadKnowledge;
}

export interface PlanningContext {
  openWork: OpenWorkSummary[];
  activeDownloads: ActiveDownloadSummary[];
  sourceKnowledge: SourceKnowledge[];
}

export interface TargetCoverage {
  workKey: string;
  /** null for a movie; otherwise exact episode IDs from that supplied work unit. */
  episodeIds: number[] | null;
  basis: 'explicit-episodes' | 'inferred-season-pack' | null;
}

export interface GroupCandidate {
  release: Release;
  /** Identifies one physical search result; equal slots are never unioned. */
  physicalSlot: number;
  parsed: ParsedReleaseCoverage;
  requestedFootprint: TargetCoverage[];
  capture: TargetCoverage[];
  extraSeasons: number[] | null;
}

export type GroupCoverageResult =
  | {
      kind: 'covered';
      /** Exact coverage intersecting the original requested group inventory. */
      requestedFootprint: TargetCoverage[];
      /** Exact subset this physical grab is permitted to capture. */
      capture: TargetCoverage[];
      /** Observed non-requested seasons; ranking evidence only, never fulfillment. */
      extraSeasons: number[];
    }
  | { kind: 'invalid' | 'no-map'; reason: 'invalid' | 'no-map' };

export interface AssociationQueueInput {
  queueIndex: number;
  title: string | null;
  status: string | null;
  trackedStatus: string | null;
  trackedState: string | null;
}

export interface AssociationMediaInput {
  mediaIndex: number;
  kind: WorkUnit['kind'];
  title: string;
  year: number | null;
  seriesType: WorkUnit['seriesType'] | null;
  seasonNumbers: number[];
}

export interface AssociationTargetInput {
  targetIndex: number;
  kind: WorkUnit['kind'];
  title: string;
  seriesType: WorkUnit['seriesType'] | null;
  seasonNumber: number | null;
  expectedTargets: ExpectedTargetDescription[];
}

/** Private lookup tables parallel to the public zero-based indices; never serialize to an LLM. */
export interface AssociationLookup {
  queueRefsByIndex: string[];
  mediaReferencesByIndex: AssociationMediaReference[];
  workReferencesByIndex: AssociationWorkReference[];
  workUnitsByIndex: WorkUnit[];
  /** Private physical-job evidence: contradictory parsed scopes make every mapped target uncertain. */
  scopeConflictsByQueueIndex?: boolean[];
}

/** Sanitized, bounded evidence for one Arr source; indices are request-local only. */
export interface AssociationRequest {
  arr: 'sonarr' | 'radarr';
  /** Private stable source/job key, not sent to the model or exposed in status. */
  sourceJobKey: string;
  materialSignature: string;
  contextSignature: string;
  promptVersion: string;
  queue: AssociationQueueInput[];
  media: AssociationMediaInput[];
  targets: AssociationTargetInput[];
  lookup: AssociationLookup;
}

export interface AssociationMediaReference {
  arr: 'sonarr' | 'radarr';
  serviceId: number;
  externalId: number;
}

export interface AssociationWorkReference {
  workKey: string;
  arr: 'sonarr' | 'radarr';
  serviceId: number;
  externalId: number;
  seasonNumber: number | null;
}

/** Validated durable association result; no transient model indices are persisted. */
export interface AssociationDecision {
  arr: 'sonarr' | 'radarr';
  /** Private validated queue reference, never a raw downloadId or provider identifier. */
  queueRef: string;
  outcome: 'matched' | 'unrelated' | 'uncertain';
  mediaReferences: AssociationMediaReference[];
  workReferences: AssociationWorkReference[];
  potentialScope: 'movie' | 'series' | 'season' | 'episodes' | 'unknown';
  seasonNumber: number | null;
  episodeIds: number[] | null;
  basis: TargetCoverage['basis'];
  uncertainty: string | null;
}

export interface AssociationCacheEntry {
  arr: 'sonarr' | 'radarr';
  /** The tuple is private; signatures cover material/context and prompt version, not progress or time. */
  sourceJobKey: string;
  materialSignature: string;
  contextSignature: string;
  promptVersion: string;
  cachedAt: string;
  decisions: AssociationDecision[];
}
