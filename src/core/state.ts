import Database from 'better-sqlite3';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { GrabIntent, IntentCoverage, IntentStatus, WorkItem, WorkQueueStatus, WorkStatus, ClaimSet } from './work-queue-types';
import type { AssociationCacheEntry, AssociationDecision, AssociationRequest, ParsedReleaseCoverage } from './group-types';
import { defaultSettings, settingsSchema, type Settings } from '../settings';


export interface DecisionRecord {
  workKey: string;
  releaseTitle?: string;
  infoHash?: string;
  verdict: string; // 'grab' | 'manual' | 'skip' — runner decides vocabulary; state stores it
  grabbed: boolean;
}

export interface ManualReviewRow {
  id: number;
  workKey: string;
  reason: string;
  details: string | null;
  createdAt: string; // ISO
  resolvedAt: string | null;
  subjectKind?: 'intent' | 'queue' | null;
  subjectKey?: string | null;
  targetEvidence?: UnparseableTargetEvidence | null;
  targetEvidenceKind?: 'captured' | 'legacy' | 'legacy-ineligible';
  targetEvidenceInvalid?: boolean;
}

export interface UnparseableTargetEvidence {
  arr: 'sonarr' | 'radarr';
  serviceId: number;
  externalId: number;
  episodeIds: number[] | null;
}

export interface OperatorClaim {
  workKey: string;
  contentIdentity: string;
  fingerprint: string;
}

/** Private service evidence. It is stored only in operator_observations and never projected publicly. */
export interface OperatorObservation {
  sourceConfigFingerprint: string;
  readStartedAt: string;
  readCompletedAt: string;
  libraryKnown: { sonarr: boolean; radarr: boolean };
  queueKnown: { sonarr: boolean; radarr: boolean };
  libraryEvidence: Array<{ workKey: string; contentIdentity: string; missingFingerprint: string; contentEvidenceFingerprint: string; targetIds: number[]; missingTargetIds: number[]; hasAllFiles: boolean }>;
  queueEvidence: Array<{ arr: 'sonarr' | 'radarr'; ref: string | null; stableRef: boolean; title: string | null; status: string | null; trackedStatus: string | null; trackedState: string | null; serviceId: number | null; episodeId: number | null; seasonNumber: number | null }>;
  associationEvidence?: {
    arr: 'sonarr' | 'radarr'; sourceJobKey: string; materialSignature: string; contextSignature: string; promptVersion: string;
    queueRefs: string[];
    mediaReferences: Array<{ arr: 'sonarr' | 'radarr'; serviceId: number; externalId: number }>;
    workReferences: Array<{ workKey: string; arr: 'sonarr' | 'radarr'; serviceId: number; externalId: number; seasonNumber: number | null }>;
  };
}

export interface OperatorObservationReceipt {
  token: string;
  version: number;
  expiresAt: string;
  challenge: string;
}

export interface PersistedQueueObservation {
  workKey: string;
  coverage: IntentCoverage[];
  failedQueueRefs: string[];
  observedAt: string | null;
  known: boolean;
}

export type WorkAction = 'retry' | 'reset';
export interface ActivityRecord {
  id: number;
  source: 'cycle' | 'manual';
  startedAt: string;
  finishedAt: string | null;
  query: string;
  media: Array<{ workKey: string; title: string }>;
  resultCount: number | null;
  outcome: 'running' | 'success' | 'error';
  errorCode?: string;
}

const DDL = `
CREATE TABLE IF NOT EXISTS seen_hashes (
  info_hash TEXT PRIMARY KEY,
  work_key  TEXT NOT NULL,
  seen_at   TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS seen_releases (
  indexer_id INTEGER NOT NULL,
  guid       TEXT NOT NULL,
  work_key   TEXT NOT NULL,
  seen_at    TEXT NOT NULL,
  PRIMARY KEY (indexer_id, guid)
);
CREATE TABLE IF NOT EXISTS decisions (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  work_key      TEXT NOT NULL,
  release_title TEXT,
  info_hash     TEXT,
  verdict       TEXT NOT NULL,
  grabbed       INTEGER NOT NULL DEFAULT 0,
  decided_at    TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS manual_review (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  work_key    TEXT NOT NULL,
  reason      TEXT NOT NULL,
  details     TEXT,
  created_at  TEXT NOT NULL,
  resolved_at TEXT,
  subject_kind TEXT,
  subject_key TEXT,
  target_evidence_json TEXT CHECK (target_evidence_json IS NULL OR json_valid(target_evidence_json))
);
CREATE TABLE IF NOT EXISTS unit_claims (
  work_key   TEXT PRIMARY KEY,
  claimed_at TEXT NOT NULL,
  owner      TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS work_items (
  work_key TEXT PRIMARY KEY,
  content_identity TEXT NOT NULL,
  missing_fingerprint TEXT NOT NULL,
  unit_json TEXT NOT NULL CHECK (json_valid(unit_json)),
  status TEXT NOT NULL CHECK (status IN ('ready','waiting-release','searching','cooldown','backoff','manual','fulfilled','inactive')),
  last_search_at TEXT,
  next_search_at TEXT,
  fail_count REAL NOT NULL CHECK (fail_count >= 0),
  last_outcome TEXT,
  last_observed_at TEXT NOT NULL,
  blocked_reason TEXT,
  reset_pending_at TEXT,
  queue_coverage_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(queue_coverage_json)),
  queue_observed_at TEXT,
  queue_known INTEGER NOT NULL DEFAULT 0 CHECK (queue_known IN (0,1)),
  queue_failure_refs_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(queue_failure_refs_json))
);
CREATE TABLE IF NOT EXISTS grab_intents (
  id TEXT PRIMARY KEY,
  owner_token TEXT NOT NULL,
  arr TEXT NOT NULL CHECK (arr IN ('sonarr','radarr')),
  indexer_id INTEGER NOT NULL CHECK (indexer_id >= 0),
  guid TEXT NOT NULL,
  info_hash TEXT,
  release_title TEXT NOT NULL,
  coverage_json TEXT NOT NULL CHECK (json_valid(coverage_json)),
  status TEXT NOT NULL CHECK (status IN ('submitting','awaiting-queue','active','fulfilled','import-blocked','uncertain','failed')),
  started_at TEXT NOT NULL,
  confirmed_at TEXT,
  queue_deadline_at TEXT NOT NULL,
  last_seen_at TEXT,
  queue_refs_json TEXT NOT NULL CHECK (json_valid(queue_refs_json)),
  captured_fingerprint TEXT NOT NULL,
  captured_fingerprints_json TEXT CHECK (captured_fingerprints_json IS NULL OR json_valid(captured_fingerprints_json)),
  declared_scope_json TEXT CHECK (declared_scope_json IS NULL OR json_valid(declared_scope_json)),
  released_at TEXT,
  release_note TEXT
);
CREATE TABLE IF NOT EXISTS queue_associations (
  arr TEXT NOT NULL CHECK (arr IN ('sonarr','radarr')),
  source_job_key TEXT NOT NULL,
  material_signature TEXT NOT NULL,
  context_signature TEXT NOT NULL,
  prompt_version TEXT NOT NULL,
  cache_json TEXT CHECK (cache_json IS NULL OR json_valid(cache_json)),
  next_attempt_at TEXT,
  failure_count INTEGER NOT NULL DEFAULT 0 CHECK (failure_count >= 0),
  retry_material_signature TEXT,
  retry_context_signature TEXT,
  retry_prompt_version TEXT,
  human_override_json TEXT CHECK (human_override_json IS NULL OR json_valid(human_override_json)),
  PRIMARY KEY (arr, source_job_key)
);
CREATE TABLE IF NOT EXISTS operator_observations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  token_digest TEXT NOT NULL UNIQUE,
  operation TEXT NOT NULL CHECK (operation IN ('associate_queue','release_intent_hold')),
  review_id INTEGER NOT NULL,
  subject_kind TEXT NOT NULL,
  subject_key TEXT NOT NULL,
  source_config_fingerprint TEXT NOT NULL,
  evidence_json TEXT NOT NULL CHECK (json_valid(evidence_json)),
  claims_json TEXT NOT NULL CHECK (json_valid(claims_json)),
  durable_digest TEXT NOT NULL,
  issued_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  challenge TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS operator_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  review_id INTEGER NOT NULL,
  operation TEXT NOT NULL,
  subject_key TEXT NOT NULL,
  note TEXT NOT NULL,
  occurred_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS work_action_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  work_key TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('retry','reset')),
  occurred_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS search_activity (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source TEXT NOT NULL CHECK (source IN ('cycle','manual')),
  started_at TEXT NOT NULL,
  finished_at TEXT,
  query TEXT NOT NULL,
  media_json TEXT NOT NULL CHECK (json_valid(media_json)),
  result_count INTEGER,
  outcome TEXT NOT NULL CHECK (outcome IN ('running','success','error')),
  error_code TEXT
);
CREATE TABLE IF NOT EXISTS app_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  version INTEGER NOT NULL,
  document_json TEXT NOT NULL CHECK (json_valid(document_json)),
  updated_at TEXT NOT NULL
);
`;

const WORK_STATUSES: readonly WorkStatus[] = ['ready', 'waiting-release', 'searching', 'cooldown', 'backoff', 'manual', 'fulfilled', 'inactive'];
const INTENT_STATUSES: readonly IntentStatus[] = ['submitting', 'awaiting-queue', 'active', 'fulfilled', 'import-blocked', 'uncertain', 'failed'];
const OPEN_INTENT_STATUSES: readonly IntentStatus[] = ['submitting', 'awaiting-queue', 'active', 'import-blocked', 'uncertain'];
const ORDINARY_REVIEW_REASONS = ['picker-manual', 'no-suitable-release', 'repeated-operation-failure', 'missing-download-client', 'reverify-failed', 'unparseable-title'] as const;
export const WORK_OBSERVATION_STALE_AFTER_MS = 24 * 60 * 60_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validateReviewEvidence(value: unknown): UnparseableTargetEvidence {
  if (!isRecord(value) || (value.arr !== 'sonarr' && value.arr !== 'radarr') || !Number.isSafeInteger(value.serviceId) || Number(value.serviceId) < 0 || !Number.isSafeInteger(value.externalId) || Number(value.externalId) < 0) throw new Error('Invalid review target evidence');
  if (value.episodeIds !== null && (!validPositiveIds(value.episodeIds) || value.arr !== 'sonarr')) throw new Error('Invalid review target episodes');
  if (value.episodeIds === null && value.arr !== 'radarr') throw new Error('TV review target requires episode ids');
  return { arr: value.arr, serviceId: Number(value.serviceId), externalId: Number(value.externalId), episodeIds: value.episodeIds === null ? null : [...value.episodeIds as number[]].sort((a, b) => a - b) };
}

function decodeReviewEvidence(json: string): UnparseableTargetEvidence {
  let value: unknown;
  try { value = JSON.parse(json) as unknown; } catch { throw new Error('Corrupt review target evidence'); }
  return validateReviewEvidence(value);
}

export function reviewEvidenceMatchesWorkKey(workKey: string, evidence: UnparseableTargetEvidence): boolean {
  const tv = /^(sonarr):(0|[1-9]\d*):s(0|[1-9]\d*)$/.exec(workKey);
  if (tv) return evidence.arr === 'sonarr' && evidence.episodeIds !== null && Number.isSafeInteger(Number(tv[2])) && Number(tv[2]) === evidence.serviceId && Number.isSafeInteger(Number(tv[3]));
  const movie = /^(radarr):(0|[1-9]\d*)$/.exec(workKey);
  return !!movie && evidence.arr === 'radarr' && Number.isSafeInteger(Number(movie[2])) && Number(movie[2]) === evidence.serviceId && evidence.episodeIds === null;
}

function decodeManualReviewRow(row: Record<string, unknown>): ManualReviewRow {
  let targetEvidence: UnparseableTargetEvidence | undefined;
  let targetEvidenceInvalid = false;
  let targetEvidenceKind: ManualReviewRow['targetEvidenceKind'];
  if (row.target_evidence_json !== null && row.target_evidence_json !== undefined) {
    try {
      const raw: unknown = JSON.parse(String(row.target_evidence_json));
      if (isRecord(raw) && raw.kind === 'legacy') { targetEvidence = validateReviewEvidence(raw); targetEvidenceKind = 'legacy'; }
      else if (isRecord(raw) && raw.kind === 'legacy-ineligible' && Object.keys(raw).length === 1) targetEvidenceKind = 'legacy-ineligible';
      else if (isRecord(raw) && Object.prototype.hasOwnProperty.call(raw, 'kind')) throw new Error('Unknown review evidence tag');
      else { targetEvidence = decodeReviewEvidence(String(row.target_evidence_json)); targetEvidenceKind = 'captured'; }
    } catch { targetEvidenceInvalid = true; }
  }
  return {
    id: Number(row.id), workKey: String(row.work_key), reason: String(row.reason), details: (row.details as string | null) ?? null,
    createdAt: String(row.created_at), resolvedAt: (row.resolved_at as string | null) ?? null,
    ...((row.subject_kind ?? null) === null ? {} : { subjectKind: String(row.subject_kind) as 'intent' | 'queue' }),
    ...((row.subject_key ?? null) === null ? {} : { subjectKey: String(row.subject_key) }),
    ...(targetEvidence ? { targetEvidence } : {}), ...(targetEvidenceKind ? { targetEvidenceKind } : {}), ...(targetEvidenceInvalid ? { targetEvidenceInvalid: true } : {}),
  };
}

function validIso(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,9})?Z$/.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0, 19) !== value.slice(0, 19)) {
    throw new Error(`Invalid ${label}: expected ISO timestamp`);
  }
}

function nonnegativeFinite(value: unknown, label: string): asserts value is number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw new Error(`Invalid ${label}: expected finite nonnegative number`);
}

function hashIdentity(infoHash: string): string {
  return infoHash.toLowerCase();
}

function validateCoverage(value: unknown, allowEmpty = false): asserts value is IntentCoverage[] {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0)) throw new Error('Invalid intent coverage: expected nonempty array');
  const keys = new Set<string>();
  for (const item of value) {
    if (!isRecord(item) || typeof item.workKey !== 'string' || item.workKey.length === 0 || keys.has(item.workKey)) throw new Error('Invalid intent coverage key');
    keys.add(item.workKey);
    if (item.episodeIds === null) {
      if (item.basis !== null) throw new Error('Movie coverage must have null basis');
    } else {
      if (!Array.isArray(item.episodeIds) || item.episodeIds.length === 0 || !['explicit-episodes', 'inferred-season-pack'].includes(String(item.basis))) throw new Error('Invalid episode coverage');
      const ids = new Set<number>();
      for (const id of item.episodeIds) {
        if (!Number.isSafeInteger(id) || id <= 0 || ids.has(id)) throw new Error('Invalid or duplicate episode coverage ID');
        ids.add(id);
      }
    }
  }
}

function validateParsedCoverage(value: unknown): asserts value is ParsedReleaseCoverage {
  if (!isRecord(value) || !['invalid', 'none', 'claims'].includes(String(value.kind))) throw new Error('Invalid declared release scope');
  if (value.kind !== 'claims' && Object.keys(value).some((key) => key !== 'kind')) throw new Error('Invalid declared release scope');
  if (value.kind !== 'claims') return;
  if (Object.keys(value).some((key) => !['kind', 'seasonClaims', 'absoluteEpisodes', 'unqualifiedEpisodes', 'wholeSeries'].includes(key))) throw new Error('Invalid declared release scope');
  if (!Array.isArray(value.seasonClaims) || (value.absoluteEpisodes !== null && !validPositiveIds(value.absoluteEpisodes)) || (value.unqualifiedEpisodes !== null && !validPositiveIds(value.unqualifiedEpisodes)) || typeof value.wholeSeries !== 'boolean') throw new Error('Invalid declared release scope');
  const seasons = new Set<number>();
  for (const claim of value.seasonClaims) {
    if (!isRecord(claim) || !Number.isSafeInteger(claim.seasonNumber) || (claim.seasonNumber as number) < 0 || seasons.has(claim.seasonNumber as number) || (claim.episodes !== null && !validPositiveIds(claim.episodes))) throw new Error('Invalid declared season scope');
    seasons.add(claim.seasonNumber as number);
  }
}

function validPositiveIds(value: unknown): value is number[] {
  if (!Array.isArray(value) || value.length === 0) return false;
  const seen = new Set<number>();
  return value.every((id) => Number.isSafeInteger(id) && id > 0 && !seen.has(id) && !!seen.add(id));
}

function validateAssociationEntry(value: unknown): asserts value is AssociationCacheEntry {
  if (!isRecord(value) || (value.arr !== 'sonarr' && value.arr !== 'radarr') || typeof value.sourceJobKey !== 'string' || !value.sourceJobKey || typeof value.materialSignature !== 'string' || !value.materialSignature || typeof value.contextSignature !== 'string' || !value.contextSignature || typeof value.promptVersion !== 'string' || !value.promptVersion || !Array.isArray(value.decisions)) throw new Error('Invalid association cache entry');
  if (Object.keys(value).some((key) => !['arr', 'sourceJobKey', 'materialSignature', 'contextSignature', 'promptVersion', 'cachedAt', 'decisions'].includes(key))) throw new Error('Invalid association cache entry');
  validIso(value.cachedAt, 'association cachedAt');
  for (const decision of value.decisions) validateAssociationDecision(decision, value.arr);
}

function validateAssociationDecision(value: unknown, arr: 'sonarr' | 'radarr'): asserts value is AssociationDecision {
  if (!isRecord(value) || value.arr !== arr || typeof value.queueRef !== 'string' || !value.queueRef || !['matched', 'unrelated', 'uncertain'].includes(String(value.outcome)) || !Array.isArray(value.mediaReferences) || !Array.isArray(value.workReferences) || !['movie', 'series', 'season', 'episodes', 'unknown'].includes(String(value.potentialScope)) || (value.seasonNumber !== null && (!Number.isSafeInteger(value.seasonNumber) || (value.seasonNumber as number) < 0)) || (value.episodeIds !== null && !validPositiveIds(value.episodeIds)) || (value.basis !== null && value.basis !== 'explicit-episodes' && value.basis !== 'inferred-season-pack') || (value.uncertainty !== null && typeof value.uncertainty !== 'string')) throw new Error('Invalid durable association decision');
  if (Object.keys(value).some((key) => !['arr', 'queueRef', 'outcome', 'mediaReferences', 'workReferences', 'potentialScope', 'seasonNumber', 'episodeIds', 'basis', 'uncertainty'].includes(key))) throw new Error('Invalid durable association decision');
  for (const ref of value.mediaReferences) if (!isRecord(ref) || Object.keys(ref).some((key) => !['arr', 'serviceId', 'externalId'].includes(key)) || ref.arr !== arr || !Number.isSafeInteger(ref.serviceId) || (ref.serviceId as number) < 0 || !Number.isSafeInteger(ref.externalId) || (ref.externalId as number) < 0) throw new Error('Invalid durable association media reference');
  for (const ref of value.workReferences) if (!isRecord(ref) || Object.keys(ref).some((key) => !['workKey', 'arr', 'serviceId', 'externalId', 'seasonNumber'].includes(key)) || typeof ref.workKey !== 'string' || !ref.workKey || ref.arr !== arr || !Number.isSafeInteger(ref.serviceId) || (ref.serviceId as number) < 0 || !Number.isSafeInteger(ref.externalId) || (ref.externalId as number) < 0 || (ref.seasonNumber !== null && (!Number.isSafeInteger(ref.seasonNumber) || (ref.seasonNumber as number) < 0))) throw new Error('Invalid durable association work reference');
  if (value.episodeIds !== null && (value.episodeIds.length === 0 || value.basis === null)) throw new Error('Association episode scope requires a basis');
}

function validateWorkItem(value: unknown): asserts value is WorkItem {
  if (!isRecord(value)) throw new Error('Invalid work item');
  if (typeof value.workKey !== 'string' || value.workKey.length === 0 || typeof value.contentIdentity !== 'string' || value.contentIdentity.length === 0 || typeof value.missingFingerprint !== 'string' || value.missingFingerprint.length === 0) throw new Error('Invalid work identity');
  if (!WORK_STATUSES.includes(value.status as WorkStatus)) throw new Error('Invalid work status');
  validIso(value.lastObservedAt, 'lastObservedAt');
  if (value.lastQueueObservedAt !== null) validIso(value.lastQueueObservedAt, 'lastQueueObservedAt');
  if (typeof value.queueObservationKnown !== 'boolean') throw new Error('Invalid queue observation freshness flag');
  for (const field of ['lastSearchAt', 'nextSearchAt'] as const) if (value[field] !== null) validIso(value[field], field);
  nonnegativeFinite(value.failCount, 'failCount');
  if (value.lastOutcome !== null && typeof value.lastOutcome !== 'string') throw new Error('Invalid lastOutcome');
  if (value.blockedReason !== null && typeof value.blockedReason !== 'string') throw new Error('Invalid blockedReason');
  if (value.resetPendingAt !== undefined && value.resetPendingAt !== null) validIso(value.resetPendingAt, 'resetPendingAt');
  const unit = value.unit;
  if (!isRecord(unit) || unit.key !== value.workKey || (unit.kind !== 'tv' && unit.kind !== 'movie') || (unit.arr !== 'sonarr' && unit.arr !== 'radarr') || typeof unit.serviceId !== 'number' || !Number.isFinite(unit.serviceId) || unit.serviceId < 0 || typeof unit.externalId !== 'number' || !Number.isFinite(unit.externalId) || unit.externalId < 0 || typeof unit.title !== 'string' || !Array.isArray(unit.altTitles) || !unit.altTitles.every((title) => typeof title === 'string')) throw new Error('Invalid work unit');
  if (unit.kind === 'movie') {
    if (unit.arr !== 'radarr' || unit.season !== undefined) throw new Error('Invalid movie work unit');
  } else {
    if (unit.arr !== 'sonarr' || !isRecord(unit.season) || typeof unit.season.seasonNumber !== 'number' || !Number.isFinite(unit.season.seasonNumber) || unit.season.seasonNumber < 0 || !Array.isArray(unit.season.missing)) throw new Error('Invalid TV work unit');
    if (unit.season.missing.length === 0 && value.status !== 'fulfilled' && value.status !== 'inactive') throw new Error('Only terminal work may have an empty missing inventory');
    const ids = new Set<number>();
    for (const ep of unit.season.missing) {
      if (!isRecord(ep) || !Number.isSafeInteger(ep.episodeId) || (ep.episodeId as number) <= 0 || ids.has(ep.episodeId as number) || typeof ep.episodeNumber !== 'number' || !Number.isFinite(ep.episodeNumber) || ep.episodeNumber < 0 || (ep.absoluteEpisodeNumber !== null && (typeof ep.absoluteEpisodeNumber !== 'number' || !Number.isFinite(ep.absoluteEpisodeNumber))) || typeof ep.title !== 'string') throw new Error('Invalid missing episode inventory');
      ids.add(ep.episodeId as number);
    }
  }
}

export class State {
  constructor(private readonly db: Database.Database) {
    db.exec(DDL);
    this.ensureQueueObservationColumns();
    this.ensureOperationsColumns();
    this.ensureGroupAssociationColumns();
    this.ensureOperatorColumns();
    this.ensureReviewEvidenceColumn();
  }

  static open(path: string): State {
    // better-sqlite3 throws if the parent directory is missing (e.g. gitignored data/ on
    // a clean checkout); create it. ':memory:' and bare filenames never touch fs.
    if (path !== ':memory:') {
      const parent = dirname(path);
      if (parent !== '' && parent !== '.') mkdirSync(parent, { recursive: true });
    }
    return new State(new Database(path));
  }

  close(): void { this.db.close(); }

  getSettings(): Settings {
    const row = this.db.prepare('SELECT document_json FROM app_settings WHERE id=1').get() as { document_json: string } | undefined;
    if (!row) return structuredClone(defaultSettings);
    let raw: unknown;
    try { raw = JSON.parse(row.document_json) as unknown; } catch { throw new Error('Stored settings are corrupt'); }
    const parsed = settingsSchema.safeParse(raw);
    if (!parsed.success) throw new Error('Stored settings are invalid');
    return parsed.data;
  }

  saveSettings(settings: Settings): void {
    const validated = settingsSchema.parse(settings);
    this.db.prepare(`INSERT INTO app_settings(id,version,document_json,updated_at) VALUES(1,?,?,?)
      ON CONFLICT(id) DO UPDATE SET version=excluded.version,document_json=excluded.document_json,updated_at=excluded.updated_at`)
      .run(validated.version, JSON.stringify(validated), new Date().toISOString());
  }

  hasHash(infoHash: string): boolean {
    return this.db.prepare('SELECT 1 FROM seen_hashes WHERE info_hash COLLATE NOCASE = ?').get(hashIdentity(infoHash)) !== undefined;
  }

  hasRelease(indexerId: number, guid: string): boolean {
    return this.db
      .prepare('SELECT 1 FROM seen_releases WHERE indexer_id = ? AND guid = ?')
      .get(indexerId, guid) !== undefined;
  }

  /** Idempotent durable source-qualified fallback when a release has no infoHash. */
  recordRelease(indexerId: number, guid: string, workKey: string, at: Date = new Date()): void {
    this.db
      .prepare('INSERT OR IGNORE INTO seen_releases (indexer_id, guid, work_key, seen_at) VALUES (?, ?, ?, ?)')
      .run(indexerId, guid, workKey, at.toISOString());
  }

  /** Idempotent: re-recording an existing hash is a no-op (I4). */
  recordHash(infoHash: string, workKey: string, at: Date = new Date()): void {
    this.db
      .prepare(`INSERT OR IGNORE INTO seen_hashes (info_hash, work_key, seen_at)
        SELECT ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM seen_hashes WHERE info_hash COLLATE NOCASE = ?)`)
      .run(hashIdentity(infoHash), workKey, at.toISOString(), hashIdentity(infoHash));
  }

  recordDecision(record: DecisionRecord, at: Date = new Date()): void {
    this.db
      .prepare(
        'INSERT INTO decisions (work_key, release_title, info_hash, verdict, grabbed, decided_at) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(record.workKey, record.releaseTitle ?? null, record.infoHash ?? null, record.verdict, record.grabbed ? 1 : 0, at.toISOString());
  }

  /** ISO timestamp of the most recent decision for the key, or null (I4 retry window input). */
  lastDecisionAt(workKey: string): string | null {
    const row = this.db
      .prepare('SELECT decided_at FROM decisions WHERE work_key = ? ORDER BY decided_at DESC, id DESC LIMIT 1')
      .get(workKey) as { decided_at: string } | undefined;
    return row?.decided_at ?? null;
  }

  flagManualReview(workKey: string, reason: string, details?: string, at: Date = new Date()): void {
    this.db
      .prepare('INSERT INTO manual_review (work_key, reason, details, created_at) VALUES (?, ?, ?, ?)')
      .run(workKey, reason, details ?? null, at.toISOString());
  }

  flagUnparseableReview(input: { workKey: string; details: string; evidence: UnparseableTargetEvidence; at: Date }): boolean {
    const evidence = validateReviewEvidence(input.evidence);
    if (!reviewEvidenceMatchesWorkKey(input.workKey, evidence)) throw new Error('Review evidence does not match work key');
    const json = JSON.stringify(evidence);
    const inserted = this.db.prepare(`INSERT INTO manual_review(work_key,reason,details,created_at,target_evidence_json)
      SELECT ?,'unparseable-title',?,?,? WHERE NOT EXISTS (
        SELECT 1 FROM manual_review WHERE work_key=? AND reason='unparseable-title' AND details=? AND resolved_at IS NULL AND target_evidence_json=?)`)
      .run(input.workKey, input.details, input.at.toISOString(), json, input.workKey, input.details, json);
    return inserted.changes === 1;
  }

  initializeLegacyUnparseableReviews(input: { workKey: string; token: string; now: string }): void {
    validIso(input.now, 'now');
    this.db.transaction(() => { this.assertClaim(input.workKey, input.token, input.now); this.initializeLegacyReviews(input.workKey); })();
  }

  private initializeLegacyReviews(workKey: string): void {
    const rows = this.db.prepare("SELECT id FROM manual_review WHERE work_key=? AND reason='unparseable-title' AND resolved_at IS NULL AND subject_kind IS NULL AND subject_key IS NULL AND target_evidence_json IS NULL").all(workKey) as Array<{id:number}>;
    if (!rows.length) return;
    const work = this.getWorkItem(workKey);
    const hasIdentityHold = this.hasOpenManualReview(workKey, 'content-identity-changed');
    let evidence: UnparseableTargetEvidence | null = null;
    if (work && !hasIdentityHold && work.blockedReason !== 'content-identity-changed') {
      try {
        const candidate: UnparseableTargetEvidence = {
          arr: work.unit.arr,
          serviceId: work.unit.serviceId,
          externalId: work.unit.externalId,
          episodeIds: work.unit.kind === 'tv' ? work.unit.season?.missing.map(({ episodeId }) => episodeId) ?? [] : null,
        };
        const tv = /^(sonarr):(0|[1-9]\d*):s(0|[1-9]\d*)$/.exec(workKey);
        const movie = /^radarr:(0|[1-9]\d*)$/.exec(workKey);
        const keyMatches = work.unit.kind === 'tv'
          ? !!tv && work.unit.season?.seasonNumber === Number(tv[3])
          : !!movie;
        const validated = validateReviewEvidence(candidate);
        if (work.workKey === workKey && keyMatches && reviewEvidenceMatchesWorkKey(workKey, validated)) evidence = validated;
      } catch { /* Invalid durable identity is conservatively ineligible. */ }
    }
    const tag = evidence ? JSON.stringify({ kind: 'legacy', ...evidence }) : JSON.stringify({ kind: 'legacy-ineligible' });
    const update = this.db.prepare('UPDATE manual_review SET target_evidence_json=? WHERE id=? AND target_evidence_json IS NULL');
    for (const row of rows) update.run(tag, row.id);
  }

  listOpenUnparseableReviews(): Array<{ id: number; workKey: string }> {
    return (this.db.prepare("SELECT id,work_key FROM manual_review WHERE reason='unparseable-title' AND resolved_at IS NULL AND subject_kind IS NULL AND subject_key IS NULL ORDER BY created_at DESC,id DESC").all() as Array<{ id: number; work_key: string }>)
      .map(({ id, work_key }) => ({ id, workKey: work_key }));
  }

  getManualReview(id: number): ManualReviewRow | null {
    const row = this.db.prepare('SELECT * FROM manual_review WHERE id=?').get(id) as Record<string, unknown> | undefined;
    return row ? decodeManualReviewRow(row) : null;
  }

  hasOpenManualReview(workKey: string, reason: string): boolean {
    return this.db.prepare('SELECT 1 FROM manual_review WHERE work_key=? AND reason=? AND resolved_at IS NULL LIMIT 1').get(workKey, reason) !== undefined;
  }

  /** Resolves only an open, unlinked unparseable-title row while its work lease is held. */
  resolveUnparseableReview(input: { id: number; workKey: string; token: string; now: string }): boolean {
    return this.db.transaction(() => {
      this.assertClaim(input.workKey, input.token, input.now);
      const result = this.db.prepare("UPDATE manual_review SET resolved_at=? WHERE id=? AND work_key=? AND reason='unparseable-title' AND resolved_at IS NULL AND subject_kind IS NULL AND subject_key IS NULL")
        .run(input.now, input.id, input.workKey);
      return result.changes === 1;
    })();
  }

  /** Records a review explicitly linked by trusted reconciliation to one actual intent. */
  flagManualReviewLinked(input: { workKey: string; reason: string; details?: string; intentId: string; at?: Date }): void {
    const at = input.at ?? new Date();
    if (!(at instanceof Date) || !Number.isFinite(at.getTime()) || !input.intentId) throw new Error('Invalid linked manual review');
    this.db.transaction(() => {
      const row = this.db.prepare('SELECT * FROM grab_intents WHERE id=?').get(input.intentId) as Record<string, unknown> | undefined;
      if (!row) throw new Error('Cannot link review to unknown intent');
      const intent = this.decodeIntent(row);
      if (intent.releasedAt || intent.status === 'failed' || intent.status === 'fulfilled' || !intent.coverage.some((capture) => capture.workKey === input.workKey)) throw new Error('Intent is not an unresolved capture of this work');
      const capture = intent.coverage.find((item) => item.workKey === input.workKey)!;
      const work = this.getWorkItem(input.workKey);
      if (!work || (capture.episodeIds === null ? work.unit.kind !== 'movie' : work.unit.kind !== 'tv' || !capture.episodeIds.every((id) => work.unit.kind === 'tv' && work.unit.season?.missing.some((episode) => episode.episodeId === id)))) throw new Error('Intent capture is not present in current reconciled work');
      this.db.prepare('INSERT INTO manual_review(work_key,reason,details,created_at,subject_kind,subject_key) VALUES (?,?,?,?,?,?)')
        .run(input.workKey, input.reason, input.details ?? null, at.toISOString(), 'intent', input.intentId);
    })();
  }

  /** True iff an unresolved row matched; false for unknown ids and already-resolved rows. */
  resolveManualReview(id: number, at: Date = new Date()): boolean {
    const result = this.db
      .prepare('UPDATE manual_review SET resolved_at = ? WHERE id = ? AND resolved_at IS NULL')
      .run(at.toISOString(), id);
    return result.changes > 0;
  }

  listManualReview(includeResolved = false): ManualReviewRow[] {
    const sql = includeResolved
      ? 'SELECT * FROM manual_review ORDER BY created_at DESC, id DESC'
      : 'SELECT * FROM manual_review WHERE resolved_at IS NULL ORDER BY created_at DESC, id DESC';
    return (this.db.prepare(sql).all() as Record<string, unknown>[]).map(decodeManualReviewRow);
  }

  /** Read-only eligibility shared by dashboard projections and the transactional action command. */
  getWorkActionEligibility(workKey: string, now: string = new Date().toISOString()): { retry: { allowed: boolean; reason?: string }; reset: { allowed: boolean; reason?: string } } {
    validIso(now, 'now');
    const retryReason = this.workActionBlockReason(workKey, 'retry', now);
    const resetReason = this.workActionBlockReason(workKey, 'reset', now);
    return {
      retry: retryReason ? { allowed: false, reason: retryReason } : { allowed: true },
      reset: resetReason ? { allowed: false, reason: resetReason } : { allowed: true },
    };
  }

  /**
   * Claim-checked operator scheduling action. Only ordinary scheduling/review state changes;
   * durable queue coverage, reservations, identity, receipts, decisions and source markers survive.
   */
  applyWorkAction(input: { workKey: string; action: WorkAction; ownerToken: string; claimKeys: string[]; now: string }): void {
    validIso(input.now, 'now');
    if (!['retry', 'reset'].includes(input.action)) throw new Error('Invalid work action');
    const keys = normalizeClaimKeys(input.claimKeys);
    if (!keys.includes(input.workKey)) throw new Error('Work action claim is incomplete');
    this.db.transaction(() => {
      for (const key of keys) this.assertClaim(key, input.ownerToken, input.now);
      const work = this.getWorkItem(input.workKey);
      if (!work) throw new Error('Unknown work item');
      if (work.unit.kind === 'tv' && !keys.includes(`group:sonarr:${work.unit.serviceId}`)) throw new Error('TV work action requires the same-series group claim');
      const reason = this.workActionBlockReason(input.workKey, input.action, input.now, input.ownerToken);
      if (reason) throw new Error(`Work action is not eligible: ${reason}`);
      const result = this.db.prepare(`UPDATE work_items SET status='ready',next_search_at=NULL,fail_count=0,last_outcome=NULL,
        last_search_at=CASE WHEN ?='reset' THEN NULL ELSE last_search_at END,
        reset_pending_at=CASE WHEN ?='reset' THEN ? ELSE reset_pending_at END WHERE work_key=?`)
        .run(input.action, input.action, input.action === 'reset' ? input.now : null, input.workKey);
      if (result.changes !== 1) throw new Error('Work action raced with another update');
      this.db.prepare('UPDATE manual_review SET resolved_at=? WHERE work_key=? AND resolved_at IS NULL AND reason IN (?,?,?,?,?,?)')
        .run(input.now, input.workKey, ...ORDINARY_REVIEW_REASONS);
      this.db.prepare('INSERT INTO work_action_audit(work_key,action,occurred_at) VALUES(?,?,?)').run(input.workKey, input.action, input.now);
    })();
  }

  /** Append one bounded search event, independent of the decision/review history. */
  startSearchActivity(input: { source: 'cycle' | 'manual'; query: string; media: Array<{ workKey: string; title: string }>; now: string }): number {
    validIso(input.now, 'activity start');
    if ((input.source !== 'cycle' && input.source !== 'manual') || typeof input.query !== 'string' || !input.query.trim()) throw new Error('Invalid search activity');
    const query = safeActivityText(input.query, 500);
    const media = input.media.slice(0, 20).map(({ workKey, title }) => ({ workKey: safeActivityText(String(workKey), 160), title: safeActivityText(String(title), 120) }));
    const inserted = this.db.prepare(`INSERT INTO search_activity(source,started_at,query,media_json,outcome) VALUES(?,?,?,?, 'running')`)
      .run(input.source, input.now, query, JSON.stringify(media));
    const id = Number(inserted.lastInsertRowid);
    this.pruneSearchActivity(input.now);
    return id;
  }

  finishSearchActivity(input: { id: number; now: string; resultCount: number | null; errorCode?: string }): void {
    validIso(input.now, 'activity finish');
    if (!Number.isSafeInteger(input.id) || input.id < 1 || (input.resultCount !== null && (!Number.isSafeInteger(input.resultCount) || input.resultCount < 0))) throw new Error('Invalid search activity result');
    const code = input.errorCode?.replace(/[^a-z0-9-]/giu, '').slice(0, 40);
    const result = this.db.prepare(`UPDATE search_activity SET finished_at=?,result_count=?,outcome=?,error_code=? WHERE id=? AND outcome='running'`)
      .run(input.now, input.resultCount, input.errorCode ? 'error' : 'success', input.errorCode ? code || 'operation-failed' : null, input.id);
    if (result.changes !== 1) throw new Error('Search activity is missing or already completed');
    this.pruneSearchActivity(input.now);
  }

  listSearchActivity(now: string = new Date().toISOString()): ActivityRecord[] {
    validIso(now, 'activity read');
    const cutoff = new Date(Date.parse(now) - 7 * 24 * 60 * 60_000).toISOString();
    return (this.db.prepare('SELECT * FROM search_activity WHERE started_at>=? ORDER BY started_at DESC,id DESC LIMIT 2000').all(cutoff) as Record<string, unknown>[]).map((row) => {
      let media: unknown;
      try { media = JSON.parse(String(row.media_json)) as unknown; } catch { throw new Error('Corrupt search activity media'); }
      if (!Array.isArray(media) || !media.every((entry) => isRecord(entry) && typeof entry.workKey === 'string' && typeof entry.title === 'string')) throw new Error('Corrupt search activity media');
      return {
        id: Number(row.id), source: row.source as 'cycle' | 'manual', startedAt: String(row.started_at),
        finishedAt: row.finished_at === null ? null : String(row.finished_at), query: String(row.query), media: media as ActivityRecord['media'],
        resultCount: row.result_count === null ? null : Number(row.result_count), outcome: row.outcome as ActivityRecord['outcome'],
        ...(row.error_code === null ? {} : { errorCode: String(row.error_code) }),
      };
    });
  }

  private pruneSearchActivity(now: string): void {
    const cutoff = new Date(Date.parse(now) - 7 * 24 * 60 * 60_000).toISOString();
    this.db.prepare('DELETE FROM search_activity WHERE started_at < ?').run(cutoff);
    this.db.prepare('DELETE FROM search_activity WHERE id NOT IN (SELECT id FROM search_activity ORDER BY started_at DESC,id DESC LIMIT 2000)').run();
  }

  private workActionBlockReason(workKey: string, action: WorkAction, now: string, ownerToken?: string): string | null {
    const work = this.getWorkItem(workKey);
    if (!work) return 'work-not-found';
    const relatedKey = (key: string): boolean => key === workKey || (work.unit.kind === 'tv' && key.startsWith(`sonarr:${work.unit.serviceId}:s`));
    if (work.lastOutcome === 'rate-limited' && work.nextSearchAt !== null && Date.parse(work.nextSearchAt) > Date.parse(now)) return 'rate-limited';
    if (work.blockedReason !== null && work.blockedReason !== 'manual-review') return 'work-held';
    if (!work.queueObservationKnown || work.lastQueueObservedAt === null) return 'queue-observation-unknown';
    const nowMs = Date.parse(now);
    const libraryAt = Date.parse(work.lastObservedAt);
    const queueAt = Date.parse(work.lastQueueObservedAt);
    if (![nowMs, libraryAt, queueAt].every(Number.isFinite) || libraryAt > nowMs || queueAt > nowMs) return 'queue-observation-unknown';
    if (nowMs - queueAt > WORK_OBSERVATION_STALE_AFTER_MS || nowMs - libraryAt > WORK_OBSERVATION_STALE_AFTER_MS) return 'queue-observation-stale';
    const allOpenReviews = this.db.prepare('SELECT work_key,reason FROM manual_review WHERE resolved_at IS NULL').all() as Array<{ work_key: string; reason: string }>;
    const reviews = allOpenReviews.filter(({ work_key: key }) => key === workKey);
    if (allOpenReviews.some(({ work_key: key, reason }) => relatedKey(key) && !(ORDINARY_REVIEW_REASONS as readonly string[]).includes(reason))) return 'review-not-eligible';
    const ordinaryReview = work.status === 'manual' && reviews.length > 0;
    const eligibleStatus = action === 'retry'
      ? ['cooldown', 'backoff'].includes(work.status) || ordinaryReview
      : ['ready', 'cooldown', 'backoff'].includes(work.status) || ordinaryReview;
    if (!eligibleStatus) return action === 'retry' ? 'work-not-retryable' : 'work-not-resettable';

    const works = this.listWorkItems();
    const related = (candidate: WorkItem): boolean => relatedKey(candidate.workKey) ||
      (work.unit.kind === 'tv' && candidate.unit.kind === 'tv' && candidate.unit.arr === work.unit.arr && candidate.unit.serviceId === work.unit.serviceId);
    const relatedKeys = new Set(works.filter(related).map(({ workKey: key }) => key));
    const groupKey = work.unit.kind === 'tv' ? `group:sonarr:${work.unit.serviceId}` : null;
    const cutoff = new Date(Date.parse(now) - CLAIM_TTL_MS).toISOString();
    const leases = this.db.prepare('SELECT work_key,owner FROM unit_claims WHERE claimed_at>=?').all(cutoff) as Array<{ work_key: string; owner: string }>;
    if (leases.some((lease) => (relatedKeys.has(lease.work_key) || lease.work_key === groupKey) && lease.owner !== ownerToken)) return 'work-claimed';

    const openIntents = this.db.prepare("SELECT * FROM grab_intents WHERE released_at IS NULL AND status IN ('submitting','awaiting-queue','active','import-blocked','uncertain')").all() as Record<string, unknown>[];
    for (const row of openIntents) {
      const intent = this.decodeIntent(row);
      if (intent.coverage.some((capture) => relatedKey(capture.workKey))) return 'reservation-open';
    }
    const queueRows = this.db.prepare('SELECT queue_coverage_json FROM work_items').all() as Array<{ queue_coverage_json: string }>;
    for (const row of queueRows) {
      let coverage: unknown;
      try { coverage = JSON.parse(row.queue_coverage_json) as unknown; } catch { return 'queue-coverage-unknown'; }
      validateCoverage(coverage, true);
      if ((coverage as IntentCoverage[]).some((capture) => relatedKey(capture.workKey))) return 'queue-coverage-held';
    }
    return null;
  }

  /** Mints a short-lived, single-use proof handle after the trusted operator service completed its reads. */
  issueOperatorObservation(input: { operation: 'associate_queue' | 'release_intent_hold'; reviewId: number; claims: OperatorClaim[]; observation: OperatorObservation; now: string }): OperatorObservationReceipt {
    validIso(input.now, 'now');
    validateOperatorObservation(input.observation);
    validateOperatorClaims(input.claims);
    if (!Number.isSafeInteger(input.reviewId) || input.reviewId < 1) throw new Error('Invalid review id');
    const readAge = Date.parse(input.now) - Date.parse(input.observation.readCompletedAt);
    if (readAge < 0 || readAge >= OPERATOR_OBSERVATION_TTL_MS || Date.parse(input.observation.readStartedAt) > Date.parse(input.observation.readCompletedAt)) throw new Error('Operator observation is not fresh');
    if (Object.values(input.observation.libraryKnown).some((known) => !known) || Object.values(input.observation.queueKnown).some((known) => !known)) throw new Error('Operator action requires complete known library and queue reads');
    return this.db.transaction(() => {
    const review = this.db.prepare('SELECT * FROM manual_review WHERE id=? AND resolved_at IS NULL').get(input.reviewId) as Record<string, unknown> | undefined;
    if (!review) throw new Error('Review row not found or already resolved');
    const subjectKind = String(review.subject_kind ?? 'review');
    const subjectKey = String(review.subject_key ?? review.work_key);
    if (input.operation === 'release_intent_hold' && (subjectKind !== 'intent' || !subjectKey)) throw new Error('Review is not linked to an intent');
    if (input.operation === 'associate_queue' && !input.observation.associationEvidence) throw new Error('Association evidence is required');
    const workRows = new Map((this.db.prepare('SELECT * FROM work_items').all() as Record<string, unknown>[]).map((row) => [String(row.work_key), this.decodeWorkItem(row)]));
    for (const claim of input.claims) {
      const work = workRows.get(claim.workKey);
      if (!work || work.contentIdentity !== claim.contentIdentity || work.missingFingerprint !== claim.fingerprint) throw new Error('Operator claim does not match current work state');
      const observed = input.observation.libraryEvidence.find((entry) => entry.workKey === claim.workKey);
      if (!observed || observed.contentIdentity !== claim.contentIdentity || observed.missingFingerprint !== claim.fingerprint) throw new Error('Operator claim is not present in fresh library evidence');
      const expectedIds = work.unit.kind === 'tv' ? (work.unit.season?.missing.map(({ episodeId }) => episodeId) ?? []) : [work.unit.serviceId];
      if (!observed.hasAllFiles && !sameIds(expectedIds, observed.missingTargetIds)) throw new Error('Current library target inventory differs from durable work state');
    }
    if (input.operation === 'release_intent_hold') {
      const intent = this.getIntent(subjectKey);
      if (!intent || intent.releasedAt || intent.status === 'failed' || intent.status === 'fulfilled' || intent.status === 'active' || intent.status === 'import-blocked' || intent.confirmedAt !== null || Date.parse(input.now) < Date.parse(intent.queueDeadlineAt)) throw new Error('Intent is not releasable');
      const requiredWorkKeys = this.intentProjectedWorkKeys(intent, workRows);
      if (requiredWorkKeys.some((key) => !input.claims.some((claim) => claim.workKey === key))) throw new Error('Release claims do not cover original and projected captures');
      if (!intent.coverage.every((capture) => {
        const work = workRows.get(capture.workKey);
        const ids = captureTargetIds(capture, work ?? null);
        const entry = input.observation.libraryEvidence.find((candidate) => candidate.workKey === capture.workKey);
        return !!work && !!entry && !entry.hasAllFiles && ids.every((id) => entry.targetIds.includes(id) && entry.missingTargetIds.includes(id));
      })) throw new Error('Captured target is not positively known missing');
      const activeOwners = this.db.prepare('SELECT work_key FROM unit_claims WHERE owner=? AND claimed_at>=?').all(intent.ownerToken, new Date(Date.parse(input.now) - CLAIM_TTL_MS).toISOString()) as Array<{ work_key: string }>;
      if (activeOwners.some(({ work_key }) => intent.coverage.some((capture) => capture.workKey === work_key))) throw new Error('Original intent still has a live processing owner');
    }
    const token = randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.parse(input.now) + OPERATOR_OBSERVATION_TTL_MS).toISOString();
    const challenge = input.operation === 'release_intent_hold' ? RELEASE_CHALLENGE : ASSOCIATION_CHALLENGE;
    const evidenceJson = stableJson(input.observation);
    const inserted = this.db.prepare(`INSERT INTO operator_observations(token_digest,operation,review_id,subject_kind,subject_key,source_config_fingerprint,evidence_json,claims_json,durable_digest,issued_at,expires_at,challenge)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(hashSecret(token), input.operation, input.reviewId, subjectKind, subjectKey, input.observation.sourceConfigFingerprint, evidenceJson, stableJson(input.claims), this.operatorDurableDigest(), input.now, expiresAt, challenge);
    const version = Number(inserted.lastInsertRowid);
    if (!Number.isSafeInteger(version) || version < 1) throw new Error('Unable to allocate operator observation version');
    return { token, version, expiresAt, challenge };
    })();
  }

  /** Reads the private prepared evidence for the trusted service; tokens are never returned by public status APIs. */
  peekOperatorObservation(input: { token: string; operation: 'associate_queue' | 'release_intent_hold'; reviewId: number; now: string }): OperatorObservation {
    validIso(input.now, 'now');
    const row = this.getOperatorObservation(input.token, input.operation, input.reviewId, input.now);
    return JSON.parse(String(row.evidence_json)) as OperatorObservation;
  }

  commitHumanQueueAssociation(input: { token: string; reviewId: number; claims: ClaimSet; decision: AssociationDecision; currentObservation: OperatorObservation; challengeResponse: string; note: string; now: string }): void {
    validIso(input.now, 'now');
    validateOperatorObservation(input.currentObservation);
    validateOperatorNote(input.note);
    validateAssociationDecision(input.decision, input.decision.arr);
    const apply = this.db.transaction(() => {
      const proof = this.getOperatorObservation(input.token, 'associate_queue', input.reviewId, input.now);
      this.assertOperatorCommit(proof, input.claims, input.currentObservation, input.challengeResponse, input.now);
      const evidence = input.currentObservation.associationEvidence;
      if (!evidence || evidence.arr !== input.decision.arr || !input.currentObservation.queueEvidence.some((row) => row.arr === evidence.arr && row.ref === input.decision.queueRef)) throw new Error('Association does not match current queue evidence');
      if (evidence.sourceJobKey !== `${evidence.arr}:${input.decision.queueRef}` || input.decision.outcome !== 'matched' || input.decision.mediaReferences.length !== 1 || input.decision.workReferences.length === 0 ||
        input.decision.potentialScope !== (evidence.arr === 'sonarr' ? 'series' : 'movie') || input.decision.episodeIds !== null || input.decision.basis !== null || input.decision.seasonNumber !== null) throw new Error('Human association cannot claim unsupported scope or provenance');
      const queueRow = input.currentObservation.queueEvidence.find((row) => row.arr === evidence.arr && row.ref === input.decision.queueRef)!;
      const selectedMedia = input.decision.mediaReferences[0];
      if (!selectedMedia || (queueRow.serviceId !== null && queueRow.serviceId !== selectedMedia.serviceId)) throw new Error('Association contradicts a known provider service id');
      const prepared = evidence;
      if (prepared.queueRefs.length !== 1 || prepared.queueRefs[0] !== input.decision.queueRef || !prepared.mediaReferences.some((ref) => stableJson(ref) === stableJson(selectedMedia)) ||
        input.decision.workReferences.some((ref) => !prepared.workReferences.some((preparedRef) => stableJson(preparedRef) === stableJson(ref)))) throw new Error('Association does not match the prepared private index lookup');
      const reviewRow = this.db.prepare('SELECT work_key FROM manual_review WHERE id=? AND resolved_at IS NULL').get(input.reviewId) as { work_key: string } | undefined;
      if (!reviewRow || !input.decision.workReferences.some((ref) => ref.workKey === reviewRow.work_key)) throw new Error('Human association must include the current review work target');
      let boundClaims: unknown;
      try { boundClaims = JSON.parse(String(proof.claims_json)) as unknown; } catch { throw new Error('Corrupt operator claim binding'); }
      if (!Array.isArray(boundClaims) || input.decision.workReferences.some((ref) => !input.claims.keys.includes(ref.workKey) || !boundClaims.some((claim) => isRecord(claim) && claim.workKey === ref.workKey))) throw new Error('Association target is outside the prepared claim set');
      if (new Set(input.decision.workReferences.map(({ workKey }) => workKey)).size !== input.decision.workReferences.length) throw new Error('Duplicate human association work reference');
      for (const ref of input.decision.workReferences) {
        const work = this.getWorkItem(ref.workKey);
        if (!work || work.unit.arr !== ref.arr || work.unit.serviceId !== ref.serviceId || work.unit.externalId !== ref.externalId || ref.arr !== selectedMedia.arr || ref.serviceId !== selectedMedia.serviceId || ref.externalId !== selectedMedia.externalId || ref.seasonNumber !== (work.unit.kind === 'tv' ? work.unit.season?.seasonNumber ?? null : null)) throw new Error('Association references do not match current work');
      }
      const entry: AssociationCacheEntry = {
        arr: evidence.arr, sourceJobKey: evidence.sourceJobKey, materialSignature: evidence.materialSignature,
        contextSignature: evidence.contextSignature, promptVersion: evidence.promptVersion, cachedAt: input.now, decisions: [input.decision],
      };
      this.db.prepare(`INSERT INTO queue_associations(arr,source_job_key,material_signature,context_signature,prompt_version,cache_json,next_attempt_at,failure_count,human_override_json)
        VALUES(?,?,?,?,?,NULL,NULL,0,?) ON CONFLICT(arr,source_job_key) DO UPDATE SET material_signature=excluded.material_signature,context_signature=excluded.context_signature,prompt_version=excluded.prompt_version,human_override_json=excluded.human_override_json`).run(
        entry.arr, entry.sourceJobKey, entry.materialSignature, entry.contextSignature, entry.promptVersion, stableJson(entry));
      this.auditOperatorAction(input.reviewId, 'associate_queue', input.decision.queueRef, input.note, input.now);
      this.consumeOperatorObservation(proof, input.now);
    });
    apply();
  }

  releaseIntentHold(input: { token: string; reviewId: number; claims: ClaimSet; currentObservation: OperatorObservation; challengeResponse: string; note: string; now: string }): void {
    validIso(input.now, 'now');
    validateOperatorObservation(input.currentObservation);
    validateOperatorNote(input.note);
    const apply = this.db.transaction(() => {
      const proof = this.getOperatorObservation(input.token, 'release_intent_hold', input.reviewId, input.now);
      this.assertOperatorCommit(proof, input.claims, input.currentObservation, input.challengeResponse, input.now);
      const intentId = String(proof.subject_key);
      const intentRow = this.db.prepare('SELECT * FROM grab_intents WHERE id=?').get(intentId) as Record<string, unknown> | undefined;
      if (!intentRow) throw new Error('Unknown intent');
      const intent = this.decodeIntent(intentRow);
      if (intent.releasedAt || intent.status === 'failed' || intent.status === 'fulfilled' || Date.parse(input.now) < Date.parse(intent.queueDeadlineAt)) throw new Error('Intent is not eligible for release');
      if (intent.confirmedAt !== null || intent.status === 'active' || intent.status === 'import-blocked') throw new Error('Confirmed or active intent cannot be released');
      if (!intent.coverage.every((capture) => {
        const work = this.getWorkItem(capture.workKey);
        const ids = captureTargetIds(capture, work);
        const entry = input.currentObservation.libraryEvidence.find((candidate) => candidate.workKey === capture.workKey);
        return !!work && !!entry && !entry.hasAllFiles && ids.every((id) => entry.targetIds.includes(id) && entry.missingTargetIds.includes(id));
      })) throw new Error('Captured target is not positively known missing');
      this.assertNoReleaseConflict(intent, input.currentObservation);
      const requiredWorkKeys = this.intentProjectedWorkKeys(intent, new Map(this.listWorkItems().map((work) => [work.workKey, work])));
      const expected = new Set([...requiredWorkKeys, ...requiredWorkKeys.flatMap((key) => {
        const work = this.getWorkItem(key);
        return work?.unit.kind === 'tv' ? [`group:sonarr:${work.unit.serviceId}`] : [];
      })]);
      if (input.claims.keys.length !== expected.size || input.claims.keys.some((key) => !expected.has(key))) throw new Error('Release claim set is incomplete');
      const update = this.db.prepare('UPDATE grab_intents SET released_at=?,release_note=? WHERE id=? AND released_at IS NULL AND status NOT IN (\'failed\',\'fulfilled\')');
      const result = update.run(input.now, input.note, intentId);
      if (result.changes !== 1) throw new Error('Intent release raced with another update');
      this.db.prepare('UPDATE manual_review SET resolved_at=? WHERE id=? AND resolved_at IS NULL').run(input.now, input.reviewId);
      this.auditOperatorAction(input.reviewId, 'release_intent_hold', intentId, input.note, input.now);
      this.consumeOperatorObservation(proof, input.now);
    });
    apply();
  }

  getWorkItem(key: string): WorkItem | null {
    const row = this.db.prepare('SELECT * FROM work_items WHERE work_key = ?').get(key) as Record<string, unknown> | undefined;
    return row ? this.decodeWorkItem(row) : null;
  }

  listWorkItems(): WorkItem[] {
    return (this.db.prepare('SELECT * FROM work_items ORDER BY work_key').all() as Record<string, unknown>[]).map((row) => this.decodeWorkItem(row));
  }

  listGrabIntents(): GrabIntent[] {
    return (this.db.prepare('SELECT * FROM grab_intents ORDER BY started_at, id').all() as Record<string, unknown>[]).map((row) => this.decodeIntent(row));
  }

  listWorkQueueObservations(): PersistedQueueObservation[] {
    return (this.db.prepare('SELECT work_key,queue_coverage_json,queue_failure_refs_json,queue_observed_at,queue_known FROM work_items ORDER BY work_key').all() as Array<Record<string, unknown>>).map((row) => {
      let coverage: unknown;
      let failedQueueRefs: unknown;
      try {
        coverage = JSON.parse(String(row.queue_coverage_json)) as unknown;
        failedQueueRefs = JSON.parse(String(row.queue_failure_refs_json)) as unknown;
      } catch { throw new Error(`Corrupt persisted queue observation for ${String(row.work_key)}`); }
      validateCoverage(coverage, true);
      if (!Array.isArray(failedQueueRefs) || !failedQueueRefs.every((ref) => typeof ref === 'string')) throw new Error(`Corrupt persisted failed queue references for ${String(row.work_key)}`);
      if (row.queue_observed_at !== null) validIso(row.queue_observed_at, 'queue observedAt');
      if (row.queue_known !== 0 && row.queue_known !== 1) throw new Error('Corrupt queue observation flag');
      return { workKey: String(row.work_key), coverage, failedQueueRefs, observedAt: row.queue_observed_at as string | null, known: row.queue_known === 1 };
    });
  }

  /** Stores only the latest complete queue associations for safe status projection; unknown reads preserve prior coverage. */
  applyWorkQueueObservation(input: { key: string; token: string; observedAt: string; known: boolean; coverage: IntentCoverage[]; failedQueueRefs?: string[] }): void {
    validIso(input.observedAt, 'queue observedAt');
    if (input.known) {
      validateCoverage(input.coverage, true);
      if (input.failedQueueRefs !== undefined && (!Array.isArray(input.failedQueueRefs) || !input.failedQueueRefs.every((ref) => typeof ref === 'string'))) throw new Error('Invalid failed queue references');
    }
    const apply = this.db.transaction(() => {
      this.assertClaim(input.key, input.token, input.observedAt);
      const failureRefs = input.failedQueueRefs === undefined ? undefined : JSON.stringify([...new Set(input.failedQueueRefs)]);
      if (input.known && input.coverage.length === 0) {
        const row = this.db.prepare('SELECT blocked_reason FROM work_items WHERE work_key=?').get(input.key) as { blocked_reason: unknown } | undefined;
        if (row?.blocked_reason !== 'queue-review') this.db.prepare('UPDATE work_items SET queue_coverage_json=?,queue_observed_at=?,queue_known=1,queue_failure_refs_json=COALESCE(?,queue_failure_refs_json) WHERE work_key=?').run('[]', input.observedAt, failureRefs ?? null, input.key);
        else this.db.prepare('UPDATE work_items SET queue_observed_at=?,queue_known=1,queue_failure_refs_json=COALESCE(?,queue_failure_refs_json) WHERE work_key=?').run(input.observedAt, failureRefs ?? null, input.key);
      } else if (input.known) this.db.prepare('UPDATE work_items SET queue_coverage_json=?,queue_observed_at=?,queue_known=1,queue_failure_refs_json=COALESCE(?,queue_failure_refs_json) WHERE work_key=?').run(JSON.stringify(input.coverage), input.observedAt, failureRefs ?? null, input.key);
      else this.db.prepare('UPDATE work_items SET queue_known=0 WHERE work_key=?').run(input.key);
    });
    apply();
  }

  /** Persists one observed unit and its queue observations under its live claim. */
  applyWorkReconciliation(input: { key: string; token: string; work: WorkItem; intentUpdates: Array<{ id: string; status: IntentStatus; lastSeenAt?: string | null; queueRefs?: string[] }> }): void {
    validateWorkItem(input.work);
    if (input.work.workKey !== input.key) throw new Error('Work key does not match reconciliation key');
    const apply = this.db.transaction(() => {
      this.assertClaim(input.key, input.token, input.work.lastObservedAt);
      this.initializeLegacyReviews(input.key);
      this.db.prepare(`INSERT INTO work_items (work_key,content_identity,missing_fingerprint,unit_json,status,last_search_at,next_search_at,fail_count,last_outcome,last_observed_at,blocked_reason,reset_pending_at)
        VALUES (@workKey,@contentIdentity,@missingFingerprint,@unitJson,@status,@lastSearchAt,@nextSearchAt,@failCount,@lastOutcome,@lastObservedAt,@blockedReason,@resetPendingAt)
        ON CONFLICT(work_key) DO UPDATE SET content_identity=excluded.content_identity,missing_fingerprint=excluded.missing_fingerprint,unit_json=excluded.unit_json,status=excluded.status,last_search_at=excluded.last_search_at,next_search_at=excluded.next_search_at,fail_count=excluded.fail_count,last_outcome=excluded.last_outcome,last_observed_at=excluded.last_observed_at,blocked_reason=excluded.blocked_reason,reset_pending_at=excluded.reset_pending_at`).run({
        workKey: input.work.workKey, contentIdentity: input.work.contentIdentity, missingFingerprint: input.work.missingFingerprint,
        unitJson: JSON.stringify(input.work.unit), status: input.work.status, lastSearchAt: input.work.lastSearchAt,
        nextSearchAt: input.work.nextSearchAt, failCount: input.work.failCount, lastOutcome: input.work.lastOutcome,
        lastObservedAt: input.work.lastObservedAt, blockedReason: input.work.blockedReason, resetPendingAt: input.work.resetPendingAt ?? null,
      });
      for (const update of input.intentUpdates) {
        if (!INTENT_STATUSES.includes(update.status)) throw new Error('Invalid intent status');
        if (update.lastSeenAt !== undefined && update.lastSeenAt !== null) validIso(update.lastSeenAt, 'lastSeenAt');
        if (update.queueRefs !== undefined && (!Array.isArray(update.queueRefs) || !update.queueRefs.every((ref) => typeof ref === 'string'))) throw new Error('Invalid queue references');
        const intentRow = this.db.prepare('SELECT * FROM grab_intents WHERE id = ?').get(update.id) as Record<string, unknown> | undefined;
        if (!intentRow) throw new Error('Unknown intent');
        const intent = this.decodeIntent(intentRow);
        if (intent.releasedAt) continue;
        if (!intent.coverage.some((coverage) => this.coverageRelatesToWork(coverage, input.work, update.status === 'fulfilled'))) throw new Error('Intent update is unrelated to reconciled work');
        if (intent.status === 'failed' || intent.status === 'fulfilled' || (intent.confirmedAt !== null && update.status === 'uncertain')) throw new Error('Intent transition is not permitted');
        this.db.prepare('UPDATE grab_intents SET status=?, last_seen_at=CASE WHEN ? THEN ? ELSE last_seen_at END, queue_refs_json=CASE WHEN ? THEN ? ELSE queue_refs_json END WHERE id=?').run(
          update.status, update.lastSeenAt === undefined ? 0 : 1, update.lastSeenAt ?? null,
          update.queueRefs === undefined ? 0 : 1, update.queueRefs === undefined ? null : JSON.stringify(update.queueRefs), update.id,
        );
      }
    });
    apply();
  }

  startSearch(input: { key: string; token: string; now: string; recoveryAt: string }): void {
    validIso(input.now, 'now');
    validIso(input.recoveryAt, 'recoveryAt');
    const apply = this.db.transaction(() => {
      this.assertClaim(input.key, input.token, input.now);
      const row = this.db.prepare('SELECT * FROM work_items WHERE work_key=?').get(input.key) as Record<string, unknown> | undefined;
      if (!row) throw new Error('Cannot search unknown work item');
      this.decodeWorkItem(row);
      this.db.prepare("UPDATE work_items SET status='searching',last_search_at=?,next_search_at=? WHERE work_key=?").run(input.now, input.recoveryAt, input.key);
    });
    apply();
  }

  finishSearch(input: { key: string; token: string; status: 'cooldown' | 'backoff' | 'manual'; nextSearchAt: string | null; failCount: number; outcome: string; now: string; decision?: DecisionRecord; expectedStatus?: WorkStatus }): boolean {
    validIso(input.now, 'now');
    if (input.nextSearchAt !== null) validIso(input.nextSearchAt, 'nextSearchAt');
    nonnegativeFinite(input.failCount, 'failCount');
    if (typeof input.outcome !== 'string') throw new Error('Invalid search outcome');
    if (input.decision && input.decision.workKey !== input.key) throw new Error('Decision work key mismatch');
    const apply = this.db.transaction(() => {
      this.assertClaim(input.key, input.token, input.now);
      const row = this.db.prepare('SELECT * FROM work_items WHERE work_key=?').get(input.key) as Record<string, unknown> | undefined;
      if (!row) throw new Error('Cannot finish search for unknown work item');
      const current = this.decodeWorkItem(row);
      if (input.expectedStatus !== undefined && current.status !== input.expectedStatus) return false;
      this.db.prepare('UPDATE work_items SET status=?,next_search_at=?,fail_count=?,last_outcome=? WHERE work_key=?').run(input.status, input.nextSearchAt, input.failCount, input.outcome, input.key);
      if (input.decision) this.insertDecision(input.decision, input.now);
      return true;
    });
    return apply();
  }

  /** Claim-checked status transition and review insertion; stale workers cannot leave a review behind. */
  finishSearchWithReview(input: {
    key: string;
    token: string;
    nextSearchAt: string | null;
    failCount: number;
    outcome: string;
    now: string;
    expectedStatus: 'searching' | 'backoff';
    expectedOutcome?: string;
    expectedFailCount?: number;
    decision?: DecisionRecord;
    review: { reason: string; details?: string };
  }): { finished: boolean; reviewCreated: boolean } {
    validIso(input.now, 'now');
    if (input.nextSearchAt !== null) validIso(input.nextSearchAt, 'nextSearchAt');
    nonnegativeFinite(input.failCount, 'failCount');
    if (typeof input.outcome !== 'string' || typeof input.review.reason !== 'string' || input.review.reason.length === 0 ||
      (input.review.details !== undefined && typeof input.review.details !== 'string')) throw new Error('Invalid reviewed search outcome');
    if (input.decision && input.decision.workKey !== input.key) throw new Error('Decision work key mismatch');
    const apply = this.db.transaction(() => {
      this.assertClaim(input.key, input.token, input.now);
      const row = this.db.prepare('SELECT * FROM work_items WHERE work_key=?').get(input.key) as Record<string, unknown> | undefined;
      if (!row) return { finished: false, reviewCreated: false };
      const current = this.decodeWorkItem(row);
      if (current.status !== input.expectedStatus || (input.expectedOutcome !== undefined && current.lastOutcome !== input.expectedOutcome) ||
        (input.expectedFailCount !== undefined && current.failCount !== input.expectedFailCount)) return { finished: false, reviewCreated: false };
      this.db.prepare("UPDATE work_items SET status='manual',next_search_at=NULL,fail_count=?,last_outcome=? WHERE work_key=?").run(input.failCount, input.outcome, input.key);
      if (input.decision) this.insertDecision(input.decision, input.now);
      const exists = this.db.prepare('SELECT 1 FROM manual_review WHERE work_key=? AND reason=? AND resolved_at IS NULL').get(input.key, input.review.reason) !== undefined;
      if (exists) return { finished: true, reviewCreated: false };
      this.db.prepare('INSERT INTO manual_review (work_key,reason,details,created_at) VALUES (?,?,?,?)')
        .run(input.key, input.review.reason, input.review.details ?? null, input.now);
      return { finished: true, reviewCreated: true };
    });
    return apply();
  }

  beginGrab(input: { key: string; token: string; fingerprint: string; release: { arr: 'sonarr' | 'radarr'; indexerId: number; guid: string; infoHash: string | null; releaseTitle: string }; coverage: IntentCoverage[]; now: string; deadline: string }): { ok: true; intentId: string } | { ok: false; reason: string } {
    const coverage = input.coverage;
    return this.beginGroupGrabInternal({ claims: { ownerToken: input.token, keys: [input.key] }, fingerprints: { [input.key]: input.fingerprint }, release: input.release, coverage, declaredScope: { kind: 'none' }, now: input.now, deadline: input.deadline }, true);
  }

  beginGroupGrab(input: { claims: ClaimSet; fingerprints: Record<string, string>; release: { arr: 'sonarr' | 'radarr'; indexerId: number; guid: string; infoHash: string | null; releaseTitle: string }; coverage: IntentCoverage[]; declaredScope: ParsedReleaseCoverage; now: string; deadline: string }): { ok: true; intentId: string } | { ok: false; reason: string } {
    return this.beginGroupGrabInternal(input, false);
  }

  private beginGroupGrabInternal(input: { claims: ClaimSet; fingerprints: Record<string, string>; release: { arr: 'sonarr' | 'radarr'; indexerId: number; guid: string; infoHash: string | null; releaseTitle: string }; coverage: IntentCoverage[]; declaredScope: ParsedReleaseCoverage; now: string; deadline: string }, allowLegacyStatus: boolean): { ok: true; intentId: string } | { ok: false; reason: string } {
    validIso(input.now, 'now');
    validIso(input.deadline, 'deadline');
    validateCoverage(input.coverage);
    validateParsedCoverage(input.declaredScope);
    const { release } = input;
    if ((release.arr !== 'sonarr' && release.arr !== 'radarr') || !Number.isSafeInteger(release.indexerId) || release.indexerId < 0 || !release.guid || typeof release.guid !== 'string' || (release.infoHash !== null && typeof release.infoHash !== 'string') || typeof release.releaseTitle !== 'string') throw new Error('Invalid grab release identity');
    if (input.declaredScope.kind === 'invalid') return { ok: false, reason: 'invalid-declared-scope' };
    let keys: string[];
    try { keys = normalizeClaimKeys(input.claims.keys); } catch { return { ok: false, reason: 'claim-not-owned' }; }
    if (!input.claims.ownerToken || !isRecord(input.fingerprints)) return { ok: false, reason: 'claim-not-owned' };
    return this.db.transaction(() => {
      for (const key of keys) {
        try { this.assertClaim(key, input.claims.ownerToken, input.now); } catch { return { ok: false as const, reason: 'claim-not-owned' }; }
      }
      const capturedFingerprints: Record<string, string> = {};
      const works: WorkItem[] = [];
      for (const target of input.coverage) {
        if (!keys.includes(target.workKey)) return { ok: false as const, reason: 'claim-not-owned' };
        const workRow = this.db.prepare('SELECT * FROM work_items WHERE work_key=?').get(target.workKey) as Record<string, unknown> | undefined;
        if (!workRow) return { ok: false as const, reason: 'work-not-found' };
        const work = this.decodeWorkItem(workRow);
        works.push(work);
        if (input.fingerprints[target.workKey] !== work.missingFingerprint) return { ok: false as const, reason: 'fingerprint-changed' };
        capturedFingerprints[target.workKey] = work.missingFingerprint;
        if (!allowLegacyStatus && work.status !== 'ready' && work.status !== 'cooldown' && work.status !== 'searching') return { ok: false as const, reason: 'work-not-actionable' };
        if (['queue-unknown', 'queue-ambiguous', 'queue-review', 'content-identity-changed', 'manual-review', 'library-unknown'].includes(work.blockedReason ?? '')) return { ok: false as const, reason: 'work-held-for-review' };
        if (!allowLegacyStatus && ['waiting-release', 'paused', 'import-blocked'].includes(work.blockedReason ?? '')) return { ok: false as const, reason: 'work-held-for-review' };
        if (work.unit.arr !== release.arr) return { ok: false as const, reason: 'source-mismatch' };
        if (work.unit.kind === 'movie') {
          if (target.episodeIds !== null || target.basis !== null) return { ok: false as const, reason: 'coverage-not-in-current-unit' };
        } else if (target.episodeIds === null || !target.episodeIds.every((id) => work.unit.kind === 'tv' && work.unit.season?.missing.some((ep) => ep.episodeId === id))) {
          return { ok: false as const, reason: 'coverage-not-in-current-unit' };
        }
      }
      for (let index = 0; index < input.coverage.length; index += 1) {
        for (let prior = 0; prior < index; prior += 1) if (coverageOverlaps(this, input.coverage[index]!, input.coverage[prior]!)) return { ok: false as const, reason: 'coverage-overlap' };
      }
      if (works.length > 1 && (works.some((work) => work.unit.kind !== 'tv') || works.some((work) => work.unit.kind === 'tv' && (works[0]?.unit.kind !== 'tv' || work.unit.serviceId !== works[0].unit.serviceId)))) return { ok: false as const, reason: 'group-identity-mismatch' };
      if (Object.keys(input.fingerprints).length !== input.coverage.length || Object.keys(input.fingerprints).some((key) => !capturedFingerprints[key])) return { ok: false as const, reason: 'fingerprint-changed' };
      if (this.hasRelease(release.indexerId, release.guid) || (release.infoHash !== null && this.hasHash(release.infoHash))) return { ok: false as const, reason: 'already-recorded' };
      const openIntents = this.db.prepare("SELECT * FROM grab_intents WHERE released_at IS NULL AND status IN ('submitting','awaiting-queue','active','import-blocked','uncertain')").all() as Record<string, unknown>[];
      const activeIntentEvidence = new Set<string>();
      for (const row of openIntents) {
        const intent = this.decodeIntent(row);
        if (intent.indexerId === release.indexerId && intent.guid === release.guid) return { ok: false as const, reason: 'source-identity-reserved' };
        if (release.infoHash !== null && intent.infoHash !== null && hashIdentity(intent.infoHash) === hashIdentity(release.infoHash)) return { ok: false as const, reason: 'hash-reserved' };
        for (const target of input.coverage) {
          const targetWork = this.getWorkItem(target.workKey);
          for (const oldCoverage of intent.coverage) {
            if (coverageOverlaps(this, target, oldCoverage)) return { ok: false as const, reason: 'coverage-reserved' };
            const oldWork = this.getWorkItem(oldCoverage.workKey);
            if (targetWork && this.scopeMayCoverWork(row.declared_scope_json, oldCoverage, target, targetWork)) return { ok: false as const, reason: 'coverage-reserved' };
            if (oldWork && targetWork && this.scopeCoversCoverage(input.declaredScope, targetWork, oldCoverage, oldWork)) return { ok: false as const, reason: 'coverage-reserved' };
            if (oldCoverage.workKey === target.workKey && oldWork && targetWork && this.sameTvSeries(oldWork, targetWork) && target.episodeIds !== null && oldCoverage.episodeIds !== null) activeIntentEvidence.add(target.workKey);
          }
        }
      }
      const queuedRows = this.db.prepare('SELECT work_key,queue_coverage_json FROM work_items').all() as Array<{ work_key: string; queue_coverage_json: string }>;
      const queueResidualEvidence = new Set<string>();
      for (const queueRow of queuedRows) {
        let observedCoverage: unknown;
        try { observedCoverage = JSON.parse(queueRow.queue_coverage_json) as unknown; } catch { throw new Error(`Corrupt persisted queue coverage for ${queueRow.work_key}`); }
        validateCoverage(observedCoverage, true);
        if (observedCoverage.some((oldCoverage) => input.coverage.some((target) => coverageOverlaps(this, target, oldCoverage)))) return { ok: false as const, reason: 'coverage-reserved' };
        for (const oldCoverage of observedCoverage) {
          const oldWork = this.getWorkItem(oldCoverage.workKey);
          for (const target of input.coverage) {
            const targetWork = this.getWorkItem(target.workKey);
            if (oldWork && targetWork && this.scopeCoversCoverage(input.declaredScope, targetWork, oldCoverage, oldWork)) return { ok: false as const, reason: 'coverage-reserved' };
            if (oldCoverage.workKey === target.workKey && oldWork && targetWork && this.sameTvSeries(oldWork, targetWork) && target.episodeIds !== null && oldCoverage.episodeIds !== null) queueResidualEvidence.add(target.workKey);
          }
        }
      }
      if (!allowLegacyStatus) for (let index = 0; index < input.coverage.length; index += 1) {
        const target = input.coverage[index]!;
        const work = works[index];
        if (work?.blockedReason === 'queue-active' && (!work.queueObservationKnown || !queueResidualEvidence.has(target.workKey))) return { ok: false as const, reason: 'work-held-for-review' };
        if (work?.blockedReason === 'active-intent' && (!work.queueObservationKnown || !activeIntentEvidence.has(target.workKey))) return { ok: false as const, reason: 'work-held-for-review' };
      }
      const id = randomUUID();
      this.db.prepare(`INSERT INTO grab_intents (id,owner_token,arr,indexer_id,guid,info_hash,release_title,coverage_json,status,started_at,confirmed_at,queue_deadline_at,last_seen_at,queue_refs_json,captured_fingerprint,captured_fingerprints_json,declared_scope_json)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, input.claims.ownerToken, release.arr, release.indexerId, release.guid, release.infoHash, release.releaseTitle, JSON.stringify(input.coverage), 'submitting', input.now, null, input.deadline, null, '[]', Object.values(capturedFingerprints)[0], JSON.stringify(capturedFingerprints), JSON.stringify(input.declaredScope));
      return { ok: true as const, intentId: id };
    })();
  }

  confirmGrab(input: { intentId: string; ownerToken: string; now: string }): void {
    validIso(input.now, 'now');
    const apply = this.db.transaction(() => {
      const row = this.db.prepare('SELECT * FROM grab_intents WHERE id=?').get(input.intentId) as Record<string, unknown> | undefined;
      if (!row) throw new Error('Unknown grab intent');
      const intent = this.decodeIntent(row);
      if (intent.ownerToken !== input.ownerToken) throw new Error('Intent owner mismatch');
      if (intent.confirmedAt !== null) return;
      if (!['submitting', 'active', 'uncertain', 'fulfilled'].includes(intent.status)) throw new Error('Grab intent cannot be confirmed from current status');
      this.db.prepare("UPDATE grab_intents SET status=CASE WHEN status='submitting' THEN 'awaiting-queue' ELSE status END,confirmed_at=? WHERE id=?").run(input.now, input.intentId);
      const firstKey = intent.coverage[0]?.workKey;
      if (!firstKey) throw new Error('Grab intent has no target work');
      for (const target of intent.coverage) this.insertDecision({ workKey: target.workKey, releaseTitle: intent.releaseTitle, infoHash: intent.infoHash ?? undefined, verdict: 'grab', grabbed: true }, input.now);
      this.recordRelease(intent.indexerId, intent.guid, firstKey, new Date(input.now));
      if (intent.infoHash !== null) this.recordHash(intent.infoHash, firstKey, new Date(input.now));
    });
    apply();
  }

  rejectGrab(input: {
    intentId: string;
    ownerToken: string;
    nextSearchAt: string;
    now: string;
    failureUpdates?: Array<{ workKey: string; outcome: 'operation-failure' | 'rate-limited'; failCount: number; nextSearchAt: string }>;
  }): void {
    validIso(input.now, 'now');
    validIso(input.nextSearchAt, 'nextSearchAt');
    const failureUpdates = new Map((input.failureUpdates ?? []).map((update) => {
      validIso(update.nextSearchAt, 'nextSearchAt');
      nonnegativeFinite(update.failCount, 'failCount');
      if (!update.workKey || (update.outcome !== 'operation-failure' && update.outcome !== 'rate-limited')) throw new Error('Invalid rejected-grab failure update');
      return [update.workKey, update] as const;
    }));
    const apply = this.db.transaction(() => {
      const row = this.db.prepare('SELECT * FROM grab_intents WHERE id=?').get(input.intentId) as Record<string, unknown> | undefined;
      if (!row) throw new Error('Unknown grab intent');
      const intent = this.decodeIntent(row);
      if (intent.ownerToken !== input.ownerToken) throw new Error('Intent owner mismatch');
      if (intent.status === 'failed') return;
      if (intent.status !== 'submitting') throw new Error('Only an unconfirmed submission can be rejected');
      this.db.prepare("UPDATE grab_intents SET status='failed' WHERE id=?").run(input.intentId);
      const captured = this.intentCapturedFingerprints(row, intent.coverage);
      for (const target of intent.coverage) {
        const key = target.workKey;
        const workRow = this.db.prepare('SELECT * FROM work_items WHERE work_key=?').get(key) as Record<string, unknown> | undefined;
        if (!workRow) continue;
        const work = this.decodeWorkItem(workRow);
        // A late definitive failure releases its reservation but cannot overwrite a newer observation/schedule.
        if (work.missingFingerprint === captured[key] && this.hasClaim(key, input.ownerToken, input.now) &&
          (!failureUpdates.has(key) || work.status === 'searching')) {
          const failure = failureUpdates.get(key);
          if (failure) this.db.prepare("UPDATE work_items SET status='backoff',next_search_at=?,fail_count=?,last_outcome=? WHERE work_key=?")
            .run(failure.nextSearchAt, failure.failCount, failure.outcome, key);
          else this.db.prepare("UPDATE work_items SET status='backoff',next_search_at=?,fail_count=fail_count+1,last_outcome='grab-rejected' WHERE work_key=?").run(input.nextSearchAt, key);
        }
      }
    });
    apply();
  }

  markGrabUncertain(input: { intentId: string; ownerToken: string; now: string }): void {
    validIso(input.now, 'now');
    const apply = this.db.transaction(() => {
      const row = this.db.prepare('SELECT * FROM grab_intents WHERE id=?').get(input.intentId) as Record<string, unknown> | undefined;
      if (!row) throw new Error('Unknown grab intent');
      const intent = this.decodeIntent(row);
      if (intent.ownerToken !== input.ownerToken) throw new Error('Intent owner mismatch');
      if (intent.status === 'uncertain') return;
      if (intent.status !== 'submitting') throw new Error('Only an unconfirmed submission can become uncertain');
      this.db.prepare("UPDATE grab_intents SET status='uncertain' WHERE id=?").run(input.intentId);
    });
    apply();
  }

  listAssociationCache(): AssociationCacheEntry[] {
    const rows = this.db.prepare('SELECT * FROM queue_associations WHERE cache_json IS NOT NULL OR human_override_json IS NOT NULL ORDER BY arr,source_job_key').all() as Record<string, unknown>[];
    return rows.map((row) => {
      let value: unknown;
      try {
        const override = row.human_override_json === null || row.human_override_json === undefined ? null : JSON.parse(String(row.human_override_json)) as unknown;
        const llmValue = row.cache_json === null ? null : JSON.parse(String(row.cache_json)) as unknown;
        value = isRecord(override) && override.materialSignature === row.material_signature && override.contextSignature === row.context_signature && override.promptVersion === row.prompt_version
          ? override
          : llmValue;
      } catch { throw new Error('Corrupt persisted association cache JSON'); }
      if (value === null) return null;
      validateAssociationEntry(value);
      if (value.arr !== row.arr || value.sourceJobKey !== row.source_job_key || value.materialSignature !== row.material_signature || value.contextSignature !== row.context_signature || value.promptVersion !== row.prompt_version) throw new Error('Association cache row identity mismatch');
      return value;
    }).filter((entry): entry is AssociationCacheEntry => entry !== null);
  }

  getAssociationRetry(input: { arr: 'sonarr' | 'radarr'; sourceJobKey: string }): { materialSignature: string; contextSignature: string; promptVersion: string; nextAttemptAt: string | null; failCount: number } | null {
    if ((input.arr !== 'sonarr' && input.arr !== 'radarr') || !input.sourceJobKey) throw new Error('Invalid association retry identity');
    const row = this.db.prepare('SELECT COALESCE(retry_material_signature,material_signature) AS material_signature,COALESCE(retry_context_signature,context_signature) AS context_signature,COALESCE(retry_prompt_version,prompt_version) AS prompt_version,next_attempt_at,failure_count FROM queue_associations WHERE arr=? AND source_job_key=?').get(input.arr, input.sourceJobKey) as Record<string, unknown> | undefined;
    if (!row) return null;
    if (row.next_attempt_at !== null) validIso(row.next_attempt_at, 'association nextAttemptAt');
    if (!Number.isSafeInteger(row.failure_count) || (row.failure_count as number) < 0) throw new Error('Corrupt association retry count');
    return { materialSignature: String(row.material_signature), contextSignature: String(row.context_signature), promptVersion: String(row.prompt_version), nextAttemptAt: row.next_attempt_at as string | null, failCount: row.failure_count as number };
  }

  putAssociationCache(input: { entry: AssociationCacheEntry; leaseKey: string; ownerToken: string; now: string }): void {
    validIso(input.now, 'now');
    validateAssociationEntry(input.entry);
    if (input.leaseKey !== `association:${input.entry.arr}`) throw new Error('Association cache requires its source lease');
    const save = this.db.transaction(() => {
      this.assertClaim(input.leaseKey, input.ownerToken, input.now);
      const previous = this.db.prepare('SELECT human_override_json,material_signature,context_signature,prompt_version FROM queue_associations WHERE arr=? AND source_job_key=?').get(input.entry.arr, input.entry.sourceJobKey) as Record<string, unknown> | undefined;
      if (previous?.human_override_json && previous.material_signature === input.entry.materialSignature && previous.context_signature === input.entry.contextSignature && previous.prompt_version === input.entry.promptVersion) return;
      this.db.prepare(`INSERT INTO queue_associations (arr,source_job_key,material_signature,context_signature,prompt_version,cache_json,next_attempt_at,failure_count)
        VALUES (?,?,?,?,?,?,NULL,0) ON CONFLICT(arr,source_job_key) DO UPDATE SET material_signature=excluded.material_signature,context_signature=excluded.context_signature,prompt_version=excluded.prompt_version,cache_json=excluded.cache_json,next_attempt_at=NULL,failure_count=0,retry_material_signature=NULL,retry_context_signature=NULL,retry_prompt_version=NULL`).run(
        input.entry.arr, input.entry.sourceJobKey, input.entry.materialSignature, input.entry.contextSignature, input.entry.promptVersion, JSON.stringify(input.entry));
    });
    save();
  }

  recordAssociationFailure(input: { request: AssociationRequest; leaseKey: string; ownerToken: string; now: string; nextAttemptAt: string; failCount: number }): void {
    validIso(input.now, 'now');
    validIso(input.nextAttemptAt, 'nextAttemptAt');
    if (!Number.isSafeInteger(input.failCount) || input.failCount < 1 || input.failCount > 30) throw new Error('Invalid association failCount');
    if (Date.parse(input.nextAttemptAt) <= Date.parse(input.now)) throw new Error('Association retry time must be in the future');
    const request = input.request;
    if ((request.arr !== 'sonarr' && request.arr !== 'radarr') || !request.sourceJobKey || !request.materialSignature || !request.contextSignature || !request.promptVersion || !Array.isArray(request.queue) || !Array.isArray(request.media) || !Array.isArray(request.targets) || !isRecord(request.lookup)) throw new Error('Invalid association failure request');
    if (input.leaseKey !== `association:${request.arr}`) throw new Error('Association failure requires its source lease');
    const save = this.db.transaction(() => {
      this.assertClaim(input.leaseKey, input.ownerToken, input.now);
      this.db.prepare(`INSERT INTO queue_associations (arr,source_job_key,material_signature,context_signature,prompt_version,cache_json,next_attempt_at,failure_count,retry_material_signature,retry_context_signature,retry_prompt_version)
        VALUES (?,?,?,?,?,NULL,?,?,?,?,?) ON CONFLICT(arr,source_job_key) DO UPDATE SET next_attempt_at=excluded.next_attempt_at,failure_count=excluded.failure_count,retry_material_signature=excluded.retry_material_signature,retry_context_signature=excluded.retry_context_signature,retry_prompt_version=excluded.retry_prompt_version`).run(
        request.arr, request.sourceJobKey, request.materialSignature, request.contextSignature, request.promptVersion, input.nextAttemptAt, input.failCount, request.materialSignature, request.contextSignature, request.promptVersion);
    });
    save();
  }

  getWorkQueueStatus(): WorkQueueStatus {
    const workItems = this.listWorkItems();
    const workByKey = new Map(workItems.map((work) => [work.workKey, work]));
    const intents = this.listGrabIntents().filter((intent) => !intent.releasedAt && OPEN_INTENT_STATUSES.includes(intent.status));
    const counts = Object.fromEntries(WORK_STATUSES.map((status) => [status, 0])) as Record<WorkStatus, number>;
    const items = workItems.map((work) => {
      counts[work.status] += 1;
      const ids = new Set<number>();
      const queueRow = this.db.prepare('SELECT queue_coverage_json,queue_observed_at,queue_known FROM work_items WHERE work_key=?').get(work.workKey) as { queue_coverage_json: string; queue_observed_at: string | null; queue_known: number } | undefined;
      let queueCoverage: unknown;
      try { queueCoverage = JSON.parse(queueRow?.queue_coverage_json ?? '[]') as unknown; } catch { throw new Error(`Corrupt persisted queue coverage for ${work.workKey}`); }
      validateCoverage(queueCoverage, true);
      for (const coverage of queueCoverage) if (coverage.workKey === work.workKey) for (const id of coverage.episodeIds ?? []) ids.add(id);
      for (const intent of intents) for (const coverage of intent.coverage) {
        if (coverage.episodeIds === null) {
          if (coverage.workKey === work.workKey) continue;
          const prior = workByKey.get(coverage.workKey);
          if (prior?.unit.kind === 'movie' && work.unit.kind === 'movie' && prior.unit.arr === work.unit.arr && prior.unit.serviceId === work.unit.serviceId) continue;
        } else if (coverage.workKey === work.workKey) {
          for (const id of coverage.episodeIds) ids.add(id);
        } else if (work.unit.kind === 'tv') {
          const prior = workByKey.get(coverage.workKey);
          if (prior?.unit.kind !== 'tv' || prior.unit.arr !== work.unit.arr || prior.unit.serviceId !== work.unit.serviceId) continue;
          const currentIds = new Set(work.unit.season?.missing.map((episode) => episode.episodeId) ?? []);
          for (const id of coverage.episodeIds) if (currentIds.has(id)) ids.add(id);
        }
      }
      const missingCount = work.unit.kind === 'tv' ? work.unit.season?.missing.length ?? 0 : 1;
      const safeReasons = new Set(['queue-unknown', 'queue-active', 'queue-ambiguous', 'active-intent', 'waiting-release', 'manual-review', 'content-identity-changed', 'queue-review', 'library-unknown']);
      return { workKey: work.workKey, status: work.status, nextSearchAt: work.nextSearchAt, lastObservedAt: work.lastObservedAt, lastQueueObservedAt: queueRow?.queue_observed_at ?? null, queueObservationKnown: queueRow?.queue_known !== 0, missingCount: work.status === 'fulfilled' || work.status === 'inactive' ? 0 : missingCount, coveredEpisodeIds: [...ids].sort((a, b) => a - b), safeHoldReason: work.blockedReason === null ? null : safeReasons.has(work.blockedReason) ? work.blockedReason : 'blocked' };
    });
    return { items, counts, openIntentCount: intents.length };
  }

  private insertDecision(record: DecisionRecord, at: string): void {
    this.db.prepare('INSERT INTO decisions (work_key,release_title,info_hash,verdict,grabbed,decided_at) VALUES (?,?,?,?,?,?)').run(record.workKey, record.releaseTitle ?? null, record.infoHash ?? null, record.verdict, record.grabbed ? 1 : 0, at);
  }

  private getIntent(id: string): GrabIntent | null {
    const row = this.db.prepare('SELECT * FROM grab_intents WHERE id=?').get(id) as Record<string, unknown> | undefined;
    return row ? this.decodeIntent(row) : null;
  }

  private getOperatorObservation(token: string, operation: 'associate_queue' | 'release_intent_hold', reviewId: number, now: string): Record<string, unknown> {
    if (typeof token !== 'string' || token.length < 32) throw new Error('Invalid operator observation token');
    const row = this.db.prepare('SELECT * FROM operator_observations WHERE token_digest=?').get(hashSecret(token)) as Record<string, unknown> | undefined;
    if (!row || row.operation !== operation || row.review_id !== reviewId || row.consumed_at !== null) throw new Error('Operator observation is missing, mismatched, or already consumed');
    validIso(row.issued_at, 'observation issuedAt');
    validIso(row.expires_at, 'observation expiresAt');
    if (Date.parse(now) >= Date.parse(String(row.expires_at)) || Date.parse(now) < Date.parse(String(row.issued_at))) throw new Error('Operator observation expired');
    return row;
  }

  private assertOperatorCommit(proof: Record<string, unknown>, claims: ClaimSet, currentObservation: OperatorObservation, challengeResponse: string, now: string): void {
    if (challengeResponse !== proof.challenge || proof.challenge !== (proof.operation === 'release_intent_hold' ? RELEASE_CHALLENGE : ASSOCIATION_CHALLENGE)) throw new Error('Operator challenge response did not match');
    validateOperatorObservation(currentObservation);
    const completedAge = Date.parse(now) - Date.parse(currentObservation.readCompletedAt);
    if (completedAge < 0 || completedAge >= OPERATOR_OBSERVATION_TTL_MS || Date.parse(currentObservation.readStartedAt) > Date.parse(currentObservation.readCompletedAt)) throw new Error('Current external observation is not fresh');
    if (!sameOperatorEvidence(JSON.parse(String(proof.evidence_json)) as OperatorObservation, currentObservation)) throw new Error('Current external observation changed since prepare');
    if (currentObservation.sourceConfigFingerprint !== proof.source_config_fingerprint) throw new Error('Operator source configuration changed');
    if (this.operatorDurableDigest() !== proof.durable_digest) throw new Error('Durable state changed since prepare');
    if (!claims || typeof claims.ownerToken !== 'string' || !claims.ownerToken) throw new Error('Current operator claims required');
    const keys = normalizeClaimKeys(claims.keys);
    if (keys.length !== claims.keys.length || keys.some((key) => !claims.keys.includes(key))) throw new Error('Invalid operator claim set');
    for (const key of keys) this.assertClaim(key, claims.ownerToken, now);
    let bound: unknown;
    try { bound = JSON.parse(String(proof.claims_json)) as unknown; } catch { throw new Error('Corrupt operator claim binding'); }
    if (!Array.isArray(bound) || bound.some((item) => !isRecord(item) || !keys.includes(String(item.workKey)))) throw new Error('Operator claim set does not cover prepared targets');
    for (const claim of bound as OperatorClaim[]) {
      const work = this.getWorkItem(claim.workKey);
      if (!work || work.contentIdentity !== claim.contentIdentity || work.missingFingerprint !== claim.fingerprint) throw new Error('Operator work fingerprint changed');
    }
    const review = this.db.prepare('SELECT 1 FROM manual_review WHERE id=? AND resolved_at IS NULL').get(proof.review_id);
    if (!review) throw new Error('Review row is no longer open');
  }

  private assertNoReleaseConflict(intent: GrabIntent, observation: OperatorObservation): void {
    for (const capture of intent.coverage) {
      const work = this.getWorkItem(capture.workKey);
      if (work && ['queue-active', 'paused', 'import-blocked', 'queue-unknown', 'queue-ambiguous'].includes(work.blockedReason ?? '')) throw new Error('Captured work still has a queue/unknown hold');
    }
    const queued = this.db.prepare('SELECT work_key,queue_coverage_json FROM work_items').all() as Array<{ work_key: string; queue_coverage_json: string }>;
    for (const row of queued) {
      let coverages: unknown;
      try { coverages = JSON.parse(row.queue_coverage_json) as unknown; } catch { throw new Error('Corrupt persisted queue coverage blocks release'); }
      validateCoverage(coverages, true);
      if ((coverages as IntentCoverage[]).some((queuedCapture) => intent.coverage.some((capture) => coverageOverlaps(this, capture, queuedCapture)))) throw new Error('A persisted queue hold may conflict with captured coverage');
    }
    const otherIntents = this.db.prepare("SELECT * FROM grab_intents WHERE released_at IS NULL AND id<>? AND status IN ('submitting','awaiting-queue','active','import-blocked','uncertain')").all(intent.id) as Record<string, unknown>[];
    for (const row of otherIntents) {
      const other = this.decodeIntent(row);
      for (const capture of intent.coverage) for (const otherCapture of other.coverage) {
        if (coverageOverlaps(this, capture, otherCapture)) throw new Error('Another open intent still reserves captured coverage');
        const work = this.getWorkItem(capture.workKey);
        if (work && this.scopeMayCoverWork(row.declared_scope_json, otherCapture, capture, work)) throw new Error('Another open intent scope may overlap captured coverage');
      }
    }
    for (const row of observation.queueEvidence) {
      if (row.arr !== intent.arr) continue;
      const definitelyFailed = row.status === 'failed' || row.trackedState === 'failed';
      if (definitelyFailed) continue;
      if (row.ref !== null && intent.queueRefs.includes(row.ref)) throw new Error('Intent still has a matching queue reference');
      const couldConflict = row.serviceId === null || intent.coverage.some((capture) => {
        const work = this.getWorkItem(capture.workKey);
        if (!work || work.unit.arr !== row.arr || work.unit.serviceId !== row.serviceId) return false;
        if (row.arr === 'radarr') return true;
        if (row.episodeId !== null) return capture.episodeIds === null || capture.episodeIds.includes(row.episodeId);
        if (row.seasonNumber !== null) return work.unit.kind === 'tv' && work.unit.season?.seasonNumber === row.seasonNumber;
        return true;
      });
      if (couldConflict) throw new Error('A queue row may conflict with the intent capture');
    }
  }

  private intentProjectedWorkKeys(intent: GrabIntent, works: Map<string, WorkItem>): string[] {
    const keys = new Set(intent.coverage.map((capture) => capture.workKey));
    for (const capture of intent.coverage) {
      if (capture.episodeIds === null) continue;
      const original = works.get(capture.workKey);
      if (original?.unit.kind !== 'tv') continue;
      const episodeIds = new Set(capture.episodeIds);
      for (const candidate of works.values()) {
        if (candidate.unit.kind === 'tv' && candidate.unit.arr === original.unit.arr && candidate.unit.serviceId === original.unit.serviceId &&
          candidate.unit.season?.missing.some((episode) => episodeIds.has(episode.episodeId))) keys.add(candidate.workKey);
      }
    }
    return [...keys].sort();
  }

  private operatorDurableDigest(): string {
    const tables = ['manual_review', 'work_items', 'grab_intents', 'queue_associations', 'seen_hashes', 'seen_releases', 'decisions', 'operator_audit'] as const;
    const value = tables.map((table) => this.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all());
    return hashSecret(stableJson(value));
  }

  private auditOperatorAction(reviewId: number, operation: string, subjectKey: string, note: string, now: string): void {
    this.db.prepare('INSERT INTO operator_audit(review_id,operation,subject_key,note,occurred_at) VALUES(?,?,?,?,?)').run(reviewId, operation, subjectKey, note, now);
  }

  private consumeOperatorObservation(proof: Record<string, unknown>, now: string): void {
    const result = this.db.prepare('UPDATE operator_observations SET consumed_at=? WHERE id=? AND consumed_at IS NULL').run(now, proof.id);
    if (result.changes !== 1) throw new Error('Operator observation was already consumed');
  }

  private decodeWorkItem(row: Record<string, unknown>): WorkItem {
    let unit: unknown;
    try { unit = JSON.parse(String(row.unit_json)) as unknown; } catch { throw new Error(`Corrupt work unit JSON for ${String(row.work_key)}`); }
    if (row.queue_known !== 0 && row.queue_known !== 1) throw new Error(`Corrupt queue observation flag for ${String(row.work_key)}`);
    const item: unknown = {
      workKey: row.work_key, contentIdentity: row.content_identity, missingFingerprint: row.missing_fingerprint, unit,
      status: row.status, lastSearchAt: row.last_search_at ?? null, nextSearchAt: row.next_search_at ?? null,
      failCount: row.fail_count, lastOutcome: row.last_outcome ?? null, lastObservedAt: row.last_observed_at, blockedReason: row.blocked_reason ?? null,
      lastQueueObservedAt: row.queue_observed_at ?? null, queueObservationKnown: row.queue_known === 1,
      ...(row.reset_pending_at === null || row.reset_pending_at === undefined ? {} : { resetPendingAt: row.reset_pending_at }),
    };
    validateWorkItem(item);
    return item;
  }

  private decodeIntent(row: Record<string, unknown>): GrabIntent {
    let coverage: unknown;
    let queueRefs: unknown;
    try { coverage = JSON.parse(String(row.coverage_json)) as unknown; queueRefs = JSON.parse(String(row.queue_refs_json)) as unknown; } catch { throw new Error(`Corrupt grab intent JSON for ${String(row.id)}`); }
    validateCoverage(coverage);
    if (row.captured_fingerprints_json !== undefined && row.captured_fingerprints_json !== null) {
      let fingerprints: unknown;
      try { fingerprints = JSON.parse(String(row.captured_fingerprints_json)) as unknown; } catch { throw new Error(`Corrupt captured fingerprints for ${String(row.id)}`); }
      if (!isRecord(fingerprints) || Object.keys(fingerprints).length !== coverage.length || coverage.some((item) => typeof fingerprints[item.workKey] !== 'string' || !(fingerprints[item.workKey] as string))) throw new Error(`Corrupt captured fingerprints for ${String(row.id)}`);
    }
    if (row.declared_scope_json !== undefined && row.declared_scope_json !== null) {
      let scope: unknown;
      try { scope = JSON.parse(String(row.declared_scope_json)) as unknown; } catch { throw new Error(`Corrupt declared scope for ${String(row.id)}`); }
      validateParsedCoverage(scope);
    }
    if (!Array.isArray(queueRefs) || !queueRefs.every((ref) => typeof ref === 'string')) throw new Error('Corrupt intent queue references');
    if (typeof row.id !== 'string' || typeof row.owner_token !== 'string' || (row.arr !== 'sonarr' && row.arr !== 'radarr') || !Number.isSafeInteger(row.indexer_id) || (row.indexer_id as number) < 0 || typeof row.guid !== 'string' || (row.info_hash !== null && typeof row.info_hash !== 'string') || typeof row.release_title !== 'string' || !INTENT_STATUSES.includes(row.status as IntentStatus) || typeof row.captured_fingerprint !== 'string' || row.captured_fingerprint.length === 0) throw new Error('Corrupt grab intent row');
    validIso(row.started_at, 'intent startedAt');
    if (row.confirmed_at !== null) validIso(row.confirmed_at, 'intent confirmedAt');
    validIso(row.queue_deadline_at, 'intent queueDeadlineAt');
    if (row.last_seen_at !== null) validIso(row.last_seen_at, 'intent lastSeenAt');
    if (row.released_at !== undefined && row.released_at !== null) validIso(row.released_at, 'intent releasedAt');
    if (row.release_note !== undefined && row.release_note !== null && typeof row.release_note !== 'string') throw new Error('Corrupt intent release note');
    return {
      id: row.id, ownerToken: row.owner_token, arr: row.arr, indexerId: row.indexer_id as number, guid: row.guid,
      infoHash: row.info_hash as string | null, releaseTitle: row.release_title, coverage, status: row.status as IntentStatus,
      startedAt: row.started_at as string, confirmedAt: row.confirmed_at as string | null,
      queueDeadlineAt: row.queue_deadline_at as string, lastSeenAt: row.last_seen_at as string | null, queueRefs,
      ...(row.released_at !== undefined && row.released_at !== null ? { releasedAt: row.released_at as string } : {}),
      ...(row.release_note !== undefined && row.release_note !== null ? { releaseNote: row.release_note as string } : {}),
    };
  }

  private coverageRelatesToWork(coverage: IntentCoverage, work: WorkItem, positiveLibraryReceipt = false): boolean {
    if (coverage.workKey === work.workKey) return true;
    if (coverage.episodeIds === null || work.unit.kind !== 'tv') return false;
    const priorRow = this.db.prepare('SELECT * FROM work_items WHERE work_key=?').get(coverage.workKey) as Record<string, unknown> | undefined;
    if (!priorRow) return false;
    const prior = this.decodeWorkItem(priorRow);
    if (prior.unit.kind !== 'tv' || prior.unit.arr !== work.unit.arr || prior.unit.serviceId !== work.unit.serviceId) return false;
    if (positiveLibraryReceipt) return true;
    const currentIds = new Set(work.unit.season?.missing.map((episode) => episode.episodeId) ?? []);
    return coverage.episodeIds.some((id) => currentIds.has(id));
  }

  private intentCapturedFingerprints(row: Record<string, unknown>, coverage: IntentCoverage[]): Record<string, string> {
    if (row.captured_fingerprints_json === undefined || row.captured_fingerprints_json === null) {
      const legacy = row.captured_fingerprint;
      if (typeof legacy !== 'string' || !legacy) throw new Error('Corrupt legacy captured fingerprint');
      return Object.fromEntries(coverage.map((item) => [item.workKey, legacy]));
    }
    let value: unknown;
    try { value = JSON.parse(String(row.captured_fingerprints_json)) as unknown; } catch { throw new Error('Corrupt captured fingerprints'); }
    if (!isRecord(value)) throw new Error('Corrupt captured fingerprints');
    return value as Record<string, string>;
  }

  private scopeMayCoverWork(serializedScope: unknown, scopeOwner: IntentCoverage, target: IntentCoverage, work: WorkItem): boolean {
    if (serializedScope === undefined || serializedScope === null) return false;
    let scope: unknown;
    try { scope = JSON.parse(String(serializedScope)) as unknown; } catch { throw new Error('Corrupt declared release scope'); }
    validateParsedCoverage(scope);
    const ownerWork = this.getWorkItem(scopeOwner.workKey);
    if (!ownerWork) return scope.kind === 'claims' && work.unit.kind === 'tv';
    return this.scopeCoversCoverage(scope, ownerWork, target, work);
  }

  private scopeCoversCoverage(scope: ParsedReleaseCoverage, owner: WorkItem, target: IntentCoverage, work: WorkItem): boolean {
    if (scope.kind !== 'claims' || !this.sameTvSeries(owner, work) || work.unit.kind !== 'tv') return false;
    if (scope.wholeSeries) return true;
    const season = work.unit.season;
    if (!season) return false;
    const seasonClaims = scope.seasonClaims.filter((claim) => claim.seasonNumber === season.seasonNumber);
    if (seasonClaims.some((claim) => claim.episodes === null)) return true;
    const targets = target.episodeIds === null
      ? season.missing
      : target.episodeIds.map((id) => season.missing.find((episode) => episode.episodeId === id));
    if (targets.some((episode) => episode === undefined)) return seasonClaims.length > 0 || (scope.absoluteEpisodes?.length ?? 0) > 0 || (scope.unqualifiedEpisodes?.length ?? 0) > 0;
    const episodes = targets as NonNullable<(typeof targets)[number]>[];
    if (seasonClaims.some((claim) => claim.episodes?.some((number) => episodes.some((episode) => episode.episodeNumber === number)))) return true;
    if (scope.absoluteEpisodes?.some((number) => episodes.some((episode) => episode.absoluteEpisodeNumber === number))) return true;
    return scope.unqualifiedEpisodes?.some((number) => episodes.some((episode) => episode.episodeNumber === number || episode.absoluteEpisodeNumber === number)) ?? false;
  }

  private sameTvSeries(left: WorkItem, right: WorkItem): boolean {
    return left.unit.kind === 'tv' && right.unit.kind === 'tv' && left.unit.arr === right.unit.arr && left.unit.serviceId === right.unit.serviceId;
  }

  private hasClaim(key: string, token: string, now: string): boolean {
    const cutoff = new Date(Date.parse(now) - CLAIM_TTL_MS).toISOString();
    const row = this.db.prepare('SELECT 1 FROM unit_claims WHERE work_key=? AND owner=? AND claimed_at>=?').get(key, token, cutoff);
    return row !== undefined;
  }

  private assertClaim(key: string, token: string, now: string): void {
    validIso(now, 'claim check time');
    if (!this.hasClaim(key, token, now)) throw new Error('Current unexpired work claim required');
  }

  private ensureQueueObservationColumns(): void {
    const columns = new Set((this.db.prepare('PRAGMA table_info(work_items)').all() as Array<{ name: string }>).map((column) => column.name));
    if (!columns.has('queue_coverage_json')) this.db.exec("ALTER TABLE work_items ADD COLUMN queue_coverage_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(queue_coverage_json))");
    if (!columns.has('queue_observed_at')) this.db.exec('ALTER TABLE work_items ADD COLUMN queue_observed_at TEXT');
    if (!columns.has('queue_known')) this.db.exec('ALTER TABLE work_items ADD COLUMN queue_known INTEGER NOT NULL DEFAULT 0 CHECK (queue_known IN (0,1))');
    if (!columns.has('queue_failure_refs_json')) this.db.exec("ALTER TABLE work_items ADD COLUMN queue_failure_refs_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(queue_failure_refs_json))");
  }

  private ensureOperationsColumns(): void {
    const columns = new Set((this.db.prepare('PRAGMA table_info(work_items)').all() as Array<{ name: string }>).map((column) => column.name));
    if (!columns.has('reset_pending_at')) this.db.exec('ALTER TABLE work_items ADD COLUMN reset_pending_at TEXT');
  }

  private ensureGroupAssociationColumns(): void {
    const columns = new Set((this.db.prepare('PRAGMA table_info(grab_intents)').all() as Array<{ name: string }>).map((column) => column.name));
    if (!columns.has('captured_fingerprints_json')) this.db.exec('ALTER TABLE grab_intents ADD COLUMN captured_fingerprints_json TEXT');
    if (!columns.has('declared_scope_json')) this.db.exec('ALTER TABLE grab_intents ADD COLUMN declared_scope_json TEXT');
    const associationColumns = new Set((this.db.prepare('PRAGMA table_info(queue_associations)').all() as Array<{ name: string }>).map((column) => column.name));
    if (!associationColumns.has('retry_material_signature')) this.db.exec('ALTER TABLE queue_associations ADD COLUMN retry_material_signature TEXT');
    if (!associationColumns.has('retry_context_signature')) this.db.exec('ALTER TABLE queue_associations ADD COLUMN retry_context_signature TEXT');
    if (!associationColumns.has('retry_prompt_version')) this.db.exec('ALTER TABLE queue_associations ADD COLUMN retry_prompt_version TEXT');
  }

  private ensureOperatorColumns(): void {
    const reviewColumns = new Set((this.db.prepare('PRAGMA table_info(manual_review)').all() as Array<{ name: string }>).map((column) => column.name));
    if (!reviewColumns.has('subject_kind')) this.db.exec('ALTER TABLE manual_review ADD COLUMN subject_kind TEXT');
    if (!reviewColumns.has('subject_key')) this.db.exec('ALTER TABLE manual_review ADD COLUMN subject_key TEXT');
    const intentColumns = new Set((this.db.prepare('PRAGMA table_info(grab_intents)').all() as Array<{ name: string }>).map((column) => column.name));
    if (!intentColumns.has('released_at')) this.db.exec('ALTER TABLE grab_intents ADD COLUMN released_at TEXT');
    if (!intentColumns.has('release_note')) this.db.exec('ALTER TABLE grab_intents ADD COLUMN release_note TEXT');
    const associationColumns = new Set((this.db.prepare('PRAGMA table_info(queue_associations)').all() as Array<{ name: string }>).map((column) => column.name));
    if (!associationColumns.has('human_override_json')) this.db.exec('ALTER TABLE queue_associations ADD COLUMN human_override_json TEXT');
  }

  private ensureReviewEvidenceColumn(): void {
    const columns = new Set((this.db.prepare('PRAGMA table_info(manual_review)').all() as Array<{ name: string }>).map(({ name }) => name));
    if (!columns.has('target_evidence_json')) this.db.exec('ALTER TABLE manual_review ADD COLUMN target_evidence_json TEXT');
  }

  /**
   * I4 cross-process gate: daemon and MCP server are separate processes sharing
   * DB_PATH; a per-unit persisted claim is the only thing that can keep both
   * from grabbing the same unit before either records a decision. Returns an
   * owner token on success, null when a fresh conflicting claim is held
   * elsewhere. Stale claims (older than the TTL) are reaped first — crash
   * protection: a healthy unit completes in seconds, so any claim this old
   * belongs to a dead process, not a slow one. The token prevents a worker that
   * lost its claim to TTL expiry from deleting a successor's claim on release.
   */
  claimUnit(workKey: string, at: Date = new Date()): string | null {
    const ttlCutoff = new Date(at.getTime() - CLAIM_TTL_MS).toISOString();
    this.db.prepare('DELETE FROM unit_claims WHERE claimed_at < ?').run(ttlCutoff);
    const owner = randomUUID();
    try {
      this.db
        .prepare('INSERT INTO unit_claims (work_key, claimed_at, owner) VALUES (?, ?, ?)')
        .run(workKey, at.toISOString(), owner);
      return owner;
    } catch {
      return null; // fresh conflicting row = claim held elsewhere
    }
  }

  /** Atomically acquires every deduplicated key using one immutable owner token. */
  claimUnits(input: { keys: string[]; now: Date }): ClaimSet | null {
    const keys = normalizeClaimKeys(input.keys);
    if (!(input.now instanceof Date) || !Number.isFinite(input.now.getTime())) throw new Error('Invalid claim time');
    const now = input.now.toISOString();
    const cutoff = new Date(input.now.getTime() - CLAIM_TTL_MS).toISOString();
    const ownerToken = randomUUID();
    return this.db.transaction(() => {
      this.db.prepare('DELETE FROM unit_claims WHERE claimed_at < ?').run(cutoff);
      const lookup = this.db.prepare('SELECT owner FROM unit_claims WHERE work_key=?');
      if (keys.some((key) => lookup.get(key) !== undefined)) return null;
      const insert = this.db.prepare('INSERT INTO unit_claims (work_key,claimed_at,owner) VALUES (?,?,?)');
      for (const key of keys) insert.run(key, now, ownerToken);
      return { ownerToken, keys };
    })();
  }

  /** Releases an entire still-owned claim set, including an expired lease, or none of it. */
  releaseClaims(input: { keys: string[]; ownerToken: string }): void {
    const keys = normalizeClaimKeys(input.keys);
    if (!input.ownerToken) throw new Error('Invalid claim owner');
    const release = this.db.transaction(() => {
      const lookup = this.db.prepare('SELECT owner FROM unit_claims WHERE work_key=?');
      for (const key of keys) {
        const row = lookup.get(key) as { owner: string } | undefined;
        if (!row || row.owner !== input.ownerToken) throw new Error('Claim set is no longer wholly owned');
      }
      const remove = this.db.prepare('DELETE FROM unit_claims WHERE work_key=? AND owner=?');
      for (const key of keys) remove.run(key, input.ownerToken);
    });
    release();
  }

  /** Renews a complete live claim set atomically; returns false without changing any lease on failure. */
  renewClaims(input: { keys: string[]; ownerToken: string; now: Date }): boolean {
    const keys = normalizeClaimKeys(input.keys);
    if (!(input.now instanceof Date) || !Number.isFinite(input.now.getTime()) || !input.ownerToken) throw new Error('Invalid claim renewal');
    const now = input.now.toISOString();
    const cutoff = new Date(input.now.getTime() - CLAIM_TTL_MS).toISOString();
    const renew = this.db.transaction(() => {
      const lookup = this.db.prepare('SELECT owner,claimed_at FROM unit_claims WHERE work_key=?');
      for (const key of keys) {
        const row = lookup.get(key) as { owner: string; claimed_at: string } | undefined;
        if (!row || row.owner !== input.ownerToken || row.claimed_at < cutoff) return false;
      }
      const update = this.db.prepare('UPDATE unit_claims SET claimed_at=? WHERE work_key=? AND owner=?');
      for (const key of keys) update.run(now, key, input.ownerToken);
      return true;
    });
    return renew();
  }

  /** Only the owning token may release — a stale owner's release is a no-op. */
  releaseClaim(workKey: string, owner: string): void {
    this.db.prepare('DELETE FROM unit_claims WHERE work_key = ? AND owner = ?').run(workKey, owner);
  }
}

function coverageOverlaps(state: State, left: IntentCoverage, right: IntentCoverage): boolean {
  if (left.workKey === right.workKey) {
    if (left.episodeIds === null || right.episodeIds === null) return true;
    const ids = new Set(left.episodeIds);
    return right.episodeIds.some((id) => ids.has(id));
  }
  if (left.episodeIds === null || right.episodeIds === null) return false;
  const leftWork = state.getWorkItem(left.workKey);
  const rightWork = state.getWorkItem(right.workKey);
  if (!leftWork || !rightWork || leftWork.unit.kind !== 'tv' || rightWork.unit.kind !== 'tv') return false;
  if (leftWork.unit.arr !== rightWork.unit.arr || leftWork.unit.serviceId !== rightWork.unit.serviceId) return false;
  const ids = new Set(left.episodeIds);
  return right.episodeIds.some((id) => ids.has(id));
}

function normalizeClaimKeys(keys: unknown): string[] {
  if (!Array.isArray(keys) || keys.length === 0 || !keys.every((key) => typeof key === 'string' && key.length > 0 && key.trim() === key && !key.includes('\0'))) throw new Error('Invalid claim keys');
  return [...new Set(keys as string[])].sort();
}

const OPERATOR_OBSERVATION_TTL_MS = 120_000;
const RELEASE_CHALLENGE = 'I inspected the download client(s), including routing used at submission; no matching download is active, and I authorize releasing this reservation so retries may become eligible.';
const ASSOCIATION_CHALLENGE = 'I reviewed the supplied current queue and library evidence and authorize this exact queue association.';

function hashSecret(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function safeActivityText(value: string, max: number): string {
  return value.replace(/\b[a-z][a-z\d+.-]{1,15}:\/\/\S+/giu, '[URL]').replace(/magnet:\?\S+/giu, '[URL]')
    .replace(/(?:^|[\s("'=])\/(?:[^/\s]+\/)+[^/\s]+/gu, ' [PATH]').replace(/\b[A-Za-z]:\\(?:[^\\\s]+\\)*[^\\\s]+/gu, '[PATH]').replace(/\b(?:[\da-f]{64}|[\da-f]{40}|[\da-f]{32})\b/giu, '[HASH]')
    .replace(/[\u0000-\u001f\u007f]/gu, ' ').replace(/\s+/gu, ' ').trim().slice(0, max);
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function validateOperatorClaims(value: unknown): asserts value is OperatorClaim[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 500) throw new Error('Invalid operator claims');
  const seen = new Set<string>();
  for (const item of value) {
    if (!isRecord(item) || Object.keys(item).some((key) => !['workKey', 'contentIdentity', 'fingerprint'].includes(key)) || typeof item.workKey !== 'string' || !item.workKey || item.workKey.length > 300 || seen.has(item.workKey) || typeof item.contentIdentity !== 'string' || !item.contentIdentity || item.contentIdentity.length > 1000 || typeof item.fingerprint !== 'string' || !item.fingerprint || item.fingerprint.length > 1000) throw new Error('Invalid operator claim');
    seen.add(item.workKey);
  }
}

function validateOperatorObservation(value: unknown): asserts value is OperatorObservation {
  if (!isRecord(value) || Object.keys(value).some((key) => !['sourceConfigFingerprint', 'readStartedAt', 'readCompletedAt', 'libraryKnown', 'queueKnown', 'libraryEvidence', 'queueEvidence', 'associationEvidence'].includes(key)) ||
    typeof value.sourceConfigFingerprint !== 'string' || !value.sourceConfigFingerprint || !isRecord(value.libraryKnown) || Object.keys(value.libraryKnown).some((key) => !['sonarr', 'radarr'].includes(key)) || !isRecord(value.queueKnown) || Object.keys(value.queueKnown).some((key) => !['sonarr', 'radarr'].includes(key)) || !Array.isArray(value.libraryEvidence) || value.libraryEvidence.length > 20_000 || !Array.isArray(value.queueEvidence) || value.queueEvidence.length > 20_000) throw new Error('Invalid operator observation');
  validIso(value.readStartedAt, 'operator readStartedAt');
  validIso(value.readCompletedAt, 'operator readCompletedAt');
  for (const known of [value.libraryKnown, value.queueKnown]) if (typeof known.sonarr !== 'boolean' || typeof known.radarr !== 'boolean') throw new Error('Invalid operator observation completeness');
  const workKeys = new Set<string>();
  for (const entry of value.libraryEvidence) {
    if (!isRecord(entry) || Object.keys(entry).some((key) => !['workKey', 'contentIdentity', 'missingFingerprint', 'contentEvidenceFingerprint', 'targetIds', 'missingTargetIds', 'hasAllFiles'].includes(key)) || typeof entry.workKey !== 'string' || !entry.workKey || workKeys.has(entry.workKey) || typeof entry.contentIdentity !== 'string' || typeof entry.missingFingerprint !== 'string' || typeof entry.contentEvidenceFingerprint !== 'string' || !entry.contentEvidenceFingerprint || !Array.isArray(entry.targetIds) || !entry.targetIds.every((id) => Number.isSafeInteger(id) && id > 0) || !Array.isArray(entry.missingTargetIds) || !entry.missingTargetIds.every((id) => Number.isSafeInteger(id) && id > 0) || typeof entry.hasAllFiles !== 'boolean') throw new Error('Invalid operator library evidence');
    if (new Set(entry.targetIds).size !== entry.targetIds.length || new Set(entry.missingTargetIds).size !== entry.missingTargetIds.length || entry.missingTargetIds.some((id) => !(entry.targetIds as number[]).includes(id))) throw new Error('Invalid operator target evidence');
    workKeys.add(entry.workKey);
  }
  for (const row of value.queueEvidence) {
    if (!isRecord(row) || Object.keys(row).some((key) => !['arr', 'ref', 'stableRef', 'title', 'status', 'trackedStatus', 'trackedState', 'serviceId', 'episodeId', 'seasonNumber'].includes(key)) || (row.arr !== 'sonarr' && row.arr !== 'radarr') || (row.ref !== null && typeof row.ref !== 'string') || typeof row.stableRef !== 'boolean' || (row.title !== null && typeof row.title !== 'string') || (row.status !== null && typeof row.status !== 'string') || (row.trackedStatus !== null && typeof row.trackedStatus !== 'string') || (row.trackedState !== null && typeof row.trackedState !== 'string') || (row.serviceId !== null && !Number.isSafeInteger(row.serviceId)) || (row.episodeId !== null && !Number.isSafeInteger(row.episodeId)) || (row.seasonNumber !== null && !Number.isSafeInteger(row.seasonNumber))) throw new Error('Invalid operator queue evidence');
    if ((row.ref === null) !== (row.stableRef === false)) throw new Error('Queue reference stability flag does not match its reference');
  }
  if (value.associationEvidence !== undefined) {
    const evidence = value.associationEvidence;
    if (!isRecord(evidence) || Object.keys(evidence).some((key) => !['arr', 'sourceJobKey', 'materialSignature', 'contextSignature', 'promptVersion', 'queueRefs', 'mediaReferences', 'workReferences'].includes(key)) || (evidence.arr !== 'sonarr' && evidence.arr !== 'radarr') || typeof evidence.sourceJobKey !== 'string' || !evidence.sourceJobKey || typeof evidence.materialSignature !== 'string' || !evidence.materialSignature || typeof evidence.contextSignature !== 'string' || !evidence.contextSignature || typeof evidence.promptVersion !== 'string' || !evidence.promptVersion || !Array.isArray(evidence.queueRefs) || evidence.queueRefs.length !== 1 || !evidence.queueRefs.every((ref) => typeof ref === 'string' && ref.length > 0) || !Array.isArray(evidence.mediaReferences) || evidence.mediaReferences.length > 100 || !Array.isArray(evidence.workReferences) || evidence.workReferences.length > 500) throw new Error('Invalid operator association evidence');
    if (evidence.mediaReferences.some((ref) => !isRecord(ref) || Object.keys(ref).some((key) => !['arr', 'serviceId', 'externalId'].includes(key)) || ref.arr !== evidence.arr || !Number.isSafeInteger(ref.serviceId) || (ref.serviceId as number) < 0 || !Number.isSafeInteger(ref.externalId) || (ref.externalId as number) < 0) || evidence.workReferences.some((ref) => !isRecord(ref) || Object.keys(ref).some((key) => !['workKey', 'arr', 'serviceId', 'externalId', 'seasonNumber'].includes(key)) || typeof ref.workKey !== 'string' || !ref.workKey || ref.arr !== evidence.arr || !Number.isSafeInteger(ref.serviceId) || !Number.isSafeInteger(ref.externalId) || (ref.seasonNumber !== null && (!Number.isSafeInteger(ref.seasonNumber) || (ref.seasonNumber as number) < 0)))) throw new Error('Invalid prepared association lookup');
  }
  if (Buffer.byteLength(stableJson(value), 'utf8') > 4_000_000) throw new Error('Operator evidence exceeds safe storage bound');
}

function validateOperatorNote(value: unknown): asserts value is string {
  if (typeof value !== 'string' || value.trim().length < 3 || value.length > 500 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)) throw new Error('Operator note must be 3-500 printable characters');
}

function captureTargetIds(capture: IntentCoverage, work: WorkItem | null): number[] {
  return capture.episodeIds ?? (work?.unit.kind === 'movie' ? [work.unit.serviceId] : []);
}

function sameIds(left: number[], right: number[]): boolean {
  const sortedLeft = [...left].sort((a, b) => a - b);
  const sortedRight = [...right].sort((a, b) => a - b);
  return sortedLeft.length === sortedRight.length && sortedLeft.every((id, index) => id === sortedRight[index]);
}

function sameOperatorEvidence(left: OperatorObservation, right: OperatorObservation): boolean {
  const withoutTimes = (value: OperatorObservation) => ({ ...value, readStartedAt: '', readCompletedAt: '' });
  return stableJson(withoutTimes(left)) === stableJson(withoutTimes(right));
}

/** A unit claim older than this is stale (dead process), not in-flight. */
const CLAIM_TTL_MS = 15 * 60_000;
