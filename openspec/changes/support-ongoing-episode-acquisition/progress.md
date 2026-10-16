# Progress

## Planning checkpoint

- Issue: https://github.com/aberiggs/media-scout/issues/11
- Source inspected: `bba07bc2a7ba206d6680f50069a9c07f98c9493e`.
- State: proposal/specs/design/tasks prepared; implementation has not started. The project requires a new apply request after artifact presentation.
- Preserve the pre-existing untracked `docs/sprocket-feedback.md`; it is not part of this change.
- Investigation evidence: synthetic same-date replay selected an episode at 00:01 UTC despite a supplied 23:00 UTC airtime, because parsing discarded `airDateUtc`. Reconciliation replay confirmed normal E1-import/E2-airtime progression, a blocking season availability review suppressing E2, healthy exact E1 coverage leaving E2 eligible, and vanished coverage retaining a season queue-review hold.
- Earlier investigation checks: 218 tests passed across watcher/work-queue/group-planning/runner/operations-api and sonarr-client/types/review-policy/group-coverage/queue-intent-linking. These establish the inspected baseline only; they are not evidence that the proposed behavior is implemented.
- No production access, daemon, live indexer/model calls, application edits, deployment, or push is authorized by this planning checkpoint.

## Planning validation

- `openspec validate support-ongoing-episode-acquisition --strict`: passed.
- `git diff --cached --check`: passed for the eight explicitly staged planning files; unrelated feedback remains untracked and unstaged.
- `openspec status --change support-ongoing-episode-acquisition`: 4/4 planning artifacts complete.
- `openspec instructions apply --change support-ongoing-episode-acquisition --json`: ready, 0/17 implementation tasks complete. Reading readiness is not starting apply or authorizing code edits.
- Independent read-only plan review: no blocking/material findings. The reviewer assessed the supplied issue summary; the parent read the full issue through `gh issue view 11 --repo aberiggs/media-scout --json title,body,comments` and mapped its broader monitoring/unknown-read/identity/in-flight acceptance matrix to task 5.1 and the lifecycle specs.
- Planning changes only; no software tests rerun or new regression tests written during proposal creation. Implementation red/green evidence and actual software checks remain required during apply.
- Explicit review defaults: date-only fallback at the following UTC day; existing configured retry window; backlog threshold of three due episodes; cap of six queries and three physical selections per group pass.

## Apply started and workflow correction

- User explicitly approved apply and requested removal of the redundant approval gate. Using change `support-ongoing-episode-acquisition` (spec-driven), initially 0/17 tasks complete.
- Updated local OpenSpec proposal skill/command copies, dev routing, provenance/setup guide, and this project's AGENTS/OpenSpec context: explicit implementation approval carries through missing artifact creation; investigation/proposal-only requests still stop, and material scope decisions remain gated. Upstream generator fixture is not edited.
- Read-only reviewer pressure-tested investigation-only, proposal-only, explicit implementation with missing artifacts, new material scope, and missing/unresolved project-root cases. No blocking findings; corrected its minor stale symlink provenance finding. Publication remains prohibited by the controlling session instructions despite project automatic-push wording; local checkpoints only.
- Global configuration changes are outside this repository and are not copied into its commits. Project workflow correction is a separate checkpoint before application changes.

## Timing increment (task 1.2; task 1.1 still partial)

- Added shared strict UTC/calendar eligibility normalization and optional Sonarr timing/lifecycle fields, including seasonal airing statistics at their actual nested API location. Precise time wins; date-only eligibility is the following UTC midnight; invalid/absent timing does not authorize work.
- Red evidence: worker watcher regression selected the same-day 23:00 episode at 00:01 before the fix. Parent helper tests then failed twice for rolled-over `2026-02-30T23:00:00Z` and date-only `2026-10-15Z` masquerading as timestamps; strict timestamp validation fixed both. Parent schema test failed for discarded nested season statistics before correcting their parsed location.
- Added real isolated SQLite/Runner replay through E1 discovery, queue, positive import, database close/reopen, E2 just before/exactly at airtime, and query/target attribution. No live client/model calls or grabs.
- `npm test -- tests/episode-timing.test.ts tests/types.test.ts tests/sonarr-client.test.ts tests/watcher.test.ts tests/issue-11-episode-lifecycle.test.ts`: 5 files, 43 tests passed.
- `npm run typecheck`: passed. `npm test`: 45 files, 686 tests passed. `git diff --check`: passed. Independent read-only timing review: no blocking findings.
- Task 1.1 remains unchecked: the persisted empty-search blocking reproduction and independent retry behavior are still to be added. No claim that all episode lifecycle behavior is fixed. Container/architecture checks remain pending for the integrated implementation.

## Episode persistence and independent availability retries

- Completed the missing task 1.1 empty-search reproductions: two persisted Runner tests failed on an unexpected `no-suitable-release` review and E2 never becoming searchable. Both now pass, with distinct E1/E2 deadlines retained across actual database close/reopen.
- Added additive, claim-checked episode persistence and transactional reconciliation. Eleven State tests cover old-schema/idempotent initialization, real file reopen, foreign/expired owners, invalid-batch rollback, stale observations, missing inventory, identity changes, ineligible episodes, and preserved nonempty review/decision/dedupe/intent history. Parent red tests found aggregate rollback from stale observations and eligibility of historical rows absent from the current observation; both fixed.
- Runner persists full observations for tracked seasons, records successful query attempts at episode granularity, and schedules ordinary TV misses as finite availability retries. Season/series coordination, positive-file completion, queue/intent holds, and movie empty-search policy remain intact. Legacy ordinary review conversion is not yet implemented (task 2.4 remains unchecked).
- First independent review identified sibling operational failure bypassing E1's availability timer. Four additional persisted restart regressions (planner/picker × ordinary/quota failure) reproduced E1 being prematurely re-added. Removed the aggregate bypass and finalized only the current attempt's scoped episode clocks transactionally with its result/backoff. Reviewer follow-up found no remaining concrete blocking issue for this increment.
- The replay suite now has 11 cases, including source/per-series/queue unknown reads, healthy exact E1 coverage allowing E2, and vanished E1 coverage conservatively retaining the review hold.
- `npm test -- tests/episode-progress-state.test.ts tests/work-queue-state.test.ts tests/group-state.test.ts tests/operator-state.test.ts`: 46 passed; `npm test -- tests/episode-progress-state.test.ts tests/issue-11-episode-lifecycle.test.ts tests/work-queue.test.ts tests/group-state.test.ts tests/operator-state.test.ts tests/review-policy.test.ts tests/runner.test.ts`: 178 passed after review fixes and additional history assertions.
- `npm test`: 46 files, 707 passed. `npm run typecheck`, `npm --prefix web run typecheck`, `npm --prefix web test` (36 passed), `npm run build`, and `git diff --check`: passed. These are increment evidence, not completion of deferred stage/UI/legacy tasks or container checks.
- Implementation progress: 4/17 tasks complete. Task 2.3's availability behavior is implemented, but its checkbox remains unchecked until budget-deferred-target behavior is verified with staged acquisition. Next is guarded legacy availability-review conversion, followed by action adaptation, structured bounded fallback, progress projections/UI, and final integration/container verification. No deployment, live search, production read, or push.
