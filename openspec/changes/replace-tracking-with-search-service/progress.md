# Progress: Search-first replacement

## State

Implementation approved with revised scope: explicit server-listed download-client choice for manual submissions, descriptive language preferences (no hard-language v1 gate), bounded authorized live Prowlarr/model dry-run evaluation, and a fresh-database-only boundary replacing migration/legacy compatibility. Branch/task audit reconciled implementation and evidence: **14/17 tasks complete**. Remaining: full acceptance checks (8.2), container/native-addon portion of 8.3, and final publication/CI acceptance (8.4). No production state changed.

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

## Branch reconciliation and continued implementation — 2026-11-15

The preceding handoff is historical, not the current task state. The user requested an audit of commits/tasks and continued implementation, then explicitly prioritized source/test acceptance inspection and quick sanity checks over another opaque broad verification run.

### Commit-to-task reconciliation

| Checkpoint | Delivered scope | Reconciliation |
| --- | --- | --- |
| `e7adbba` | Contracts, fresh SQLite boundary, policy/proposal | Tasks 1/2; prior evidence retained |
| `08305f0` | Tool loop, selection, explicit submission, Arr observations/automation | Tasks 3/4 already checked; 5.1/5.2 implemented but needed explicit scenario coverage/docs |
| `17a1943` | Shared runtime, HTTP/MCP, replacement UI, legacy-engine deletion | Tasks 6/7 implemented but docs, rendering, interface concurrency and final checks were incomplete |
| This continuation | Current operator docs/defaults, missing filters/history, scenario coverage, obsolete CLI/proxy cleanup | Checks below support 5.1–8.1; not a claim that tasks 8.2–8.4 passed |

Older changes retain their historical checkbox/evidence state: `support-ongoing-episode-acquisition` remains 16/17 and `simplify-queue-and-evidence-based-reviews` remains 9/9. Supersession is not retroactive completion or archive.

### Findings and fixes

- Preserved/reviewed inherited uncommitted docs/UI work. Both Compose files still selected the legacy DB despite the fresh default in `.env.example` and runtime; corrected both defaults and stale cycle comments. Expanded both configurations with `docker compose config --format json` and asserted the fresh DB path; both passed without starting containers.
- The inherited focus test dispatched a synthetic click without focusing its opener, then compared large DOM objects on failure. Replaced the failing equality with a boolean assertion: the same failure completed in 0.93 seconds instead of opaque object formatting. Focused the opener to model keyboard activation and added reverse wrapping; forward wrapping, Escape and restoration pass. Earlier interrupted runs and the worker's timed-out frontend run are not passing evidence.
- Added Activity media and inclusive creation-time filtering to runtime/HTTP/MCP/UI; validated invalid/reversed ranges. Local UI dates include whole selected days. Added omitted queued/rejected/deferred/expired status choices (new test failed before correction). Removed redundant per-item DB rereads in filtering.
- Added saved per-release submission history to Search details, keeping submitted/downloaded/imported distinct (new UI test failed before implementation).
- Added true concurrent HTTP/MCP submission coverage: one synthetic POST in flight; overlapping other-interface confirmation deferred, and a later different key still deferred by persisted physical grace. No actual network/download services are used.
- Coverage audit found genuinely missing explicit Arr tests; added timing, Radarr eligibility, scoped season/series rows, disappearing queue coverage, terminal/warning/import states, source/content identity invalidation, ordinary no-match retry, repeated capped failures, provider throttle and stale-rank-1 cases. These cover existing behavior and passed without a runtime rewrite; no fabricated RED claim.
- Removed the leftover two-line operator CLI retirement stub and Vite `/cycle` proxy. The new no-retired-modules assertion failed on `operator-cli.ts` before removal and then passed. Current docs describe supported fields/scopes, costs, finite retry/duplicate risk, current endpoints/tools and deliberate rollback.

### Capability/scenario evidence map

- **Arr authority / unknown observations:** `arr-observation` eligibility/identity/provider-isolation/queue cases, `arr-queue` pagination failures, `episode-timing` precise/calendar/invalid cases, Sonarr/Radarr clients. No legacy engine input is read by `src/search/arr.ts` or `automation.ts`.
- **Fair individual-episode automation / fresh rank 1 / finite retry:** `arr-automation` sibling/preference, pause, stale-rank-1, no-match, five failures/cap, throttle and dry-run cooldown tests; `submission-service` fresh validation/ownership/configuration regressions.
- **Persisted end-to-end matrix:** `search-lifecycle` starts fresh file-backed SQLite, polls, runs the real multi-turn SearchService/SubmissionService, grabs only rank 1, observes a sibling queue/import, deletes a file, restarts and re-searches. Its second replay restarts five minutes INTO grace, verifies no attempt, then chooses an alternative after expiry; changed/removed-source replays prevent POSTs. These are synthetic fake upstreams, not production or statistical model-quality evidence.
- **Neutral contract / read-only tools / visibility / suitability / references:** existing `search-contracts`, `search-service`, `search-selection` and client tests, with their recorded checkpoint evidence above. No claim of rerunning these entire earlier domains in this continuation.
- **Separate submission / client choice / durable concurrency / privacy:** `submission-service` and state suites from prior checkpoints; fresh HTTP/MCP concurrency test and public Activity locator assertion; `search-lifecycle` private-URL exclusion; `search-api` dry-run/expiry/CORS/no-Arr checks.
- **Operations/storage:** `search-runtime` retention/receipt fallback/source snapshot/abandoned ownership/settings tests; `search-database-boundary` fresh/restart/untouched legacy tests; `settings` defaults and `daemon` disabled scheduler/shutdown tests; new filesystem assertion excludes retired runtime modules.
- **UI:** centralized `web/src/App.test.tsx` now covers navigation/read-only search/evidence, saved details, media/time/status filters, per-release outcomes, configured client ID/idempotency, dry-run Arr search versus refresh/poll, expiry, and modal keyboard handling. Task 7.1's speculative `Search.test.tsx` command was corrected to the actual equivalent centralized suite, not treated as a missing executable.

### Actual checks and rendered evidence

- Parent focused acceptance command: `timeout --kill-after=2s 15s node node_modules/vitest/vitest.mjs run tests/arr-observation.test.ts tests/arr-automation.test.ts tests/arr-queue.test.ts tests/episode-timing.test.ts tests/sonarr-client.test.ts tests/radarr-client.test.ts tests/search-api.test.ts tests/search-mcp.test.ts tests/search-lifecycle.test.ts tests/search-database-boundary.test.ts tests/submission-service.test.ts tests/settings.test.ts tests/daemon.test.ts tests/search-runtime.test.ts` — **108 tests / 14 files passed, 1.38 seconds**.
- `timeout --kill-after=2s 10s node --import tsx --test src/App.test.tsx` (workdir `web`) — **8 passed, 1.09 seconds**.
- Direct installed backend/web `tsc --noEmit` commands passed; direct installed `vite build` passed in 1.50 seconds. Final post-edit typecheck/structural checks recorded with checkpoint below. These direct executable commands avoid npm wrappers and are equivalent tools, not a full backend-suite pass.
- Started `scripts/preview-search.ts` bound only to `127.0.0.1:4787`, in-memory SQLite, synthetic model/indexer/Arr data, monitoring off, dry-run on and grab deliberately throws. Inspected desktop Settings and narrow Automation, eligible-item Search, ranked alternatives, client modal and Activity navigation. Saved unchanged synthetic settings through HTTP successfully; safety defaults remained unchanged.
- Narrow captures retained locally: `.openchamber/screenshots/search-confirm-mobile-2026-11-15T18-05-58-366.jpg` and `activity-filters-mobile-synthetic-2026-11-15T18-12-56-784.jpg`. Both inspected visually; controls fit the narrow viewport. Screenshots/runtime `.openchamber` files are deliberately not staged. Operator help updated. Native browser key/type automation did not exercise keyboard input reliably; keyboard evidence is the deterministic DOM interaction test, not a claimed native Tab traversal.
- Independent reviewer found Compose defaults and focus-test setup issues; both corrected. Follow-up review of cutover docs/filter contracts found no blockers. Parent inspected actual worker diffs and reran focused checks.
- **Not claimed:** a fresh full backend suite, local amd64/arm64 container/native smoke checks, production-version compatibility, another live evaluation, deployment or real grabs. Full acceptance tasks remain open. The live budget remains exhausted at the recorded six requests; no new live calls.

### Publication state

- Existing draft PR: https://github.com/aberiggs/media-scout/pull/26, head `jammy-walrus`, base `main`. Initial read reported `DIRTY` and no current checks; the PR description still described only the foundation checkpoint. Normal topic-branch checkpoint/push and explicit reconciliation with current main follow; do not represent that initial conflict as resolved until GitHub confirms it.
- Checkpoint preflight: backend/web direct `tsc --noEmit`, `git diff --check` and strict OpenSpec validation all passed after the last edits; apply instructions confirmed **14/17**, three remaining. Explicit-path staging excludes `.openchamber/`, private evaluation files and runtime data.
- Published `e5577fd` to `origin/jammy-walrus`. Reconciled `origin/main` (`1d281ba`): preserved the replacement runtime/UI/docs and deliberate legacy-module/test deletions where main's squash of the older review work conflicted; retained main's Docker login-action update. Historical OpenSpec changes are identical and untouched. Relative to the verified checkpoint the merge changes only the upstream workflow pin and this progress record, not app behavior. Focused post-resolution checks are recorded below.
- Post-resolution: direct Vitest `run tests/search-api.test.ts tests/search-mcp.test.ts tests/daemon.test.ts` passed **15/15**, direct frontend test runner passed **8/8**, strict OpenSpec validation and staged whitespace checks passed. No unresolved index entries; staged merge diff against `e5577fd` is only the main workflow pin and progress evidence. Publishing this local main reconciliation does not merge the GitHub PR or deploy.
