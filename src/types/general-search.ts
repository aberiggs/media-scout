export interface GeneralSearchRequest { query: string }
export interface GeneralRelease {
  releaseId: string; title: string; indexer: string; size: number | null; seeders: number | null;
  leechers: number | null; age: number; protocol: 'unknown' | 'usenet' | 'torrent';
  selectable: boolean; unavailableReason: string | null;
}
export interface GeneralSearchResponse {
  status: 'clarification-needed' | 'selection-required'; query: string; queries: string[];
  question: string; searchId: string | null; expiresAt: string | null; confirmationToken: string | null;
  releases: GeneralRelease[]; destination: { name: string; protocol: 'usenet' | 'torrent' } | null;
  dryRun: boolean; actionsAllowed: boolean; blockedReason: string | null;
}
export interface GeneralGrabRequest { confirmationToken: string; releaseIds: string[]; confirmed: true }
export interface GeneralGrabResponse {
  searchId: string; dryRun: boolean;
  results: Array<{ releaseId: string; status: 'submitted' | 'dry-run' | 'submitting' | 'failed' | 'uncertain' | 'not-attempted'; code: string | null }>;
}

/** Additive conversational-search contract; legacy request/response types above stay stable. */
export type GeneralSearchAction = 'search' | 'follow-up' | 'find-more' | 'more-like-these' | 'other-terms';
export interface GeneralSearchTurn { role: 'user' | 'assistant'; content: string }
export interface GeneralSearchConversationRequest {
  originalQuery: string;
  /** Immutable caller-owned conversation context: original turn plus no more than five follow-ups. */
  turns: readonly GeneralSearchTurn[];
  action: GeneralSearchAction;
  previousSearchId?: string;
  confirmationToken?: string;
  selectedInspirationIds?: readonly string[];
  /** Optional per-request reductions/overrides, still clamped to configured hard limits. */
  budgets?: Partial<GeneralSearchBudgets>;
}
export interface GeneralReleaseRelevance {
  classification: 'match' | 'possible-match';
  explanation?: string;
}
export interface GeneralReleaseViability {
  viable: boolean;
  reason: 'viable' | 'zero-seeders' | 'stale' | 'unsafe' | 'incompatible' | 'unknown';
}
export interface GeneralConversationRelease extends GeneralRelease {
  relevance?: GeneralReleaseRelevance;
  viability?: GeneralReleaseViability;
  /** Preserve the original snapshot expiry when results accumulate; never extend on follow-up. */
  expiresAt: string;
}
export interface GeneralSearchConversationResponse extends Omit<GeneralSearchResponse, 'releases'> {
  releases: GeneralConversationRelease[];
  /** Search and query history belongs to this sanitized snapshot, not a persisted transcript. */
}

export type GeneralSearchProgressEvent =
  | { type: 'planning'; sequence: number; message?: string }
  | { type: 'queries'; sequence: number; queries: string[] }
  | { type: 'searching'; sequence: number; query: string; index: number; total: number }
  | { type: 'results'; sequence: number; releases: GeneralConversationRelease[] }
  | { type: 'curation'; sequence: number; processed: number; total: number }
  | { type: 'complete'; sequence: number; response: GeneralSearchConversationResponse }
  | { type: 'error'; sequence: number; code: string; message: string };

export interface GeneralSearchBudgets {
  queryCount: number;
  candidateCap: number;
  aiCalls: number;
  batchSize: number;
  displayLimit: number;
  hideZeroSeeders: boolean;
}
/** Canonical persisted settings names; all fields are optional for version-1 compatibility. */
export interface GeneralSearchSettings {
  maxQueries?: number;
  maxCandidates?: number;
  maxAiCalls?: number;
  batchSize?: number;
  displayLimit?: number;
  hideZeroSeeders?: boolean;
}

export interface GeneralSearchOperationCreateRequest {
  operationId: string; // client-generated UUID known before POST
  confirmationToken: string;
  releaseIds: string[]; // complete, frozen, unique manifest
  confirmed: true;
}
export type GeneralSearchOperationReleaseStatus =
  | 'pending' | 'submitting' | 'submitted' | 'previously-submitted' | 'dry-run'
  | 'failed' | 'uncertain' | 'not-attempted';
export interface GeneralSearchOperationReleaseResult {
  releaseId: string;
  status: GeneralSearchOperationReleaseStatus;
  code: string | null;
}
export interface GeneralSearchOperationStatus {
  operationId: string;
  releases: GeneralSearchOperationReleaseResult[];
  mode: 'live' | 'dry-run';
  destination: { name: string; protocol: 'usenet' | 'torrent' };
  expiresAt: string;
  nextOrdinal: number;
  stopped: boolean;
  complete: boolean;
}
export interface GeneralSearchOperationStepRequest { expectedOrdinal: number }
export interface GeneralSearchOperationStopResponse { operation: GeneralSearchOperationStatus }
