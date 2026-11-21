# Search subsystem

HTTP, public MCP, and scheduled Arr automation share one search domain. The OpenRouter Agent SDK owns tool orchestration; the backend validates a single versioned release set against the owning-search ledger. Search itself is read-only. Manual execution requires explicit confirmation; scheduled execution requires saved authorization.

## Canonical request and result

`POST /api/v2/searches` and public MCP `ma_search_v2` accept the same request.
Creation returns HTTP 202 / `{searchId,status:"queued"}`; read the persisted result
with `GET /api/v2/searches/:id` or `ma_search_status_v2`.
An optional positive integer `preferredDownloadClientId` is retained in durable
search metadata and returned by search status. It is not sent to the research model
and does not validate or select a client during search.

```json
{"prompt":"Find seasons 1-4 of Example; useful partial sets are welcome","context":{"kind":"tv","titles":["Example"],"scope":{"type":"unspecified"}}}
```

For exact generic targets, supply distinct opaque `context.targets[].targetId`
references with numbering evidence. For Arr-backed acquisition intent, supply
`arrTargetIds` from the saved observation view instead: the backend freshly resolves
and validates them, then persists immutable canonical bindings. Generic target IDs
never grant Arr authority, even if they happen to equal an Arr reference.

A completed result has one `plan`, not `options`. New plans are version 2:

```json
{"searchId":"backend-id","status":"matched","plan":{"version":2,"planId":"backend-id","status":"matched","selections":[{"candidateId":"observed-id","coverage":"Seasons 1-3","reason":"Observed pack covers the first three requested seasons","uncertainty":"Season listing inferred from the release title"}],"covered":["Seasons 1-3"],"gaps":[],"deferred":[],"broadCoverage":"partial","scopeGaps":["Season 4 not found"],"extras":["Pack also includes specials"],"usefulOverlap":[],"coverage":{"covered":["Seasons 1-3"],"gaps":[],"deferred":[],"broad":{"status":"partial","gaps":["Season 4 not found"]}}}}
```

V2 finalization requires plain-language per-release coverage, overall covered/gaps/
deferred descriptions, and a consistent broad-coverage status. It has no `targetIds`
field and never maps releases to episodes or Arr entities. Coverage, gaps, extras,
and useful overlap are semantic descriptions; reasonable extras are valid. Earlier
plan formats are not shown in history.
An empty **validated** set is
`no-match`; a Prowlarr failure with no successful search is not a clean miss.
Failed/interrupted/budget-exhausted research has no executable plan.
Safe candidate evidence is retained with history independently of private locator
expiry. Consumers resolve selected IDs through the owning backend ledger, never
through client-supplied magnets or tracker URLs. Inferred coverage does not establish
download or import completion.

## Explicit release execution

`GET /api/v2/download-clients` lists enabled clients with only safe routing metadata.
`POST /api/v2/executions/prepare` confirms the complete selected set and an explicit
`downloadClientId`; `POST /api/v2/executions/commit` sends it only after rechecking
the plan, source settings, safety mode, client configuration, and candidate validity.
`GET /api/v2/executions/:id` and search detail expose durable receipts. A repeated
idempotency key with the same confirmation replays its receipt; reuse with a
different confirmation conflicts. Physical releases are held against overlapping
executions. Partial and uncertain outcomes are retained; uncertain sends are never
automatically retried. Terminal execution receipts are retained for 30 days, capped
at 10,000 records; expired receipts leave idempotency tombstones for a further
30 days.

Prowlarr category mappings are shown as inferred routing metadata, not as a
category override sent by Media Scout. A direct Newznab category mapping can be
reported as inferred; if Prowlarr has mappings but no direct match, parent-category
fallback may apply and the final category is unknown. For a client with no category
mappings, the allowlisted `fields[].name == "category"` value is exposed as
`defaultCategory` (including null/empty values); other client fields are discarded.
For qBittorrent, this is its configured fallback category. A change to that value
requires fresh confirmation.

Search requests may include a positive `preferredDownloadClientId`. It is persisted
as search metadata and returned in status but is not sent to the model, does not
validate the client during search, and never triggers automatic execution.
Manual execution endpoints do not accept automation-owned plans. The scheduler may execute only the selected set from its own search, and only under saved monitoring, explicit automatic-download permission, and dry-run off.
Activity filters accept search statuses and submission/execution outcomes, including
`partial` and `not-attempted`.

## Scheduled Arr automation

The scheduler uses one lease and selects one fair title per pass. Sonarr workloads
group all due missing episodes across seasons; Radarr workloads describe one
movie. Unknown inventories are not empty. Context-only episodes, bounded-workload
deferrals and omitted related detail are kept distinct from searched targets.
Oversized workloads rotate by last attempt, not season alone. No additional batch
API or release-to-episode assignment is involved. The explicit poll endpoint only
refreshes observations and returns promptly when another pass owns the lease.

Execution revalidates the Arr title, configured source/destination, durable selected
set and current authorization before each release. The final routing read is followed
by a fresh Arr queue check; a slow verification window stops the set rather than
sending from stale observations. These reads cannot atomically lock either service.
Changing the saved Prowlarr connection clears automatic client selections; choose the
IDs again from the new connection. Queue records identifiable as
earlier grabs in the same set do not veto later releases; unidentified new queue
coverage can stop the tail. A submitted or possibly submitted request applies
persisted media-level grace to the show or movie, including newly due episodes.
The default is 30 minutes (`queueGraceMinutes`); reopening work requires fresh Arr
observations. Definite rejection without an earlier send applies failure backoff;
search-only outcomes use the ordinary target retry deadline. Recovery never
replays the previous POST or its unsent tail. Retrying later against fresh Arr
state still carries some duplicate risk. A submitted receipt is not verified import.

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

This release requires a fresh `DB_PATH` when migrating from the retired database. External research MCPs are an additive setting on the current database; they are not required for Prowlarr searches. The retired `/api/v2/submissions` mutation route returns `410`; release-set execution uses `/api/v2/executions/*`.

The public Media Scout stdio adapter remains available and uses SDK v2. It is separate from this read-only internal server and does not expose recursive agent tools.

`arrTargetIds` explicitly requests fresh Arr resolution; arbitrary generic
`context.targets` remain opaque request references and never gain Arr authority
from their shape or a coincidental ID match. Arr-backed requests bind only fresh,
eligible targets from one show or one movie, and persist their canonical bindings
as a versioned array separate from historical single-binding settings.

Implementation map:

- `agent.ts`, `agent-contracts.ts`: SDK orchestration and ledger-validated finalization.
- `contracts.ts`, `arr.ts`, `automation.ts`: request contracts, Arr observation, and the retained cooldown-key helper; no acquisition automation engine remains.
- `store.ts`, `settings.ts`: SQLite persistence.
- `runtime.ts`, `mcp.ts`, `prowlarr-mcp.ts`: runtime wiring and MCP adapters/capabilities.

Preserve these boundaries: failed or incomplete Arr reads are unknown, not empty. Target membership is based only on the owning ledger; explicit identity conflicts and duplicate physical releases reject finalization. Broad-scope coverage is explicit and may be partial/unknown; target coverage is not proof of whole-work completeness.

HTTP routes are registered in `src/daemon.ts`; the internal Prowlarr and public Media Scout MCP tools are registered in `src/search/prowlarr-mcp.ts` and `src/search/mcp.ts`. `src/mcp/server.ts` is the public MCP process entry point. Prefer these implementations and shared contracts as the source of truth for current behavior.

Verification includes a scripted Responses server driving the real Agent SDK through the bound Fastify MCP listener, Prowlarr tool invocation and validated release-set persistence; contract tests cover foreign/fabricated membership, duplicate physical identity, overlaps, partial broad coverage and explicit no-match. Internal MCP tests cover bearer scoping, cancellation, expiry, provider cooldown, privacy, and zero grabs. The fixture model response is not live provider evidence.
## Optional external research MCPs

The administration API is `GET /api/research-mcp`, `POST /api/research-mcp`,
`PUT /api/research-mcp/:id`, and `DELETE /api/research-mcp/:id`. Save connects
and discovers usable tools before persisting; name-only and disable changes do
not probe an unchanged connection, while enabling a disabled server probes it.
The GET result is `{servers: ResearchMcpServer[]}` where each server has
`id`, `name`, `url`, `enabled`, `credentialConfigured`, and `toolNames`.
POST/PUT accept `{name,url,enabled,credential?}`. Credentials are stored under
a separate SQLite key and never returned; they do not modify v5 application
settings. Connecting trusts the endpoint: all usable tools it exposes are
available to the model, and arguments can include search context. Tool output is
untrusted. Enabled connections are attempted in parallel at job start with a
bounded connection timeout; tool calls have a separate short timeout. Optional
failures are warnings and do not block Prowlarr. The SDK exposes tools in the
existing agent loop under a readable server label plus stable unique ID prefix.
Redirects and metadata/link-local targets are blocked; localhost and private
LAN targets are allowed. Auth is sent only to the exact configured URL.
