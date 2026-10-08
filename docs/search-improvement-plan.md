# General search improvement plan

**Status:** Approved Phase 1–3 work is implemented. Phase 1/2 gates passed; Phase 3 was accepted by the parent after focused verification at the user's expressly authorized narrow scope adjustment (unauthenticated first-run continuation guard and JSON/NDJSON tests). This is not an unconditional Oracle Gate 3 pass. Retrieval quality is not proven. See the [verification record](search-improvement-verification.md) and [issue log](search-improvement-issues.md). The older [rewrite verification record](general-search-rewrite-verification.md) remains historical and is not overwritten.

## Product direction and interaction

General search is search-first and results-focused, with optional refinement rather than a transcript-centric chatbot. The current web interface uses one auto-growing search input, a canonical progress area, Stop/New search controls, and advanced settings in a labeled **Search settings** disclosure (not a gear). The saved search prompt remains user-authored and search-specific. Do not persist transcripts or add new lifecycle semantics by implication. Explicit review, routing/protocol checks, expiry, and uncertain-submission safeguards remain separate from search progress.

Progress is a current status, not an accumulating transcript. Query proposals keep the catalog `query` separate from their short public `purpose`; do not expose hidden reasoning. Provisional results are not final; incomplete-run partials are nonselectable. Event `runId` and `stageId` are optional additive fields for legacy tolerance, with monotonically sequenced events in a run. Cancellation of a search does not prove rollback of any upstream operation and does not alter independent submission reconciliation.

## Implemented planning and retrieval contract

The structured planner schema in `src/core/search-planning.ts` describes focus (`unique-title`, `head-entity`, `category`, `mood`, `mixed`), identity anchors, medium/provenance, positive and negative hard/soft constraints, and expansion scope. A plan chooses search or clarification and can return at most five proposals; each proposal has separate query, public purpose, branch, strategy, and preserved anchors. Query values are validated, bounded to 300 characters, normalized, conservatively deduplicated, and checked for identity preservation. Non-identity-preserving queries over 80 characters are rejected. Do not describe this as an 80-character universal limit.

The service performs bounded iterative retrieval based on sanitized results and a search ledger, curates candidate batches, reassesses when intent changes, and preserves safety/expiry behavior. Budget ceilings and a 120-second overall run deadline are enforced. Search failure can include incomplete diagnostics and safe partial findings; partials remain nonselectable. The optional user-authored 16,000-character search prompt supplements planner/curator system messages, including the legacy planner; it does not guarantee provider acceptance or retrieval quality. There is no ordinary/direct-search fallback or automatic model switch.

## Phase status

| Phase | Scope | Status |
| --- | --- | --- |
| 1 | Validated intent/query contract, user-authored prompt scope, typed failures | Implemented; Gate 1 passed at `9c8ad2f`. |
| 2 | Bounded ledger-driven iteration, refinement/reassessment, candidate and snapshot safety | Implemented; Gate 2 passed at `02d5235`. |
| 3 | Search lifecycle cancellation, progress metadata, search-first web presentation | Implemented and automated-checked; parent accepted after focused verification of the user-authorized narrow unauthenticated-first-run continuation fix. Not an unconditional Oracle Gate 3 pass; no visual review claim. |
| 4 | Capability-aware retrieval and refinement beyond existing turn bounds | Deferred. Needs separate approval and representative deployed-source evidence. |

## Not established / future evaluation

Do not claim that all empty-result causes are identified, provider refusals are resolved, or retrieval precision/recall/performance has improved from automated orchestration tests. Source inventory is still reported as not available; diagnostics do expose observed retrieval/filter/assessment/budget/deadline counts. Per-request lower budget overrides are implemented. Optional depth/breadth presets, indexer capability selection, Torznab-specific syntax, unlimited/longer turns, query-level source selection, and live quality benchmarking remain future work. Existing bounded turns remain. No direct-search fallback, automatic model change, transcript persistence, or action lifecycle redesign is proposed here.

Before any future retrieval change, evaluate neutral fixtures for exact-title/year and head-entity preservation, category coverage, Unicode names, exclusions, ambiguity, and refinement. Compare semantic quality separately from orchestration correctness. Any live evaluation requires explicit authorization and must be read-only; no grabs.
