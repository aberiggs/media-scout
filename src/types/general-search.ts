export interface GeneralSearchRequest { query: string }
export interface GeneralSearchSpace { focus: 'unique-title' | 'head-entity' | 'category' | 'mood' | 'mixed'; identityAnchors: string[]; alternativeAnchors: string[]; referenceEntities: string[]; medium: { value: string | null; provenance: 'explicit' | 'context' | 'assumption' | 'unknown' }; positives: Array<{ text: string; strength: 'hard' | 'soft' }>; negatives: Array<{ text: string; strength: 'hard' | 'soft' }>; expansionScope: 'identity-preserving' | 'subcategories' | 'associations' }
export interface GeneralSearchProposal { query: string; purpose: string; branch: string; strategy: 'identity-preserving' | 'subcategory' | 'association'; preserves: string[] }
export interface GeneralSearchInterpretation { searchSpace: GeneralSearchSpace; proposals: GeneralSearchProposal[] }
export interface GeneralRelease {
  releaseId: string; title: string; indexer: string; size: number | null; seeders: number | null;
  leechers: number | null; age: number; protocol: 'unknown' | 'usenet' | 'torrent';
  selectable: boolean; unavailableReason: string | null;
}
export interface GeneralSearchResponse {
  status: 'clarification-needed' | 'selection-required'; query: string; queries: string[];
  question: string; searchId: string | null; expiresAt: string | null; confirmationToken: string | null;
  releases: GeneralRelease[]; destination: { name: string; protocol: 'usenet' | 'torrent' } | null;
  searchInterpretation?: GeneralSearchInterpretation;
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
  /** Assessment is constraint-versioned; rejected relevance is reversible on later refinement. */
  assessment?: { status: 'match' | 'possible-match' | 'rejected' | 'unassessed'; constraintVersion: string };
}
export type GeneralSearchStopReason = 'sufficient-results' | 'no-novelty' | 'low-yield' | 'budget-exhausted' | 'deadline' | 'proposals-exhausted' | 'completed' | 'provider-refusal' | 'source-failure';
export interface GeneralSearchDiagnostics {
  complete: boolean;
  stopReason: GeneralSearchStopReason;
  /** Aggregate Prowlarr search does not report an authoritative enabled-source inventory. */
  sourceInventory: 'not-reported';
  ledger: { raw: number; added: number; duplicates: number; reactivated: number; reassessed: number; filtered: Record<string, number>; assessed: { match: number; possible: number; unrelated: number; unassessed: number }; outcomes: Array<{ query: string; outcome: 'success' | 'failed'; raw: number; added: number }> };
}
export interface GeneralSearchConversationResponse extends Omit<GeneralSearchResponse, 'releases'> {
  releases: GeneralConversationRelease[];
  /** Search and query history belongs to this sanitized snapshot, not a persisted transcript. */
  diagnostics?: GeneralSearchDiagnostics;
}

export type GeneralSearchProgressEvent =
  | { type: 'planning'; sequence: number; runId?: string; stageId?: string; message?: string }
  | { type: 'queries'; sequence: number; runId?: string; stageId?: string; queries: string[]; searchInterpretation?: GeneralSearchInterpretation }
  | { type: 'searching'; sequence: number; runId?: string; stageId?: string; query: string; index: number; total: number }
  | { type: 'results'; sequence: number; runId?: string; stageId?: string; releases: GeneralConversationRelease[]; provisional?: true }
  | { type: 'curation'; sequence: number; runId?: string; stageId?: string; processed: number; total: number }
  | { type: 'complete'; sequence: number; runId?: string; stageId?: string; response: GeneralSearchConversationResponse }
  | { type: 'error'; sequence: number; runId?: string; stageId?: string; code: string; message: string; partialReleases?: GeneralConversationRelease[]; diagnostics?: GeneralSearchDiagnostics };

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
