# Progress: Search-first replacement

## State

Implementation approved with revised scope: explicit server-listed download-client choice for manual submissions, descriptive language preferences (no hard-language v1 gate), bounded authorized live Prowlarr/model dry-run evaluation, and a fresh-database-only boundary replacing migration/legacy compatibility. Foundation/search/submission tasks complete (7/17). Arr, runtime cutover and replacement UI are in development; no production state changed.

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

## Search / submission domain checkpoint

- Pushed foundation checkpoint `e7adbba` to `origin/jammy-walrus`; draft PR https://github.com/aberiggs/media-scout/pull/26 targets main. Existing checkout ancestry is preserved and disclosed in the PR.
- Implemented complete-candidate multi-turn JSON tools, safe metadata/private submission capabilities, ranked alternatives and explicit scope guards. Parent regression tests caught used-search-budget blocking the final decision, initialization not timing out, missing Retry-After, and E-only/absolute contradictions. Independent review caught the latter two; fixes have behavioral red/green evidence. Transport now permits one model call per decision without hidden retries and propagates cancellation.
- Implemented explicit client-selected downloads, persistent receipts, finite grace and target/physical leases. Parent red/green regressions cover lease loss during async validation, dry-run changes, rejected-release exclusions and short-grace overlap. Review additionally caught constant source fingerprints, crash-abandoned receipts and episode-fetch Retry-After; all reproduced and corrected. A second source-removal race was fixed directly with an end-to-end failing regression, without a third review loop.
- Persisted real-domain lifecycle replay covers episode siblings, observed imports, deleted files becoming missing again, restart through unmatched grace, alternative release selection, and changed/removed sources during async validation. No live grabs occurred.
- Full backend checkpoint run before the last targeted additions: 61 files / 904 tests passed; subsequent worker run including standalone runtime/MCP additions: 64 files / 915 tests passed. Parent final focused/domain/typecheck evidence is recorded with publication. UI and new runtime wiring remain separate unchecked work, not covered by these totals.

## Authorized live evaluation (completed search-only portion of 8.3)

- Read saved application connection settings via SSH from the named deployment. Correct existing SSH configuration uses root on the named machine; deployment path is lowercase `compose`. Only settings were queried read-only; no production library/database exports, cycles or state writes.
- Credentials and release evidence are private under `/tmp/opencode/media-scout-live/`, mode-restricted and outside the repository. The evaluation harness has no submission capability; it reserves budget before each request and has completed its only permitted tuning repeat. Budget is exhausted: no further live runs without new approval.
- Six requests total, 21 actual model decisions, 14 actual Prowlarr searches, zero grab POSTs. Four requests returned matched options; two failed validation. Candidate counts per request: 295, 71, 16, 284, 162, 43. All returned candidates were available to the model.
- The repeated failed case exposed a deterministic parser/validator bug, not insufficient model token budget: ambiguous numeric suffixes overrode explicit matching seasonal numbering; one unparseable same-hash alias also defeated valid explicit scope evidence. Added two synthetic regressions, watched assertion failures, corrected evidence precedence while retaining real wrong-season/episode rejection. Offline replay of captured final output now validates four options, with zero additional network/model calls. This is NOT claimed as a new successful live run or verified torrent contents.
- Scripted checks and six live searches do not establish statistical accuracy. Real titles/URLs/hashes and raw captured outputs are not published; only aggregate outcomes are recorded.

## User-requested checkpoint / fresh-agent handoff

The user explicitly requested stopping this long-context session after committing current work and providing a fresh-agent prompt. Detailed recovery context is in `HANDOFF.md` in this change directory.

- Runtime and UI cutover implemented; old acquisition/review engine and its engine-only tests removed. The replacement retains independent transport/parser/timing and new lifecycle tests. Remaining documentation, rendered narrow/keyboard checks, container matrix, final review and remote CI verification are NOT claimed complete; tracked tasks remain 7/17.
- Runtime review found crash recovery, retention cleanup, unbounded settings, expired-response and audit-filtering gaps. Parent reproduced/fixed them. Follow-up identified a receipt-persisted/event-missing crash window; parent added a failing regression, restored indexed durable-receipt fallback with event timestamp ordering, and verified it green.
- Final parent commands at handoff: `npm run typecheck` passed; `npm test` passed (27 files / 354 tests); frontend typecheck passed; frontend tests passed (4); production frontend build passed; `git diff --check` passed; strict OpenSpec validation passed.
- Synthetic desktop Search was exercised via the actual local HTTP/UI stack and captured. Preview server subsequently hit the shell's 120-second timeout and stopped; restart with `timeout=0` if needed. No live credentials were used in that preview. Untracked `.openchamber/` screenshots are intentionally excluded from the Git checkpoint.
- Publication/checkpoint requested now; no additional implementation will be started in this session. Fresh agent should continue using the handoff and the active OpenSpec checklist.
