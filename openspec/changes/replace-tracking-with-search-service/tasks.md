# Tasks: Search-first replacement

Owning issue: https://github.com/aberiggs/media-scout/issues/24. Selection cases: #15. **Implementation approved; tasks remain unchecked until evidence.**

Use regression-first development, synthetic fixtures, isolated fresh SQLite and fake model/indexer/Arr clients. Record red/green results, commands, review findings and blockers in this change's `progress.md`. Proposed new test filenames below are deliverables, not claims they already exist. Run focused checks per increment plus `npm run typecheck`; only checkpoint passing, reviewed coherent changes. Live evaluation is authorized only within task 8.3 limits; no grabs, production writes or deployments.

## 1. Replacement contracts and policy boundary

- [x] 1.1 After explicit approval, amend `AGENTS.md` and operator policy docs to replace indefinite intent/vanished-coverage holds with the approved finite-grace rules while preserving ownership, unknown-vs-empty, fresh side-effect checks and import evidence. Record supersession of the two old changes without editing their completion history. Verify the docs against proposal/spec scenarios, `git diff --check` and independent policy review before runtime cutover.
- [x] 1.2 Add neutral request, tool-action, ranked-option, status and submission schemas plus prompt contracts. Cover prompt-only non-Arr requests, conflicts/needs-input, preferences versus requirements, invalid references and explicit wrong scope with `npm test -- tests/search-contracts.test.ts`; document HTTP/MCP request and response examples in `docs/search-api.md`.

## 2. Fresh database and storage

- [x] 2.1 Add search/query/candidate/option/audit storage, target retry/provider deadlines, leases and submission receipts behind narrow repositories. Verify restart, rollback-on-write-failure, pruning, expired candidates, stale owners, target/physical-release overlap and identical-key replay with `npm test -- tests/search-state.test.ts tests/submission-state.test.ts`; document retention/privacy rules in `docs/search-api.md`.
- [x] 2.2 Add startup guard that refuses an existing nonempty legacy database with clear fresh-database-path instructions and no deletion/modification. Verify fresh DB, restart persistence and untouched legacy fixture with `npm test -- tests/search-database-boundary.test.ts tests/settings.test.ts`. Update setup/publishing documentation with fresh-path and external-download caveats; no real database migration during development.

## 3. Read-only multi-turn search

- [x] 3.1 Build the bounded typed next-action loop and allowlisted read-only indexer tools using the existing provider adapter seam. Test query refinement, alternate numbering/titles, all 100/200 candidates delivered, last-position low-seeder winner, duplicate/conflicting observations, incomplete sources, context overflow, time/turn/tool budgets, correction bound, cancellation/interruption and Retry-After with `npm test -- tests/search-service.test.ts tests/llm-client.test.ts tests/prowlarr-client.test.ts`; document actual limits and failure meanings.
- [x] 3.2 Implement ranked-option validation and evidence-bearing output with frozen synthetic cases for S2E1/absolute 26, absent absolute metadata, split cours, aliases, explicit wrong season, incomplete airing pack, explicitly wrong versus unknown language, multi-sub soft preference, original/dubbed audio, resolution trade-offs and no suitable releases. Test scope, reference fabrication, prompt injection and privacy with `npm test -- tests/search-selection.test.ts tests/search-contracts.test.ts`. Supply fixture rubric and prompt version notes; scripted tests must not be described as measured live model accuracy.

## 4. Explicit submission boundary

- [x] 4.1 Implement unexpired option resolution, validated enabled Prowlarr download-client selection (default Arr TV/movie route), dry-run/enablement/routing gates, owner-checked per-target/release locking, atomic persisted target/physical-release grace checks, pre-POST receipts and per-release results. Verify invalid/arbitrary client rejection and manual client choice along with concurrency, idempotency, timeout and audit failure cases using `npm test -- tests/submission-service.test.ts tests/submission-state.test.ts tests/prowlarr-client.test.ts`; document explicit confirmation, client choice and finite uncertainty behavior.

## 5. Thin Arr client

- [ ] 5.1 Implement fresh library/queue observations and relevant profile/context adapters without importing the old work/review state machine. Cover airtime/date-only/unknown timing, monitoring, movies `isAvailable`, all queue pages, direct episode/movie IDs, coarse season/series rows, failed versus warning/import-pending states, unidentified rows, provider isolation, identity changes and safe context with `npm test -- tests/arr-observation.test.ts tests/sonarr-client.test.ts tests/radarr-client.test.ts`; document the exact supported API fields and scopes in `docs/operations.md`.
- [ ] 5.2 Implement episode-first fair scheduling and rank-1-only search/submission integration with fresh pre-grab checks. Replay imported→deleted→missing, E3 downloading/E4 due, bad unmatched release→grace expiry→alternative, matched job disappears, no-match→finite retry, matched dry-run cooldown across polls/restart, repeated failure without review, restart during grace, stale rank 1, pause mid-search and provider throttling using `npm test -- tests/arr-automation.test.ts tests/search-lifecycle.test.ts`. Verify no old review/intent/dedupe input can block these cases; document retry defaults, accepted duplicate risk and manual Search now limits.

## 6. Interfaces and runtime cutover

- [ ] 6.1 Wire new search/status/activity/submission/automation routes and MCP tools to shared services, async search lifecycle, versioned settings and readiness without mandatory Arr. Verify HTTP/MCP parity, safe errors, unknown IDs, expired options, polling versus view refresh and disabled/dry-run gates with `npm test -- tests/search-api.test.ts tests/search-mcp.test.ts tests/settings.test.ts tests/daemon.test.ts`; publish endpoint/tool examples and compatibility notices.
- [ ] 6.2 Remove old runner/review/recovery runtime wiring and obsolete implementations after replacement coverage exists; retain no legacy readers, dual engine or retired-action stubs. Verify no old scheduler starts and old runtime modules are absent with `npm test -- tests/search-api.test.ts tests/search-mcp.test.ts`; update operator CLI help, operations/recovery/dashboard docs and relevant README/API references.

## 7. Replacement UI

- [ ] 7.1 Implement Search with optional context/preferences/requirements, running tool trail, ranked alternatives, evidence/uncertainty, no-match/error/expiry states and explicit dry-run-aware submission confirmation. Verify `npm --prefix web test -- src/Search.test.tsx`, `npm --prefix web run typecheck` and synthetic keyboard/wide/narrow rendered review; document Search use and costs.
- [ ] 7.2 Implement Activity, Arr-derived Automation and simplified Settings; remove active Reviews/Reset/release controls. Cover filters/retention, status distinctions, unknown/stale reads, Poll now versus refresh, Search this item and focus restoration with `npm --prefix web test` and `npm --prefix web run typecheck`. Inspect rendered desktop/mobile layouts with synthetic local data, capture evidence and update operator screenshots/help; never bind a development listener publicly or use production credentials.

## 8. Cross-cutting acceptance and verified checkpoints

- [ ] 8.1 Run a persisted end-to-end offline matrix from fresh setup through poll, multi-turn search, rank-1 grab, queue match/import, deletion, re-search and restart. Include concurrent HTTP/MCP callers and audit redaction. Verify `npm test -- tests/search-lifecycle.test.ts tests/search-database-boundary.test.ts tests/search-api.test.ts tests/search-mcp.test.ts tests/submission-service.test.ts tests/arr-automation.test.ts`; map each capability scenario to test evidence in `progress.md`.
- [ ] 8.2 Run `npm run typecheck`, `npm test`, `npm --prefix web run typecheck`, `npm --prefix web test`, `npm run build`, `git diff --check` and `openspec validate replace-tracking-with-search-service --strict`. Record actual outcomes/totals and distinguish regressions from pre-existing failures. Structural OpenSpec validation is not software verification.
- [ ] 8.3 Run the bounded live Prowlarr+model dry-run evaluation: no more than 3 requests, 6 search calls/request and 10 model decisions/request; at most one adjustment repeat and aggregate maximum 6 requests/36 searches/60 model decisions. Use synthetic/sanitized request context, real release titles only in private local evaluation files, no grabs or production writes, and credentials only in private local files (if needed, retrieve saved settings via SSH `zimablade` from `/media/IronWolf1/Compose/media-scout`). Report safe aggregate outcomes only, not titles or secrets. Then run available amd64/arm64 container builds and isolated SQLite native-addon smoke checks without publishing/deploying; record results or exact blockers.
- [ ] 8.4 Obtain independent read-only review of implementation/spec compliance and actual checks; address blocking findings within bounded review cycles and rerun affected checks. Verify explicit-path diff/staging, current topic branch and remote, commit/push coherent verified checkpoints normally and open/update an issue-linked PR targeting main. Record PR/CI state, residual risks and any publication blocker; no merge/deployment/archive or promise of live quality accuracy.

## Workflow follow-up

- Implementation is explicitly approved, including the revised fresh-database boundary and bounded live evaluation.
- Operator trial/deployment and actual real submissions remain separate and unauthorized. Keep live evaluation dry-run only; provide safe aggregate results and do not claim general accuracy.
- Archive/sync only when requested; do not mark unrelated issue scopes or old incomplete checks complete by supersession.
