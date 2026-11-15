# Progress: Search-first replacement

## State

Implementation approved with revised scope: explicit server-listed download-client choice for manual submissions, descriptive language preferences (no hard-language v1 gate), bounded authorized live Prowlarr/model dry-run evaluation, and a fresh-database-only boundary replacing migration/legacy compatibility. Foundation tasks 1.1, 2.1 and 2.2 complete (3/17). Old runtime remains wired only until replacement cutover; no production state changed.

## Proposal verification — 2026-11-15

- Read project guidance, current issue #24, the open-issue inventory and #15 feedback, relevant development/operations/recovery docs, existing change requirements/tasks, and search/LLM/Arr/Prowlarr source seams.
- `openspec list --json` and `openspec context --json`: resolved this repository's existing root; no initialization or alternate planning store.
- `openspec list --specs`: no canonical specs; three new capability deltas declared, with explicit supersession of overlapping unarchived behavior rather than silent editing of old artifacts.
- `openspec validate replace-tracking-with-search-service --strict`: passed after proposal/spec/design/task creation and the two review fixes.
- `openspec status --change replace-tracking-with-search-service`: 4/4 planning artifacts complete; not implementation completion.
- `git diff --check`: passed for tracked diff. An attempted `git diff --no-index --check /dev/null` loop stopped on the normal difference exit code (1), not a reported whitespace violation. An explicit Python check of all nine proposal files then reported zero trailing-whitespace/final-newline errors; strict validation and 4/4 planning status were rerun successfully.
- Independent read-only reviewer found missing matched-dry-run cooldown and insufficiently explicit atomic grace checks for different-key submissions. Both corrected in design, scenarios and tasks. Follow-up review found no remaining approval-blocking contradictions in the revised excerpts.
- Software tests/builds/container checks not run: this request writes planning documents only. All implementation tasks/checks remain unperformed.

## Residual risks / next action

Implementation may proceed task-by-task. The authorized evaluation is bounded to max 6 requests, 36 Prowlarr searches and 60 model decisions total, with no grabs or production writes; report safe aggregates only. Existing old nonempty databases are deliberately unsupported and must not be changed automatically. Real selection quality remains to be evaluated; deployed Arr version compatibility and production incident causes remain unverified.

## Foundation checkpoint

- Added standalone Zod contracts, isolated SQLite search/audit/deadline/lease/submission repository and read-only legacy database guard. Updated approved policy guidance and fresh-path docs; no legacy history conversion.
- Worker supplied 11 initial passing foundation tests but reported missing meaningful behavioral RED evidence. Parent review found two real defects: a deferred reservation retained an unrelated key lease, and changed-payload completion could alter an existing receipt. Parent added regressions, ran `npm test -- tests/submission-state.test.ts` and observed both intended assertion failures, then fixed the causes.
- Extended actual file restart coverage for candidates, receipts, grace, settings, deadlines and observations; candidate expiry, stale-owner takeover, partial-transaction rollback and grace across real history deletion are checked.
- Parent `npm test`: 55 files / 846 tests passed. `npm run typecheck`: passed. `openspec validate replace-tracking-with-search-service --strict`: passed. `git diff --check`: passed. Focused recheck after the history-deletion assertion is recorded with the checkpoint.
- Independent reviewer examined actual storage/contracts and policy changes. Both defects resolved; no blocking findings. Contextual scope/reference validation and the full tool loop remain unchecked tasks 1.2/3.x, not claimed by schema tests alone.
