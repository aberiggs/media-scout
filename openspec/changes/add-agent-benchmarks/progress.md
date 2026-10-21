# Progress

## Investigation and proposal

- Read GitHub #6 and comments, #15, AGENTS.md, development/operations/recovery docs, relevant clients/core/composition/HTTP/UI code, and existing OpenSpec context. Initial `git status --short` and diff were clean.
- Consulted a read-only architecture-review specialist; there is no dedicated architect agent in this session. Incorporated replay-support, state isolation, accounting and metadata namespace concerns.
- Consulted current TMDB API documentation through Context7 for aliases/external-ID lookup and public seasonal MyAnimeList search results. Search snippets do not verify episode mappings, popularity rankings, or availability.
- Prepared proposal, design, capability spec and 13 implementation tasks. Implementation: **0/13**; no application files changed.
- No private credentials/runtime data inspected; no Prowlarr/model calls, daemon, downloads, production writes, or deployment performed. No implementation authorization assumed.

## Checks

- `openspec list --json`: passed; reused existing project-local root, leaving other changes untouched.
- `openspec context --json`: passed; resolved this checkout.
- `openspec list --specs`: passed; no existing main specs.
- `openspec status --change add-agent-benchmarks`: passed; 4/4 planning artifacts complete (not implementation completion).
- `openspec validate add-agent-benchmarks --strict`: passed.
- `git diff --check`: passed. New artifact content also reviewed directly; only the new proposal directory is untracked.
- Read-only follow-up architecture review: no blocking findings. Clarified independent-stage paired capture versus production's adaptive fallback; no claim of production-equivalent adaptive evaluation in the MVP.
- Software tests/builds and live evaluations: not run; planning artifacts only, not evidence of software/model correctness.

## Authorized capture increment

- The user authorized live capture/model calls if needed, selected a smaller anime share, and identified the settings DB on SSH host `zima`. Found `/media/IronWolf1/compose/media-scout/data/media-agent.db`; read app settings with SQLite mode=ro/query_only, without copying the DB or exporting its settings. Revised the design to four anime/four US shows/four movies.
- Saved reverse-proxy addresses timed out during connection probing. Verified published localhost service ports with container metadata and successful read-only API responses; used a process-local loopback connection override, without changing saved configuration. Public metadata lookup and Skyhook supplied the target crosswalks; no personal library read/export occurred.
- Implemented standalone standard-library Python query capture tooling, a strict frozen manifest and offline regression tests. This is a capture-only increment toward 3.1/3.2, not approval or implementation of the full app benchmark runner/UI.
- Worker supplied an initial implementation with only two tests and reported missing coverage. Parent review exposed incorrect enabled/cooldown handling, transitive-ID and sanitization gaps; added failing regressions and corrected them before the retained live runs. Independent review also found missing post-search cooldown checks and overly broad connection overrides. Interrupted the first owned capture to correct these; it produced no usable artifact/request count. Parent verified the fixes with regression tests. The follow-up reviewer declined clearance because its prompt prohibited tools; no independent final clearance is claimed.
- Corrected run on two public-classified anime sources: 50 distinct searches, 1,123 stored observations, ~103 seconds. Source-purpose review found one was the adult variant; excluded it entirely, and excluded anime-source TV/movie evidence from the retained general-media dataset.
- General-purpose source attempt: one search timed out at 30 seconds; recorded unavailable, no retry. One alternative public general source completed 16 searches, 1,039 rows, ~32 seconds. No private or semi-private indexer queried.
- Retained private projection: **12 works, 38 exact queries, 2,010 observations, 1,441 within-capture physical IDs**. Labels unreviewed; no global deduplication, exhaustive recall or model-quality claim. See `docs/investigations/issue-6-benchmark-pilot.md` for source limitations and observations.
- The retained dataset and reviewer workbook are preserved outside Git under `/home/sprocket/.local/share/media-scout/benchmarks/issue6-pilot-v1/` (0700 directory, 0600 files). Temporary audit captures remain under `/tmp/opencode/media-scout-benchmark-pilot/`; corresponding remote sanitized capture artifacts remain under `/tmp/opencode/issue6-capture/`. No original release links/GUIDs/hashes or settings were saved. Remote canary scan confirmed none of the saved API key values occur in capture artifacts.
- Zero model calls, grabs, app/database mutations, production writer startup or deployment. No paid model spend was incurred by this work.

## Increment verification

- `python3 -B -m unittest discover -s tests -p 'benchmark_capture_test.py'`: initial red coverage exposed absent safety features; **21 tests passed** after the final source-selection correction. Covers manifest/plan, balanced pilot, read-only settings, safe GET/redirect boundary, wall deadline, response/row caps, sanitization, transitive identity, empty-versus-failure, pre/post cooldown, interruption, immutable private output and dry plan isolation. Live CLI now requires explicit selected sources before reading credentials; a red/green regression establishes that no implicit selection occurs. Added this offline command to CI; no live invocation in CI.
- `python3 -m py_compile tools/benchmark_capture.py`: passed before final safety changes; final syntax/import checked by the complete Python suite.
- Frozen repository manifest equals executed primary manifest: passed (12 works, 52 slots; 50 exact distinct requests).
- Retained projection assertions: passed; 12 cases, only retained source pseudonyms, successful exact retrieval records, no URL/hash/GUID/key fields.
- `npm ci` and `npm run web:install`: passed. npm reported 6 backend advisories (1 moderate, 3 high, 2 critical) and 8 frontend advisories (2 moderate, 6 high), plus install-script warnings. No dependency fixes or lockfile changes made.
- `npm run typecheck`: passed.
- `npm test`: **832 tests / 51 files passed**.
- `npm --prefix web run typecheck`: passed.
- `npm --prefix web test`: **44 passed**.
- `npm run build`: passed.
- Container builds/SQLite native-addon smoke checks: not yet run for this increment; do not infer from the web build or tests. PR CI must supply that evidence.
- `openspec validate add-agent-benchmarks --strict` and `git diff --check`: passed. Checkpoint publication follows local verification; Git/PR metadata records the published revision and CI status.

## Task status and next gate

**0/13 full feature tasks complete.** Keep 3.1 unchecked: this utility accepts manually verified metadata, not an automated metadata-capture CLI; the broader foundations remain unimplemented. Keep 3.2 unchecked: candidate identity/coverage/multiple-acceptable labels need human review and a frozen label revision. The coherent query-capture increment is verified, but is not the whole benchmark feature.

Present the private workbook for annotation/privacy review. No model call is needed until those labels are ready; require selected endpoint/model and explicit budgets before a scored live model run. The app implementation remains outside this capture-only authorization.

## Approved implementation continuation

- User explicitly approved full implementation and actual benchmarking for PR #22,
  not another capture-only completion. Reused its existing worktree/head branch;
  left the unrelated checkout's untracked feedback file untouched.
- Read #6/#15, all change artifacts, project instructions and operator docs.
  Reused the existing 12-work / 38-query / 2,010-observation private capture; no
  Prowlarr recapture, download-link fetch or production application startup.
- Human explicitly approved **US$2 total** for the configured-model baseline,
  including retries/corrections, conditional on enforceable conservative bounds.
  SQLite read-only/query-only selected only AI model/base URL on zima; configured
  model is `z-ai/glm-5.3-flash` at OpenRouter. No credentials printed or DB copied.
- Inspected all 262 selected candidate titles. Corrected draft documentary identity,
  explicit range coverage and seasonal-local episode mistakes. Human reviewed the
  named documentary/Batman distractors, Blue Box mapping and multi-acceptable
  inferred-pack rubric, and approved publishing/provider disclosure of the
  sanitized factual subset. Uncertain bracketed claims remain unscored. Published
  fixture contains actual candidate evidence, ordered exact-query subset mappings,
  original counts, public source provenance and review limitations, not raw exports.
- Added strict artifact contracts/storage and attempt telemetry, budget reservations
  and production-class decision evaluation. Tests exposed traversal reads, invalid
  schema/JSON accounting, failed transport accounting, duplicate settlement,
  contradictory cost bounds and untrusted returned model strings; corrected root
  causes. Independent review's three important findings were fixed with regressions.
- TDD: evaluator regression initially failed 4/7 (fabricated references, group
  overlap, actual association and retrieval subset isolation); 7/7 passed after
  implementing distinct real decision paths. Unseen requests remain unsupported.
- This is a foundations/evidence checkpoint, not feature completion. App run service,
  transport controls and UI still need implementation; budget helpers alone do not
  authorize or prove paid execution. No live model call has yet been made.

### Fresh checkpoint checks

- `npm run typecheck`: passed.
- `npm test`: **853 tests / 55 files passed**.
- `npm --prefix web run typecheck`: passed.
- `npm --prefix web test`: **44 passed**.
- `npm run build`: passed.
- `python3 -B -m unittest discover -s tests -p 'benchmark*_test.py'`: **24 passed**.
- `git diff --check`: passed.
- `openspec validate add-agent-benchmarks --strict`: passed.
- No container/native-addon success claimed for this new checkpoint; PR CI must
  supply it. Full tasks remain unchecked until all their assigned criteria pass.
- Follow-up review exposed permissive structural grounding and lost replay order.
  Four regressions failed before correction; now title boundaries and supplied
  numeric scope are checked, and replay assembles the ordered per-query ID union.
  Fresh `npm run typecheck`, `npm test` (**857/55**), whitespace and strict OpenSpec
  checks passed after those fixes. No further review relaunch used.
