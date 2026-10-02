import type { WorkUnit } from './watcher';

export type WorkStatus = 'ready' | 'waiting-release' | 'searching' | 'cooldown' | 'backoff' | 'manual' | 'fulfilled' | 'inactive';

export interface WorkItem {
  workKey: string;
  contentIdentity: string;
  missingFingerprint: string;
  unit: WorkUnit;
  status: WorkStatus;
  lastSearchAt: string | null;
  nextSearchAt: string | null;
  failCount: number;
  lastOutcome: string | null;
  lastObservedAt: string;
  lastQueueObservedAt: string | null;
  queueObservationKnown: boolean;
  blockedReason: string | null;
}

export interface IntentCoverage {
  workKey: string;
  episodeIds: number[] | null;
  basis: 'explicit-episodes' | 'inferred-season-pack' | null;
}

export type IntentStatus = 'submitting' | 'awaiting-queue' | 'active' | 'fulfilled' | 'import-blocked' | 'uncertain' | 'failed';

/** One owner token atomically owns every listed work or coordination lease key. */
export interface ClaimSet {
  ownerToken: string;
  keys: string[];
}

export interface GrabIntent {
  id: string;
  ownerToken: string;
  arr: 'sonarr' | 'radarr';
  indexerId: number;
  guid: string;
  infoHash: string | null;
  releaseTitle: string;
  coverage: IntentCoverage[];
  status: IntentStatus;
  startedAt: string;
  confirmedAt: string | null;
  queueDeadlineAt: string;
  lastSeenAt: string | null;
  queueRefs: string[];
  /** A released hold remains historical; it is excluded only from live reservation projections. */
  releasedAt?: string | null;
  releaseNote?: string | null;
}

export type QueueRead<T> =
  | { kind: 'known'; records: T[]; observedAt: string }
  | { kind: 'unknown'; observedAt: string; errorCode: string };

export interface WorkQueueStatusRow {
  workKey: string;
  status: WorkStatus;
  nextSearchAt: string | null;
  lastObservedAt: string;
  missingCount: number;
  coveredEpisodeIds: number[];
  safeHoldReason: string | null;
}

export interface WorkQueueStatus {
  items: WorkQueueStatusRow[];
  counts: Record<WorkStatus, number>;
  openIntentCount: number;
}
