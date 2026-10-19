# Proposal

## Why

Queue and Reviews mix release timing with unexplained safety holds and offer recovery controls that cannot complete. [Issue #20](https://github.com/aberiggs/media-scout/issues/20) tracks a calmer, evidence-based workflow; this is a proposal, not implementation approval.

## What Changes

- Make Queue active-only in the UI, including waiting work but excluding fulfilled/inactive history. Reduce default rows to title/type, meaningful status, next retry or availability time when known, and last checked; move diagnostics to details.
- Show one Reviews item per movie/season, retaining every underlying cause and history record. Group before pagination/counting, and make action scope explicit.
- Separate availability from safety in projections and wording. Availability alone must not generate review; an independent unresolved download or identity risk still takes precedence.
- Give ordinary movie empty/no-admitted-candidate searches a finite automatic retry using the existing configured retry window, like TV availability handling. Do not change cadence defaults or erase identity holds.
- Persist versioned private causal evidence for new reviews, expose concise safe explanations, and resolve only demonstrably obsolete causes on fresh identity-matched reconciliation.
- Hide inapplicable controls, distinguish actions needing a fresh assessment from executable actions, and put niche recovery behind Advanced recovery. Keep refresh distinct from retry and never label reset as deletion.
- Present a separate guarded legacy-review recovery option for product approval before including it in implementation. Without this option, truly unlinked, evidence-poor historical safety reviews may remain blocked; a UI-only fix cannot safely clear them.

## Capabilities

### New Capabilities

- `review-lifecycle`: Evidence-backed review creation, availability retries, conservative resolution and history preservation.
- `operations-workflow`: Active Queue, grouped Reviews, concise projections and truthful contextual actions.

### Modified Capabilities

None. `openspec list --specs` reports no baseline specs; the ongoing-episode change remains separate.

## Impact

Backend: `watcher.ts`, `work-queue.ts`, `runner.ts`, `state.ts`, `operations.ts`, `operator-actions.ts` and HTTP operations routes as required. Frontend: `web/src/Operations.tsx`, scoped styles and UI tests. Additive persistence/API changes require migrations and compatibility tests. Existing low-level history APIs can remain available; removing the All work control does not require deleting stored history.

### Evidence and limits

A consistent read-only SQLite backup confirms four open records across three titles. The Odyssey has an unlinked queue review despite waiting for release and no recorded search or intent. CODA has zero-result availability and later queue reviews. Blue Box has a queue review although its three currently aired episodes are imported and the remaining nine are future-dated. None of the queue reviews captured causal details; historical triggering observations are unavailable. These facts confirm contradictory/dead-end presentation and persistent unresolved reviews; their continuing safety relevance is unknown. The deployed revision is `ab3e32b`, whose app source matches latest main at this investigation.

Source confirms broad unknown-scope queue holds, sticky unresolved reviews, movie-only empty-search manual holds, generic media-inaccurate copy and optimistic association availability. Runtime replay must use synthetic sanitized fixtures; do not start the app with production state.

### Non-goals

No production edits, deployment, blanket dismissal, database clearing, direct download-client mutation, new retry defaults, anime query redesign (#15), or broader search-history redesign (#13). Related cadence context is in #12. Production data stays outside Git; no private source/export is sent to external services.

## Proposed implementation order

1. Add deterministic synthetic regressions for the observed combinations: unavailable movie plus old queue hold; movie zero results; multiple causes on one title; imported aired episodes plus future siblings and a queue hold. Preserve unknown-vs-empty semantics.
2. Add causal review evidence and conservative lifecycle handling. Test open-review deduplication and preserve legitimate recurrence after resolution. Implement ordinary movie availability retries and narrowly validated legacy availability conversion without clearing concurrent safety causes.
3. Correct operations projections and action applicability. Keep separate availability and safety facts, group review results before pagination, and provide allowlisted cause-specific explanations. Assess fresh evidence before presenting recovery choices; failures explain the missing prerequisite rather than claiming a generally executable action.
4. Simplify Queue and Reviews with the existing visual system, not a theme rewrite. Queue stays active-only; compact rows and expandable details. Reviews show one item with all causes and contextual next steps; advanced operations retain confirmation safeguards.
5. If separately approved below, add guarded audited legacy queue-review recovery. Otherwise explicitly document remaining blocked legacy cases instead of claiming the reported dead ends fully fixed.
6. Run focused backend/API/UI regressions, then all project typechecks/tests/build. Verify small-screen/keyboard flows and update operator docs. Non-doc implementation also requires CI container builds/native SQLite smoke evidence; a web build is not a substitute. No live model/indexer evaluation is needed.

## Decisions requested before completing design/specs/tasks

1. **Ordinary no-release outcome:** recommend automatic retry for movies at the existing configured retry window, not manual review. This is a product-policy change from documented movie behavior, not merely a wording fix.
2. **Old evidence-poor safety reviews:** recommend a separate Advanced recovery action, working label **Clear old review**, with preview and explicit download-client inspection acknowledgement. It resolves selected legacy unlinked reviews only; it does not delete database history, make a search immediate, or release an actual reservation. Require fresh complete identity-matched reads, no unresolved reservation/retained coverage/possible queue conflict/concurrent safety hold, claims, expiring one-use confirmation and immutable audit. If evidence or inspection cannot establish safety, keep held. The alternative is no new recovery mutation and honest guidance that some old reviews cannot be cleared in-app.

Design/specs/tasks intentionally wait for these material decisions. Approval of the proposal must explicitly settle the legacy-recovery option; do not infer authorization to discard uncertain download evidence from a request for simpler labels.
