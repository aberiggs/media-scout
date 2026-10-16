# Progress

## Continuous implementation instruction

The user rejected self-imposed execution-budget stops. Global Dev guidance now
explicitly treats local checkpoints as recovery points, not stopping points;
continue the remaining approved tasks through completion or a genuine blocker.
Earlier budget-stop notes below are historical and superseded, not an active
permission/continuation requirement. Application query caps remain unchanged.

## Bounded acquisition execution

- Implemented executable episode-first / pack-first-plus-fallback stages with shared plan validation, exact local episode attribution, six-query/three-physical-release limits, oldest-unattempted fairness, and persisted capacity deferral. A pack miss alone no longer assigns all episodes an availability delay; only explicit episode searches or selected pack captures advance episode attempt clocks. Unattempted siblings and whole deferred seasons remain ready.
- All choices remain provisional until both stages finish. Cross-stage full advertised footprints and physical identities are checked, the final authorized ID subset cannot widen at pre-grab refresh, and live submissions retain individual claim/reservation/receipt checks. A partial primary followed by fallback now has an actual three-POST isolated replay with three exact reservations.
- Red: initial seven staged tests all failed under the single-batch runner. Expanded to 22 passing cases covering absent/rejected/full/manual/partial packs, query and selection caps, restart fairness, sibling-season remapping/manual holds, invalid attribution, rate-limit interruption with a provisional primary, overlapping and same-physical claims, in-flight eligibility/season discovery, and import/unmonitor/identity/numbering/unknown-read changes before POST.
- Initial broader run exposed 70 fixture/contract failures because scripted planners lacked the now-required episode attribution. Updated five scripted model seams to emit actual stage-local attribution. Remaining failures were an obsolete stdio schema-name stub, a partial-coverage test lacking its newly required residual fallback response, and omitted safe work-key logging in the consolidated failure path; fixed without dropping safety assertions.
- Independent read-only acquisition review found no blocking issues. Addressed its additional live partial-selection and multi-season verification gaps with passing tests. `npm test -- tests/staged-acquisition.test.ts tests/group-coverage.test.ts tests/guardrails.test.ts tests/queue-intent-linking.test.ts tests/gate2-runtime-regressions.test.ts tests/runner.test.ts tests/group-planning.test.ts tests/review-policy.test.ts tests/issue-11-episode-lifecycle.test.ts`: 9 files, 247 passed. `npm run typecheck`: passed. `npm test`: 47 files, 758 passed.
- Tasks 2.3, 3.2, 3.3 complete; progress 10/17. Continuing with stage diagnostics and episode progress projections/UI, then final acceptance and container verification. This is a recovery checkpoint, not a stopping point or approval gate.

## Stage diagnostics (task 3.4)

- Added optional bounded, allowlisted activity scope with primary/fallback stage and exact season/episode-number attribution. Additive migration retains legacy activity rows without scope. A capacity-deferral event explicitly states no query executed, carries unknown result count and the deferred count, and never changes episode attempt clocks or paid-search counters.
- Two initial staged diagnostics assertions failed on missing scope before implementation. Tests now cover real failed fallback attribution, six-query plus separate no-query deferral history, legacy schema upgrade/idempotent reads, privacy rejection, and bounds (20 work references/100 numbers per reference with full episode count retained). Raw release/queue payloads are not recorded.
- `npm test -- tests/staged-acquisition.test.ts tests/operations-state.test.ts tests/operations-api.test.ts tests/runner.test.ts`: 4 files, 132 passed. `npm run typecheck`: passed. `npm test`: 47 files, 760 passed. Independent read-only diagnostic review: no blocking findings; added explicit reference-cap assertion from its verification note.
- Progress 11/17; continuing directly into episode progress API/MCP/UI work.

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

## Guarded legacy recovery and operator scheduling

- Safe unlinked legacy TV availability reviews now become resolved history under a live claim and fresh matching library/queue evidence, with finite episode retry deadlines. Existing later deadlines, actual search times, file facts, and all reservation/dedupe/audit evidence are preserved; conversion is not an import or a fabricated search.
- Initial safe-conversion replay failed on the old review remaining open. Linked/configuration/exact-coverage/unscoped-queue/unknown-source/unknown-queue/stale-library/identity-changed variants now explicitly retain the hold. A populated pending reservation and linked review are checked byte-for-byte, as is protected SQL history across successful conversion.
- Review found a simultaneous ambiguous queue could hide behind ordinary manual-review and be bypassed by conversion. The new unscoped-queue replay reproduced the lost review; fixed both runner guard and persistence priority so safety ambiguity overrides an ordinary review and both reviews survive. Reviewer follow-up found no remaining concrete blocker for the increment.
- Retry/Reset now clear only the current TV identity's episode scheduling fields inside the existing guarded transaction. Retry preserves actual attempt times; Reset clears them, retaining observations, history, and reservations. Parent corrected the worker's initially invalid action fixture, then observed the two intended missing-clock-clear assertion failures before implementation. Foreign owner, missing group lease, unknown coverage, historical-identity preservation, and manual future-airtime checks pass.
- Assigned action/claim/operator/MCP and legacy-related suites: 11 files, 215 tests passed before the final additional safety assertions. Final `npm test`: 46 files, 723 passed. `npm run typecheck`, `npm --prefix web run typecheck`, `npm --prefix web test` (36 passed), `npm run build`, and `git diff --check`: passed.
- Progress: 6/17 tasks complete. Task 2.3 remains unchecked for staged budget-deferral verification; grouped acquisition stages, stage diagnostics, episode visibility/UI, final acceptance matrix, and container checks remain unfinished. No production read, live search, deployment, or push.

## Lifecycle-aware planning contracts (task 3.1)

- Added optional explicit pack/batch versus episode-stage intent, normalized episode timing/basis and progress, conservative season lifecycle evidence, and exact episode-index attribution validation. Future and timing-unknown episodes no longer inflate actual download-held counts. The runner's automatic staged fallback is NOT wired yet (task 3.2 remains unchecked).
- Red evidence: new attribution initially failed schema parsing, and future/unknown episodes were incorrectly counted as two download holds. Reviewer then found optional JSON properties incompatible with strict providers; two boundary regressions failed before separating the unchanged default/pack schema from a required-attribution episode-stage schema. No live provider request was made.
- Added duplicate/orphan/missing/invented episode-attribution rejection, unknown-source counts, scheduled-only/date-only timing, ended-series positive evidence, mid-season non-completion, unknown timing, and season-statistics future-evidence cases.
- Full-suite discovery found 16 context-stage failures from the old review-policy fixture omitting required parsed Series fields (`seasons`, `titleSlug`). Corrected that synthetic fixture to mirror the actual client boundary instead of weakening production parsing; all failures then cleared.
- `npm test -- tests/group-contracts.test.ts tests/group-planning.test.ts tests/planner.test.ts`: 3 files, 50 passed. `npm test`: 46 files, 736 passed. `npm run typecheck`, `npm --prefix web run typecheck`, `npm --prefix web test` (36 passed), `npm run build`, and `git diff --check`: passed. Independent review follow-up: no blocking findings for this increment.
- `docker buildx build --platform linux/amd64 --load -f docker/Dockerfile -t media-scout:issue-11-local .`: passed on the current application source. CI-equivalent SQLite native-addon smoke using `docker run --rm --network none --platform linux/amd64 --entrypoint node ...`: passed. No daemon, production volume, or network was used by the smoke container. No image published.
- ARM64 blocker: `docker buildx inspect` advertises linux/amd64 (and x86 variants/386) only, not linux/arm64. ARM64 build/native-addon smoke has NOT passed and task 5.3 remains unchecked; no privileged emulation setup was installed automatically.
- Execution-budget checkpoint: 7/17 tasks complete, with verified local commits. Remaining approved implementation resumes at task 3.2 (bounded/fair staged acquisition), then finishes task 2.3 budget-deferred attribution, tasks 3.3–3.4, 4.1–4.2, and final integration/review checks. No new product approval is required to resume. The feature is not complete; the current UI has not gained episode detail and fallback is not yet guaranteed.
