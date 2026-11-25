# Search subsystem

HTTP, public MCP, and scheduled Arr automation share one search domain. The OpenRouter Agent SDK owns tool orchestration; the backend validates a single versioned release set against the owning-search ledger. Search itself is read-only. Manual execution requires explicit confirmation; scheduled execution requires saved authorization.

## Canonical request and result

`POST /api/v2/searches` and public MCP `ma_search_v2` accept the same request.
Creation returns HTTP 202 / `{searchId,status:"queued"}`; read the persisted result
with `GET /api/v2/searches/:id` or `ma_search_status_v2`.

UI, public MCP, and API acquisitions share a durable FIFO queue. **Concurrent
searches** in Settings limits on-demand work (1–10, default 3). Changing the
limit does not interrupt running work. A provider cooldown delays dispatch
without dropping jobs; search detail reports why a request is waiting.
```json
{"prompt":"Find seasons 1–4 of Example. Prefer original audio with English subtitles; useful partial sets are welcome."}
```

Creation accepts exactly one field, `prompt`, a non-empty string. Former metadata
fields and unknown fields are rejected. The saved prompt is the exact safe
multiline text sent as model input; system guidance is separate.

Historical results and receipts remain available. Old queued request formats are
not translated or sent to a model; they fail with a resubmit message. Historical
Arr-sourced work is never executable.

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
Prepare accepts:
```json
{"searchId":"search-id","planId":"plan-id","version":2,"candidateIds":["candidate-id"],"downloadClientId":7}
```
Commit accepts:
```json
{"confirmationId":"confirmation-id","searchId":"search-id","planId":"plan-id","version":2,"idempotencyKey":"caller-key"}
```
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

After its own scheduled pass ends, an automation match can be manually prepared
with an explicit client and whole-set confirmation. A running execution or a
prior accepted or possibly accepted grab blocks resubmission of that set even
after physical holds expire. Rejection, dry-run, and not-attempted outcomes alone
do not block it. The same idempotency key can still reconcile an existing
execution. Expired candidates, including confirmed Prowlarr cache misses,
require a fresh search. Historical Arr-only and
API acquisition searches cannot be manually submitted.
Confirmation always requires an explicit download-client choice.
Activity filters accept search statuses and submission/execution outcomes, including
`partial` and `not-attempted`.
Activity prompt previews are capped at 240 Unicode code points; `q` still searches
the full stored prompt, while search detail retains its exact text.

## Trusted server-to-server acquisition

Trusted callers may `POST /api/v2/acquisitions` with `{"prompt":"Find Example","downloadClientId":7}` and a required `Idempotency-Key` header (1–200 characters from `A-Z a-z 0-9 . _ : -`). The strict body rejects extra fields. HTTP 202 means the accepted request and its queue entry were atomically persisted; the response contains `searchId`, `status:"queued"` and `statusUrl` for `GET /api/v2/searches/:id`. Repeating the same key and request returns the same ID even after the job finishes; different content conflicts with 409. Intake keys are retained for at least 60 days from acceptance, and longer while their search remains retained. Completed acquisition history is retained for up to 30 days from search completion, subject to the shared 10,000-entry cap. A replay can return the original ID after its detail endpoint has expired. If detailed execution receipts are pruned first, search detail still shows the acquisition outcome.

Acquisitions share the on-demand FIFO queue and its configured worker limit, use the ordinary planner, and execute the entire validated plan. Once matched, the backend uses the requested client ID, with no fallback, and rechecks the Prowlarr connection, client configuration and dry-run setting before execution and before every send. Dry-run sends no grabs. Manual preparation/commit cannot take ownership of the job. Search detail reports `manualExecutionEligible: false` and includes `acquisition.status`; for a clean miss the search is `no-match` and the acquisition is `not-attempted`.

Unclaimed requests survive a restart. A started job is not replayed: a match interrupted before journaling is reported as `interrupted`, and an in-flight send is recovered as `uncertain`, with no resubmission. Use this endpoint only from trusted servers, not cross-origin browser code.

If Prowlarr rate-limits a download-client check, Scout pauses queued work according to `Retry-After` (60 seconds if absent) without retrying the stopped acquisition. Search detail reports `prowlarr-rate-limited` before an execution starts, or records the rate limit in the receipt if execution has already started.

## Scheduled Arr automation

The scheduler uses one lease and selects one fair title per pass, separately from
the on-demand slots. It does not start a title while the on-demand queue is
backlogged or its slots are full. Sonarr workloads
group due missing episodes across seasons; Radarr workloads describe one movie.
The show prompt includes provider titles as search hints, exact requested episode
rows, and guidance to search by title and episode identifier first for small
requests, with alias or season-pack searches as needed. Larger requests start
with season or batch queries. The prompt still favors healthy, useful packs,
including overlapping packs, among candidates that satisfy explicit requirements.
Preferences are tradeoffs, not vetoes; coverage preferences never justify a
disqualified release. For example,
if the user requires a subtitle language and prefers a resolution, a qualifying
lower-resolution episode is preferable to a pack without the required subtitles.
A useful partial set can be selected with its gaps named. Connected research is
optional and can happen before, between, or after indexer queries. If no useful
indexer query is possible, the result should explain why without claiming a search ran.
A movie prompt uses the title and year when known. Saved automation preferences
default to blank and are appended only to scheduled searches. Owned, unmonitored,
queued and not-yet-eligible episodes are not dumped into the prompt. The size limit applies to the rendered
prompt, and oversized workloads defer whole episodes and rotate by last attempt.
Unknown inventories are not empty. No additional batch
API or release-to-episode assignment is involved. The explicit poll endpoint only
refreshes observations and returns promptly when another pass owns the lease.

The Automation view lists monitored missing targets regardless of timing.
`PUT /api/v2/automation/airing-offsets/:titleId` accepts `{"hoursEarly":72}`
(integer 0–168, with 0 removing the override) and returns refreshed local
automation status, without reading Arr or dispatching work. Use the opaque
`titleId` from that view. An override is scoped to the observed Sonarr connection
and series, persists across restarts, and remains visible and resettable while
the show is caught up. It subtracts hours from the ordinary eligibility time
(exact UTC airtime, or following UTC midnight for date-only metadata) and is
checked again at submission. It neither invents an air date nor changes the
metadata used to identify the episode. Radarr eligibility and retries are unchanged.

The scheduler may execute only its own selected set, with monitoring enabled,
automatic downloads allowed, and dry-run off. Before each release it revalidates
the Arr title, configured source/destination, durable selected set and current
authorization. Scheduled client discovery and pre-journal validation each retry a
transient read once, unless Prowlarr is cooling down. For each release, a transient
read or a window that goes stale through the send journal gets one fresh set of
reads before any grab. If the checks still cannot confirm it is safe to send,
remaining releases are not attempted. These reads cannot atomically lock either service.
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
model requests have a 10-minute ceiling. The job deadline starts when the worker
starts the search, not when it is queued, and can be set to 1–30 minutes. It
bounds model turns and tool work; deadline expiry or daemon shutdown cancels
active work. There is no per-search Cancel action. Existing saved limits are preserved.
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

Results are JSON text MCP content; the search result count describes that response batch, not all possible matches. The upstream search defaults to a 240-second aggregate budget, including the initial indexer/status reads. A call can request a shorter timeout. The MCP client waits up to 250 seconds to allow the upstream result to get back to the planner. Standalone indexer discovery uses a 15-second upstream budget. The job deadline and cancellation apply throughout. Omitted indexer IDs select enabled, non-cooling, search-capable indexers; an explicit empty/unavailable selection fails rather than broadening.

The daemon registers its actual bound loopback origin before dispatching work. The agent uses the MCP SDK client directly for the two built-in tools so the SDK's default 60-second request timeout does not undercut Prowlarr. The worker closes the client and revokes its backend-minted capability. The caller—not tool arguments—owns the search and lifetime. The public stdio server reuses the daemon architecture and reports unavailable when no HTTP origin is present; it never spawns a second engine/listener. Do not give the token to model prompts, events, public responses, or logs.

If Scout reaches the Prowlarr API through a reverse proxy, configure at least **5 minutes** of read/response timeout there. The daemon's internal MCP hop is direct by default; apply the same headroom if that hop is separately proxied. Scout cannot extend a shorter proxy timeout or a timeout enforced by Prowlarr or an indexer.

This release requires a fresh `DB_PATH` when migrating from the retired database. External research MCPs are an additive setting on the current database; they are not required for Prowlarr searches. The retired `/api/v2/submissions` mutation route returns `410`; release-set execution uses `/api/v2/executions/*`.

The public Media Scout stdio adapter remains available and uses SDK v2. It is separate from this read-only internal server and does not expose recursive agent tools.

Implementation map:

- `agent.ts`, `agent-contracts.ts`: SDK orchestration and ledger-validated finalization.
- `prompt.ts`, `workload.ts`: system research guidance and bounded scheduled prompts.
- `contracts.ts`, `arr.ts`: public request contracts and Arr observation.
- `store.ts`, `settings.ts`: SQLite persistence.
- `runtime.ts`, `mcp.ts`, `prowlarr-mcp.ts`: runtime wiring and MCP adapters/capabilities.

Preserve these boundaries: failed or incomplete Arr reads are unknown, not empty. Only candidates in the owning ledger may be finalized; duplicate physical releases are rejected. Candidate identity is evaluated by the agent semantically, not vetoed by TVDB/TMDB IDs. Broad-scope coverage is explicit and may be partial/unknown; target coverage is not proof of whole-work completeness.

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
untrusted. Enabled connections are attempted in parallel at job start, with
up to 25 seconds for connection and discovery and up to 50 seconds per tool
call. Optional work stops waiting when only 25 seconds remain in the search
job, leaving time for Prowlarr and finalization. Safe job warnings distinguish
connection timeouts, invocation timeouts and other failures. The SDK exposes tools in the
existing agent loop under a readable server label plus stable unique ID prefix.
Redirects and metadata/link-local targets are blocked; localhost and private
LAN targets are allowed. Auth is sent only to the exact configured URL.
