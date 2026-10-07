# General search

General search is a chat-first, open-ended discovery flow outside the Sonarr/Radarr work queue. Use the single composer for an original request, answer a genuine clarification, or refine results; the original request and up to five follow-up turns remain in page memory. The planner can issue bounded iterative Prowlarr queries based on actual sanitized results, then a separate curation step classifies supplied candidates as match, possible match, or clearly unrelated. Planning and curation do not select or submit releases. See the [rewrite verification record](general-search-rewrite-verification.md) for implementation evidence and limits.

## Configure a destination

In **Settings → Integrations → Prowlarr**, configure the Prowlarr URL and API key, then enter the exact name of one enabled download-client entry in **General download client** to make protocol-matched releases selectable. If the destination is missing or ambiguous, safe recognized-protocol discovery may still be shown, but results remain nonselectable. General search does not require Sonarr or Radarr configuration, or either of their client names.

Set up the download client and its category/label in Prowlarr itself. Choose a category appropriate for general/manual downloads and verify the destination client uses it; Media Scout does not set a separate category during submission. Avoid a Sonarr/Radarr import category unless you deliberately want those services to process the download. The configured client must have a recognized `usenet` or `torrent` protocol, and a release is selectable only when its protocol matches.

## Review and submit

Each release has its own expiry, no more than 15 minutes after discovery. Accumulating results never renews a retained release. Review selectable releases across pages, explicitly select up to the effective candidate ceiling (200 by default, at most 1000), then review and confirm the complete frozen selection. Searching and selecting do not send downloads. Even one result requires explicit selection and confirmation. Expired results cannot be submitted; search again for fresh candidates. LLM calls have a 60-second deadline; each Prowlarr HTTP request has a 15-second timeout.

**Allow operator actions** must be enabled to submit, including a dry run; it is off by default. With **Dry-run mode** enabled (also the default), confirmation returns a dry-run outcome and makes no Prowlarr grab request. A live submission requires both Allow operator actions enabled and Dry-run mode disabled. Dry-run still performs AI planning and Prowlarr searches, which may use API credits.

“Submitted” means Prowlarr accepted the request, not that the download completed. A timeout, server error, or invalid success response can leave the outcome **uncertain**. Uncertain submissions are not automatically retried; verify the download client before taking further action. A submission in progress or a prior receipt is also not sent again. Search activity does not fulfill or track library work.

## MCP clients

The stdio MCP server preserves `ma_general_search` and `ma_general_grab`, and adds `ma_general_conversation_search` plus create/status/step/stop operation tools. The operation step can submit a release to Prowlarr and is marked destructive; the MCP host must require explicit approval before each step. Before creating an operation, present and obtain human approval for the complete manifest, exact destination, and live/dry-run mode. A confirmation token or `confirmed: true` is not proof of user approval. Operator-action and dry-run safeguards still apply.

The backward-compatible nonconversational JSON workflow remains at `POST /api/search` and `POST /api/search/:id/grab`. The API has no authentication; keep the UI/API on loopback or a trusted private network as described in [operations and safety](operations.md).

## Conversational discovery and explicit steps

The additive `POST /api/search/conversation` endpoint runs the conversational search in one request; `POST /api/search/conversation/stream` emits NDJSON progress events as they occur and accepts disconnect cancellation. Events reflect actual search progress (there is no reconnect/replay guarantee). Both forms can perform LLM and Prowlarr reads, but never submit grabs. The flat optional `generalSearch` settings use canonical fields `maxQueries`, `maxCandidates`, `maxAiCalls`, `batchSize`, `displayLimit`, and `hideZeroSeeders`; defaults are 6/200/12/20/40/true, with numeric bounds 1–20/1–1000/1–100/1–100/1–1000. These are independent ceilings. `maxAiCalls` counts actual provider attempts, including correction and 5xx retry attempts. Per-request numeric query/candidate/AI/batch overrides may lower but never raise configured ceilings; display limit can vary independently up to 1000. `hideZeroSeeders` accepts an explicit per-request override, including `false`.

`POST /api/search/:id/operations` creates a frozen operation without searching again and does not submit. `GET /api/general-operations/:id` is strictly read-only; `POST .../:id/step` is a mutating action that advances one requested ordinal and can submit that frozen release to Prowlarr; `POST .../:id/stop` stops future steps. Status reads do not advance work. MCP operation tools follow the same semantics. There is no authentication, so expose them only on loopback or a trusted network. Routing is rechecked before every step, but a routing read cannot be atomic with the later upstream POST. Inspect outcomes before further action; do not retry an uncertain step. Prowlarr connection validation is not provided by this flow. Returned results use pagination/display limit; that limit does not truncate the persisted candidate snapshot or the frozen full manifest.
