# Search subsystem

HTTP and public MCP adapters share one asynchronous search domain. The OpenRouter Agent SDK owns tool orchestration; the backend validates a single versioned release-set against the owning-search ledger. Search is read-only and never grabs. Release execution (#56) and automation acquisition (#57) are disabled; saved preferences and observer data remain intact.

## Canonical request and result

`POST /api/v2/searches` and public MCP `ma_search_v2` accept the same request.
Creation returns HTTP 202 / `{searchId,status:"queued"}`; read the persisted result
with `GET /api/v2/searches/:id` or `ma_search_status_v2`.

```json
{"prompt":"Find seasons 1-4 of Example; useful partial sets are welcome","context":{"kind":"tv","titles":["Example"],"scope":{"type":"unspecified"}}}
```

For exact generic targets, supply distinct opaque `context.targets[].targetId`
references with numbering evidence. For Arr-backed acquisition intent, supply
`arrTargetIds` from the saved observation view instead: the backend freshly resolves
and validates them, then persists immutable canonical bindings. Generic target IDs
never grant Arr authority, even if they happen to equal an Arr reference.

A completed result has one `plan`, not `options`. Abbreviated example:

```json
{"searchId":"backend-id","status":"matched","plan":{"version":1,"planId":"backend-id","status":"matched","selections":[{"candidateId":"observed-id","targetIds":[],"reason":"Observed pack covers seasons 1-3","uncertainty":"Inferred from title; contents not inspected"}],"gaps":[],"deferred":[],"broadCoverage":"partial","scopeGaps":["Season 4 not found"],"coverage":{"covered":[],"gaps":[],"deferred":[],"broad":{"status":"partial","gaps":["Season 4 not found"]}}}}
```

`targetIds` refer only to explicit requested targets; broad free-text requests use
descriptive scope coverage/gaps. Atomic target coverage is the backend-computed
union across selections, so useful overlap is valid. An empty **validated** set is
`no-match`; failed/interrupted/budget-exhausted research has no executable plan.
Safe candidate evidence is retained with history independently of private locator
expiry. Consumers resolve selected IDs through the owning backend ledger, never
through client-supplied magnets or tracker URLs. Download execution is not available
until #56; inferred coverage does not establish download or import completion.

Fresh defaults are 100 SDK steps, 100 indexer searches and a 30-minute job deadline;
model requests have a 10-minute ceiling. Existing saved lower limits are preserved.
Capabilities cover the job plus cleanup within 35 minutes, worker leases renew,
and private candidates outlive the maximum research deadline. Numeric usage,
elapsed time and stop reasons are retained when available, not reasoning traces.

## Internal Prowlarr MCP

The daemon serves Streamable HTTP at `/internal/mcp/prowlarr` using MCP TypeScript SDK v2 (`@modelcontextprotocol/server` and the supported Node adapter mounted in the existing Fastify daemon). It uses stateful 2025-era protocol sessions (including initialize, POST calls/cancellation, GET event streams, and DELETE session termination), supported by the v2 and OpenRouter clients. SDK v2 does not require adopting the newer sessionless protocol revision. The read-only tools are:

- `prowlarr_indexers({})`: configured names and enabled/current cooldown availability. This is a live Prowlarr observation, not proof of end-to-end indexer connectivity.
- `prowlarr_search({query,indexerIds?,categories?,type?,limit?,offset?,timeoutMs?})`: searches enabled, non-cooling indexers and returns opaque `candidateId`s with sanitized observations. No grab operation is registered.

The route accepts only a backend-minted short-lived bearer capability. `SearchRuntime.createProwlarrMcpCapability(searchId, ttlMs)` is the private #55 integration seam: it requires an existing owning search, snapshots saved settings, and returns a token/expiry; the worker must revoke it with `revokeProwlarrMcpCapability` on completion/cancellation. Lifetimes are finite, validated, and capped at 35 minutes to accommodate bounded agent work. There is deliberately no token-minting HTTP endpoint and tool arguments cannot select a search ID. Stateful SDK transport sessions are bound to their authorizing capability and closed on revocation, daemon shutdown, or runtime quiesce. Prowlarr `429` responses update the shared provider cooldown, using a 60-second fallback when `Retry-After` is absent. Search cancellation and bounded timeout abort the upstream request.

Each tool call gets its Prowlarr client from that immutable settings snapshot, so a settings edit affects subsequent jobs, not an in-flight job. Candidate observations and `{release, physicalKey}` private data are persisted under the owner search ID. Safe DTO text redacts configured credentials and release locators; private data never enters model prompts or public results. Repeated physical releases share one candidate ID within a search; differing observations remain separate evidence.

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

Results are JSON text MCP content; the search result count describes that response batch, not all possible matches. Upstream search timeout defaults to 120 seconds with a 120-second ceiling; discovery uses a 15-second timeout. Omitted indexer IDs select enabled, non-cooling, search-capable indexers; an explicit empty/unavailable selection fails rather than broadening.

The daemon registers its actual bound loopback origin before dispatching work. The job passes its backend-minted capability to the canonical `createMCPTools` import and always closes/revokes it. The caller—not tool arguments—owns the search and lifetime. The public stdio server reuses the daemon architecture and reports unavailable when no HTTP origin is present; it never spawns a second engine/listener. Do not give the token to model prompts, events, public responses, or logs.

Legacy history remains inspectable via the explicit `legacyResult` projection and is never converted to release-set plans. Submission routes are blocked with `execution-deferred`; automation polling remains observation-only and reports the same block reason. External research MCP settings (#54) and per-release execution (#56) are out of scope.

The public Media Scout stdio adapter remains available and uses SDK v2. It is separate from this read-only internal server and does not expose recursive agent tools.

`arrTargetIds` explicitly requests fresh Arr resolution; arbitrary generic
`context.targets` remain opaque request references and never gain Arr authority
from their shape or a coincidental ID match. Arr-backed requests bind only fresh,
eligible targets from one show or one movie, and persist their canonical bindings
as a versioned array separate from historical single-binding settings.

Implementation map:

- `agent.ts`, `agent-contracts.ts`: SDK orchestration and ledger-validated finalization.
- `contracts.ts`, `arr.ts`, `automation.ts`: request contracts, Arr observation, and the retained cooldown-key helper; no acquisition automation engine remains.
- `submission.ts`: safe receipt projection types only; the release execution service is retired.
- `store.ts`, `settings.ts`: SQLite persistence.
- `runtime.ts`, `mcp.ts`, `prowlarr-mcp.ts`: runtime wiring and MCP adapters/capabilities.

Preserve these boundaries: failed or incomplete Arr reads are unknown, not empty. Target membership is based only on the owning ledger; explicit identity conflicts and duplicate physical releases reject finalization. Broad-scope coverage is explicit and may be partial/unknown; target coverage is not proof of whole-work completeness.

HTTP routes are registered in `src/daemon.ts`; the internal Prowlarr and public Media Scout MCP tools are registered in `src/search/prowlarr-mcp.ts` and `src/search/mcp.ts`. `src/mcp/server.ts` is the public MCP process entry point. Prefer these implementations and shared contracts as the source of truth for current behavior.

Verification includes a scripted Responses server driving the real Agent SDK through the bound Fastify MCP listener, Prowlarr tool invocation and validated release-set persistence; contract tests cover foreign/fabricated membership, duplicate physical identity, overlaps, partial broad coverage and explicit no-match. Internal MCP tests cover bearer scoping, cancellation, expiry, provider cooldown, privacy, and zero grabs. The fixture model response is not live provider evidence.
