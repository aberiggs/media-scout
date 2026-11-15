# Proposal: Search-first Media Scout

## Why

Media Scout's purpose is an LLM-backed indexer search tool, not a second media manager. Its current durable uncertainty/review workflow can outlive the external condition that created it and block unrelated episodes; a neutral search service plus an Arr client better matches the operator's accepted trade-off: occasional bad or unmatched downloads are recoverable, indefinite tracking deadlocks are not.

Owning issue: [#24](https://github.com/aberiggs/media-scout/issues/24). Selection cases: [#15](https://github.com/aberiggs/media-scout/issues/15). Related, not automatically closed: history #13, retry policy #12, routing #14, benchmarks #6.

## What Changes

- Introduce a standalone natural-language search service, callable over HTTP and MCP without Sonarr/Radarr. A bounded multi-turn LLM uses read-only indexer tools, sees all returned candidates (including 100–200-result cases), revises queries, and returns ranked suitable acquisition options or no suitable match.
- Separate recommendations from submission. Search cannot download. Manual users submit an explicit option and may select a validated enabled download client from Prowlarr's configured server-listed clients; the default remains the Arr TV/movie route. Enabled Arr automation submits rank 1 only after fresh eligibility checks. No arbitrary client URLs are accepted.
- Replace the old runner with a thin Arr client. Fresh monitored/missing/available/library/queue data determines work; historical decisions are not library truth. Default automated TV requests target individual aired episodes; explicit season search remains available. Cross-request batching is deferred.
- Retain audit, retries, source throttling and short-lived concurrency/submission protection. Replace indefinite vanished-download reservations with a finite queue-appearance grace and retry policy. Unmatched downloads can duplicate: this is an explicit product trade-off, not a claim that empty Arr queues prove an empty download client.
- **BREAKING:** Remove active Queue/Reviews/Reset/reservation-release workflows and old work-key search/pick contracts. Start with a fresh database; fail fast with clear instructions if an existing old nonempty database is opened, without deleting or altering it. No legacy records, migration, tombstone preservation, dual engine or old-API retirement scaffolding.
- Replace operational navigation with Search, Activity, Automation and Settings. Automation mirrors current Arr observations with their freshness and concise reasons; Activity explains attempts instead of creating human review obligations.
- Keep normal restart persistence, runtime identifiers, and settings/connection configuration straightforward to re-enter. No automatic production rollout or download-client cleanup.

### Scope and non-goals

Scope includes search contracts/tool loop, submission, thin Arr polling, persistence, replacement UI, fresh-database safeguards, documentation, offline tests, local synthetic rendered verification and bounded authorized live Prowlarr/model dry-run evaluation. Live evaluation is capped at 3 requests, 6 search calls/request and 10 model decisions/request; at most one adjustment repeat is allowed within aggregate maxima of 6 requests, 36 searches and 60 model decisions. Use synthetic/sanitized request context, never grab or write production state, keep credentials in private local files, and report only safe aggregates (real titles remain private). No direct qBittorrent management, replacing Arr, importing files, custom title-matching queue AI, cross-request pack optimization, general internet browsing, arbitrary MCP execution, model training, authentication redesign, dependency overhaul, deployment or image publication. Do not promise measured 99% selection accuracy.

### Evidence and approval boundary

Confirmed from current source: `work-queue.ts:765` reopens eligible terminal work; `:805–833` creates vanished/unresolved download reviews; `:908–914` can block the whole season; `state.ts:750–783` reset preserves the underlying download protections. `picker.ts` lacks an explicit target audio/subtitle policy. The specific production French-sub choice and deleted-file case have not been reproduced; diagnosing their historical cause is not a prerequisite to this replacement and needs separately approved sanitized evidence.

This proposal intentionally supersedes existing indefinite reservation/vanished-coverage safety policy. User approval authorizes documented amendments to `AGENTS.md` and operator documentation. Existing changes `support-ongoing-episode-acquisition` and `simplify-queue-and-evidence-based-reviews` remain historical artifacts with their actual completion/blocker status, not retroactively marked completed or archived.

## Capabilities

### New Capabilities

- `release-search`: Neutral requests, multi-turn tools, complete candidate visibility, ranked options and explicit separate submission.
- `arr-automation`: Fresh Arr-derived eligibility, scoped queues, finite retry/grace behavior and automatic top-option submission.
- `search-operations`: Audit/settings/storage, fresh-database guard and replacement UI.

### Modified Capabilities

None in the canonical spec inventory (`openspec list --specs` reports no specs). This change explicitly replaces overlapping behavior in the two existing unarchived changes; it does not edit their artifacts or declare their checks passed.

## Impact

Backend: `src/compose.ts`, `src/daemon.ts`, `src/mcp/server.ts`, `src/clients/{llm,prowlarr,sonarr,radarr}.ts`, `src/settings.ts`, `src/core/state.ts`, and new cohesive search/submission/automation modules. Retire runner/work-queue/review/operator runtime wiring; retain only independently useful pure parsing/timing/transport helpers and history readers. Frontend: `web/src/App.tsx`, `Operations.tsx`, API types and tests. Docs: operations, recovery, dashboard, setup, publishing, development, MCP/API reference and `AGENTS.md`. Keep `media-agent` runtime identifiers, existing Prowlarr submission routing and loopback posture. No new infrastructure or provider is required.
