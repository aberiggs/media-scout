# Investigation and proposal progress

Issue: https://github.com/aberiggs/media-scout/issues/20

## State

Implementation approved after the user confirmed metadata-gated release waiting and a simple Reset item action that preserves downloads and duplicate-download protection. Planning artifacts now reflect that approval; task completion is tracked in tasks.md. The unrelated ongoing-episode change and untracked user feedback document are untouched.

## Evidence gathered

- Started `plan/queue-review-experience` from freshly fetched `origin/main` (`8261eca`). Production container reports app revision `ab3e32b`, also present on main; the newer main commit is a CI dependency bump.
- Read project instructions, operations, recovery and dashboard docs; read issues #12 and #13 using JSON output (default `gh issue view` failed due to deprecated Projects classic GraphQL fields).
- Used Python SQLite backup API through a read-only source connection on `zima`; transferred a consistent snapshot to a mode-0600 file in a mode-0700 directory outside the repo. Temporary remote backup removed. No daemon restart, settings readout, cycle, upstream API/model call or production mutation.
- Snapshot `PRAGMA quick_check`: `ok`. Projected only needed review/work/episode/intent fields; credentials and raw queue/release identifiers are not included here.
- Four open rows across three work items: Odyssey queue review (Oct 11), CODA zero-result review (Oct 15) plus queue review (Oct 17), Blue Box queue review (Oct 18). All queue reviews are unlinked with no causal details. Aired Blue Box inventory is imported; future inventory remains. Completion of a particular episode does not establish that an evidence-poor review only concerned that episode.
- Current association records have no cached decisions and failure counts of four. This corroborates limited current association evidence, but does not reconstruct historical queue rows or prove the original review triggers were incorrect.

## Source-confirmed findings

- `work-queue.ts:294–300,824–828`: unknown queue scope can conservatively hold other work on the same source; availability alone does not explain or override that safety condition.
- `work-queue.ts:809–833`: unresolved review keys and prior queue-review state persist; movie availability and review hold can be projected inconsistently. The final queue-review branch restores manual status for an explicit queue-review reason, so it is incorrect to attribute every waiting-release mismatch to the earlier movie branch alone.
- `work-queue.ts:324–340`: coverage is projected to current missing targets; imported coverage can disappear without clearing a historical review. Do not infer missing causal evidence from this projection.
- `runner.ts:873–883`: movie empty admitted candidates currently create manual review; TV has ordinary availability retry behavior.
- `runner.ts:1289–1300`, `state.ts:495–499,606–610`: ordinary dedupe compares unresolved work/reason/details, while linked dedupe also identifies the intent; same work can have multiple distinct open reasons. Resolved history is excluded by default and does not suppress recurrence.
- `operations.ts:104–124`: association advertised based on review reason alone, before current association evidence is known. Release requires an actual linked eligible intent. Retry/reset intentionally reject safety reviews.
- `web/src/Operations.tsx:217–239`: shared hold copy incorrectly calls movies seasons and offers generic blocked explanations.

## Specialist consultation

- Read-only code exploration traced lifecycle and recovery gates.
- Designer recommended retaining existing visual styling, reducing row hierarchy, active-only Queue, grouped Reviews and Advanced recovery; no implementation or visual verification performed.
- Architectural reviewer rejected blanket future-only dismissal and automatic cleanup based only on surviving coverage. Recommended structured causal evidence and a separately approved guarded legacy-review retirement path. These constraints are incorporated in the proposal.

## Checks

- `git diff` before branching: no tracked changes; user file `docs/sprocket-feedback.md` remains untracked and excluded.
- `openspec list --json` / `openspec context --json`: existing intended repo root confirmed; no initialization.
- `openspec list --specs`: no baseline specs. Created only the new proposal scaffold and investigation record.
- App tests/builds not run: no application code changed, and no implementation claims made.
- `git diff origin/main -- src web`: empty; no application source changed.
- Inspected the full proposal diff and investigation record; `git diff --no-index --check /dev/null .../progress.md`: clean. `git diff --cached --check`: passed. Staged path inspection includes only the new change's metadata, proposal and progress files.
- `openspec status --change simplify-queue-and-evidence-based-reviews`: 1/4 planning artifacts complete; specs/design/tasks intentionally await the material decisions, not ready for apply.
- Full change validation is not claimed while design/specs/tasks await product decisions.

## Draft review

Architectural reviewer inspected the actual two-document checkpoint. Corrected an initial exploration error about resolved-history dedupe by independently reading `listManualReview(includeResolved = false)`. Also removed language implying that evidence-poor reviews were proven obsolete. No sensitive-information exposure identified in the planning documents.

## Approved implementation

- User clarified unreleased movies must wait for Radarr metadata rather than paid retries. Existing `isAvailable` is the gate; released-but-not-found is distinct.
- User approved Reset item clearing local tracking/reviews for next-poll reconstruction while retaining downloads and duplicate-download protections. This supersedes the proposed elaborate legacy-retirement ceremony; reservation release remains separately guarded.
- Completed proposal, design, two capability specs and task checklist. Implementation continues through offline verification and PR publication; no production cleanup or deployment is authorized.
- Consulted official Radarr availability documentation through Context7: `isAvailable` reflects configured minimum availability, including release-date handling. No private data sent.

## Next action

Continue with queue-review evidence, independent held coverage and Reset item.

## Checkpoint 1 — availability

- Worker added a failing released-movie no-results regression, then ordinary cooldown. Parent completed legacy movie conversion and metadata transition coverage; existing TV conversion generalized without clearing concurrent reviews, intents or coverage.
- RED: legacy movie conversions returned false; unavailable movie retained an old availability retry deadline. GREEN after implementation.
- Focused command: `npm test -- tests/movie-availability.test.ts tests/watcher.test.ts tests/review-policy.test.ts tests/runner.test.ts tests/work-queue.test.ts tests/episode-progress-state.test.ts`: 181 passed before the final provider regression.
- Architectural review caught availability changes bypassing retained provider backoff. Added RED available → throttled → unavailable → available regression, then retained future provider backoff status/deadline. Reviewer follow-up found no blockers.
- Final `npm run typecheck`: passed. `npm test`: 49 files, 803 tests passed. `git diff --check`: passed. `openspec validate simplify-queue-and-evidence-based-reviews --strict`: passed.
- Application tests are offline, no live/prod mutation. Frontend/container checks are not claimed by this backend checkpoint; complete integration and remote CI remain later tasks.

## Checkpoint 2 — queue-review lifecycle

- Added nullable versioned private evidence, migration/reinstantiation coverage, owned incident creation, cause/scope/intent dedupe and resolved-history recurrence. Invalid evidence is tolerated as unknown, never used for cleanup.
- Added positive-import cleanup with fresh/non-regressing source and exact provider/episode identity; legacy and unknown-scope reviews remain untouched. Linked intent reviews wait for actual intent fulfillment.
- Parent completed the worker's missing negative and future-sibling lifecycle tests, removed guessed fallback intent linkage, and tightened canonical scope/time validation.
- RED regressions reproduced imported exact-episode uncertain queue rows holding future siblings, and broad unknown queue rows generating unreleased-only reviews. Fixed by using positive imported facts and retaining transient safety holds without premature durable tasks.
- Focused `npm test -- tests/queue-review-state.test.ts tests/queue-review-lifecycle.test.ts tests/runner.test.ts tests/work-queue.test.ts`: 137 passed. `npm run typecheck`: passed. Full `npm test`: 51 files, 817 passed. `git diff --check`: passed.
- Architectural reviewer found no blocking code findings. All checks offline; no production changes. The old review-resolution/coverage shortcut and reset are deliberately addressed next, not claimed fixed by this checkpoint.

## Checkpoint 3 — safe local reset

- Reset now clears scheduling/attempt clocks and unlinked reviews as history while preserving all linked reviews, intents, queue coverage, decisions, associations and dedupe protection. Freshness, provider limits, opt-in, origin/cycle checks and owned same-series leases remain enforced.
- Removed the inference that resolving a review discharges vanished coverage; pending reset prevents pre-reset library reads from making paid work eligible.
- RED: tests reproduced blocked reset for an old queue review/reservation, coverage disappearing after review resolution, and pre-reset read remaining actionable. GREEN after implementation. Updated two old tests that intentionally expected review-only dismissal to release coverage/terminal resets to be forbidden.
- Focused suites exercised state/API gates, preserved linked evidence and next-poll reconstruction. Final `npm run typecheck`: passed. Full `npm test`: 51 files, 821 passed. `git diff --check`: passed.
- Independent architectural review found no blocking findings. Confirmation UI remains task 3.2; backend action and safety invariants complete. No live calls or production mutation.
