# Search subsystem

HTTP and MCP adapters share the search domain. Search queries Prowlarr and returns ranked alternatives; it does not download. Submission is a distinct explicit operation. Automation reads Sonarr/Radarr state and is optional. Dry-run is the default and prevents grab requests, not search/provider costs.

## Internal Prowlarr MCP

The daemon serves Streamable HTTP at `/internal/mcp/prowlarr` using MCP TypeScript SDK v2 (`@modelcontextprotocol/server` and the supported Node adapter mounted in the existing Fastify daemon). It uses stateful 2025-era protocol sessions (including initialize, POST calls/cancellation, GET event streams, and DELETE session termination), supported by the v2 and OpenRouter clients. SDK v2 does not require adopting the newer sessionless protocol revision. The read-only tools are:

- `prowlarr_indexers({})`: configured names and enabled/current cooldown availability. This is a live Prowlarr observation, not proof of end-to-end indexer connectivity.
- `prowlarr_search({query,indexerIds?,categories?,type?,limit?,offset?,timeoutMs?})`: searches enabled, non-cooling indexers and returns opaque `candidateId`s with sanitized observations. No grab operation is registered.

The route accepts only a backend-minted short-lived bearer capability. `SearchRuntime.createProwlarrMcpCapability(searchId, ttlMs)` is the private #55 integration seam: it requires an existing owning search, snapshots saved settings, and returns a token/expiry; the worker must revoke it with `revokeProwlarrMcpCapability` on completion/cancellation. Lifetimes are finite, validated, and capped at 35 minutes to accommodate bounded agent work. There is deliberately no token-minting HTTP endpoint and tool arguments cannot select a search ID. Stateful SDK transport sessions are bound to their authorizing capability and closed on revocation, daemon shutdown, or runtime quiesce. Prowlarr `429` responses update the shared provider cooldown, using a 60-second fallback when `Retry-After` is absent. Search cancellation and bounded timeout abort the upstream request.

Each tool call gets its Prowlarr client from that immutable settings snapshot, so a settings edit affects subsequent jobs, not an in-flight job. Candidate observations and `{release, physicalKey}` private data are persisted in the existing candidate store under the owner search ID; submission remains the existing guarded `SubmissionService` boundary. Safe DTO text redacts configured Prowlarr credentials and known release GUIDs/locators, URLs, magnets and hashes. Parsed scope contains numeric claims only, not raw upstream text. Repeated physical releases share one candidate ID within a search; differing observations remain separate evidence.

Example calls and abbreviated safe results:

```json
{"name":"prowlarr_indexers","arguments":{}}
```
```json
[{"id":1,"name":"Example","enabled":true,"available":true,"coolingUntil":null,"supportsSearch":true,"supportsRss":true,"categories":[{"id":5000,"name":"TV"}]}]
```
```json
{"name":"prowlarr_search","arguments":{"query":"Example S01","indexerIds":[1],"categories":[5000],"type":"tvsearch","limit":50,"offset":0,"timeoutMs":60000}}
```
```json
[{"candidateId":"opaque-uuid","observations":[{"title":"Example.S01.1080p","indexer":"Example","size":1234,"seeders":8,"protocol":"torrent","categories":[{"id":5000,"name":"TV"}]}]}]
```

Results are JSON text MCP content; the search result count describes that response batch, not all possible matches. Search timeouts default to 30 seconds and accept 100–120,000 ms; discovery uses a 15-second upstream timeout. Omitted indexer IDs select enabled, non-cooling, search-capable indexers; an explicit empty/unavailable selection fails rather than broadening. Missing upstream capability flags retain the existing permissive eligibility behavior. These tools make no release-set, coverage partition, ranking, or plan-selection decisions.

For #52 + #55, create a capability after the backend owns/persists the search, pass its token as bearer auth to `createMCPTools` from `@openrouter/agent/mcp`, and always close the client and revoke the capability in `finally`. The current Agent SDK package makes the former `@openrouter/mcp` package a deprecated facade; the interoperability test uses the canonical entry point, dev-only, without a model request. The caller—not tool arguments—owns the search and lifetime. Use `http://127.0.0.1:<HTTP_PORT>/internal/mcp/prowlarr` from within the daemon/container; another authorized container can use the daemon's Compose service name and container port. No extra port, container, saved setting, or user-entered MCP secret is required. Do not give the token to model prompts, events, public responses, or logs. Existing same-origin checks reject cross-origin browser POSTs.

Transitional boundary: existing search jobs still use the old planner until #52 + #55 installs its replacement and wires capability creation into each job. The Prowlarr client remains shared with explicit submission, so it is not dead code and must not be removed at agent cut-over. The existing UI and public stdio tools remain functional. This foundation does not implement a new plan API, agent loop, external-MCP settings, or submission path.

The public Media Scout stdio adapter remains available and uses SDK v2. It is separate from this read-only internal server and does not expose recursive agent tools.

Implementation map:

- `service.ts`, `selection.ts`: bounded search orchestration and candidate validation.
- `contracts.ts`, `arr.ts`, `automation.ts`: shared contracts and Arr automation.
- `submission.ts`: explicit submission and idempotency boundary.
- `store.ts`, `settings.ts`: SQLite persistence.
- `runtime.ts`, `mcp.ts`, `prowlarr-mcp.ts`: runtime wiring and MCP adapters/capabilities.

Preserve these boundaries: failed or incomplete Arr reads are unknown, not empty. Submission uses idempotency to avoid duplicate POSTs; uncertain outcomes are not automatically replayed. A matched search or submitted grab does not prove download or import completion. Private download locators are kept out of public responses and model context.

HTTP routes are registered in `src/daemon.ts`; the internal Prowlarr and public Media Scout MCP tools are registered in `src/search/prowlarr-mcp.ts` and `src/search/mcp.ts`. `src/mcp/server.ts` is the public MCP process entry point. Prefer these implementations and shared contracts as the source of truth for current behavior.

Verification exercised by `tests/prowlarr-http-mcp.test.ts` includes real SDK v2 HTTP initialize/list/call and cancellation, canonical `@openrouter/agent/mcp` discovery and execution with bearer auth and close (without invoking a model), adversarial redaction, candidate ledger scope/downstream dry-run identity, unauthorized/mismatched tokens and sessions, malformed arguments, independent concurrent settings snapshots, unavailable/cooling indexers, 429 cooldown and zero grabs. A disposable HTTP Prowlarr fixture also verifies real upstream timeout, active expiry and shutdown abortion. Delivery additionally exercised the built Node 22 image through a published loopback port, actual MCP/OpenRouter discovery and calls, and clean SIGTERM exit; no production configuration, downloads, model calls or real Prowlarr service were used.
