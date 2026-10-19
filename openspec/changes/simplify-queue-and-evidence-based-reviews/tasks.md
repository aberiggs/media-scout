# Tasks

## 1. Metadata and ordinary availability

- [x] 1.1 Add red/green released-movie empty-search and unavailable-to-available regressions; implement persisted ordinary cooldown only for released movies and conservative legacy movie availability conversion. Verify watcher, review-policy and runner focused tests plus backend typecheck; update operations cadence documentation.

## 2. Queue review lifecycle and reset

- [x] 2.1 Capture versioned queue-review cause/scope evidence with additive migration, dedupe and positive-import cleanup; add regressions for imported targets with future siblings and unknown/stale/identity-change/legacy cases. Verify focused runner, work-queue and review-state tests plus migration/reopen coverage; document lifecycle rules.
- [x] 2.2 Implement confirmed Reset item using current work action route, clear unlinked reviews/scheduling but preserve linked reviews, coverage, reservations, dedupe and audit. Remove review-visibility-based coverage discharge and guard reset pending until later known reads. Verify state/API/reconciliation regressions for reset, claims, provider limits, cross-origin/cycle/opt-out gates and rediscovery; update recovery docs.

## 3. Operations projections and UI

- [x] 3.1 Add opt-in grouped review projections before paging, grouped counts, all underlying causes/IDs, media-correct status/availability and contextual action eligibility. Verify operations API tests for grouping, pagination, opt-out, private evidence redaction and unknown legacy causes; document API behavior.
- [ ] 3.2 Redesign Queue/Reviews hierarchy: active-only scope, concise rows, expandable diagnostics, one card per review item, plain labels, confirmed Reset item and advanced guarded recovery. Add red/green UI tests and verify frontend typecheck/test/build plus rendered narrow-screen and keyboard review; update dashboard docs.

## 4. Integration and publication

- [ ] 4.1 Run `npm run typecheck`, `npm test`, `npm --prefix web run typecheck`, `npm --prefix web test`, `npm run build`, `git diff --check` and strict OpenSpec validation; review the full diff independently, fix regressions and record actual results in progress.md. Verify synthetic offline evidence only; no live evaluation, production mutation or deployment.
- [ ] 4.2 Publish verified checkpoints and update PR #21 with behavior/check evidence; inspect remote CI including amd64/arm64 container/native-SQLite smoke results and record exact pending/failing blockers rather than claiming unrun checks passed.

## Workflow follow-up

- Archive only when requested after review; do not merge PR or deploy automatically.
