# Investigation and proposal progress

Issue: https://github.com/aberiggs/media-scout/issues/20

## State

Investigation and draft proposal only. No implementation tasks completed or yet finalized. Material product decisions in `proposal.md` block design/spec/task completion and implementation. The unrelated ongoing-episode change and untracked user feedback document are untouched.

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

## Next action

Present the draft planning PR and obtain decisions on automatic movie availability retries and the guarded legacy-recovery option. Then complete the remaining planning artifacts; implementation requires the user's approval. No production cleanup or deployment is authorized by this proposal.
