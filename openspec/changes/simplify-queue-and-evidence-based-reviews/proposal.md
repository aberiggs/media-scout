# Proposal

## Why

Queue and Reviews mix release timing with unexplained safety holds and offer recovery controls that cannot complete. [Issue #20](https://github.com/aberiggs/media-scout/issues/20) tracks a calmer, evidence-based workflow. The user approved implementation after confirming metadata-gated waiting and a simple reset that preserves download safety.

## What Changes

- Make Queue active-only in the UI, including waiting work but excluding fulfilled/inactive history. Reduce default rows to title/type, meaningful status, next retry or availability time when known, and last checked; move diagnostics to details.
- Show one Reviews item per movie/season, retaining every underlying cause and history record. Group before pagination/counting, and make action scope explicit.
- Separate availability from safety in projections and wording. Availability alone must not generate review; an independent unresolved download or identity risk still takes precedence.
- Keep unreleased movies waiting on Radarr's `isAvailable` metadata, with no release searches or retry deadline. Only released movies whose searches find no admitted candidates use the existing finite retry window. Preserve TV airtime eligibility, existing cadence defaults and identity holds.
- Persist versioned private causal evidence for new reviews, expose concise safe explanations, and resolve only demonstrably obsolete causes on fresh identity-matched reconciliation.
- Hide inapplicable controls, distinguish actions needing a fresh assessment from executable actions, and put niche recovery behind Advanced recovery. Keep refresh distinct from retry and never label reset as deletion.
- Provide a simple confirmed **Reset item** action: clear current scheduling and unlinked reviews, preserve history, reservations, receipts, queue coverage and dedupe protection, and rebuild from a later known library poll. Existing live download holds remain authoritative; reset never searches or cancels downloads.

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

No production edits, deployment, database wiping, direct download-client mutation, reservation release via reset, new retry defaults, anime query redesign (#15), or broader search-history redesign (#13). Related cadence context is in #12. Production data stays outside Git; no private source/export is sent to external services.

## Proposed implementation order

1. Add deterministic synthetic regressions for the observed combinations: unavailable movie plus old queue hold; movie zero results; multiple causes on one title; imported aired episodes plus future siblings and a queue hold. Preserve unknown-vs-empty semantics.
2. Add causal review evidence and conservative lifecycle handling. Test open-review deduplication and preserve legitimate recurrence after resolution. Implement ordinary movie availability retries and narrowly validated legacy availability conversion without clearing concurrent safety causes.
3. Correct operations projections and action applicability. Keep separate availability and safety facts, group review results before pagination, and provide allowlisted cause-specific explanations. Assess fresh evidence before presenting recovery choices; failures explain the missing prerequisite rather than claiming a generally executable action.
4. Simplify Queue and Reviews with the existing visual system, not a theme rewrite. Queue stays active-only; compact rows and expandable details. Reviews show one item with all causes and contextual next steps; advanced operations retain confirmation safeguards.
5. Implement the approved Reset item semantics, preserving active/uncertain download protections and linked reviews, owner-checked claims and audit history. Verify waiting items are rediscovered without searches until metadata makes them eligible.
6. Run focused backend/API/UI regressions, then all project typechecks/tests/build. Verify small-screen/keyboard flows and update operator docs. Non-doc implementation also requires CI container builds/native SQLite smoke evidence; a web build is not a substitute. No live model/indexer evaluation is needed.

## Approved decisions

Unreleased means wait for metadata, not paid retries. Released-but-not-found means ordinary retry, not review. Reset rebuilds Scout's local tracking on the next successful pull, does not cancel downloads and does not erase duplicate-download protection. The user explicitly approved implementation of this behavior, state-machine hardening and the partial UI redesign. The earlier elaborate legacy-review retirement ceremony is superseded by this simpler reset; genuinely releasing a download reservation remains a separate guarded operation.
