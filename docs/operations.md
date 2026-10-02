# Operations and safety

This reference describes current behavior; it is not a guarantee that every cycle searches or that a result will be imported.

## Costs, network access, and safe rollout

`dryRun` defaults to `true`. It blocks an actual grab, but a normal due-work cycle can still call the LLM planner/picker and search Prowlarr. Those operations may incur model-provider charges, use indexer quota, and contact configured indexers. Monitoring defaults to disabled; when enabled, cycles use the configured interval. Planning/search is gated by each work unit's due time, not a guarantee that each interval is free. `POST /cycle`, `ma_cycle`, and `ma_search` can trigger network work.

The container is bound to `127.0.0.1` by default. `POST /cycle` has no authentication; do not expose the UI/API to a LAN or the internet without a separately reviewed access-control layer. MCP uses stdio without built-in user identity/authentication; review the host tool-approval policy, especially for `ma_review_action` and `ma_pick`.

Keep dry-run enabled while checking configuration and reviewing logs. Dry runs may persist ordinary scheduling and decision state, but do not create active grab intents or successful-grab dedupe markers. Only consider disabling dry-run after an operator has reviewed real candidates and routing. It is not a substitute for an import test or operator review.

## Search, selection, and review

- The watcher reads Sonarr/Radarr libraries and tracked queues. Search eligibility is per work unit and retry-window gated.
- The LLM plans Prowlarr queries and judges fuzzy identity and quality; deterministic code does not add title/quality matching heuristics.
- TV guardrails require explicit episode coverage or a single matching-season-only pack claim. Inferred pack coverage is labeled inferred, not proof of torrent contents. Known wrong seasons and malformed/conflicting scopes are rejected.
- The picker sees at most 100 candidates. Media preferences are optional soft ranking guidance, not a filter, identity rule, or override of guardrails. For example, `Prefer 1080p over 4K.` can be entered in the UI. Saved settings apply to subsequent operations without container recreation.
- Successful real grabs are deduplicated by `(indexerId, guid)` and infoHash when available. Hashless releases have weaker cross-indexer detection. Dry runs and failed grabs do not create successful-grab markers.
- Unparseable/ambiguous candidates, searches with no admitted candidates, and repeated ordinary operational failures can enter manual review. Unknown, paused, active, import-blocked, uncertain, or ambiguous queue evidence remains held rather than being automatically resubmitted.

## Cadence and failure behavior

- The UI interval defaults to 5 minutes and has a maximum of 35,791 minutes (the largest whole-minute interval within Node's timer limit). It is reconciliation cadence, not a promise to call the planner every interval. Saves apply to new operations; an in-progress cycle finishes with its original settings snapshot.
- A picker `skip` or dry-run decision is cooled down by the UI retry window (default 6 hours). A successful search with no candidate admitted by guardrails instead creates a `no-suitable-release` manual hold; it is not an LLM picker skip. Only work whose next-search time is due is eligible for another paid plan/search.
- UI failure-backoff defaults are 5/60 minutes and cap exponential failure delay; a longer upstream `Retry-After` takes precedence. The third consecutive ordinary operational failure enters manual review; rate limits stay on backoff and do not escalate solely due to quota.
- Diagnostics include safe stage, error code/type, HTTP status, and retry seconds, not exception messages, response bodies, or authenticated URLs.

## Queue and manual review

Queue grace defaults to 30 minutes for a submitted job to appear in the tracked *arr queue; it is an appearance deadline, not a download-duration limit. `ma_status` exposes safe queue counts, next-search times, coverage IDs, freshness, and coarse hold reasons; it omits credentials, URLs, hashes, GUIDs, and raw queue messages.

A confirmed intent can link to one unique, fresh, healthy physical job whose direct Sonarr/Radarr IDs cover all remaining captured targets. The link is monitoring evidence; it does not prove submission provenance, torrent contents, or import. Missing jobs after the appearance grace period, disappeared linked jobs, and unhealthy or ambiguous observations go to review while captured holds and successful dedupe records are preserved. Work is fulfilled only after the library reports `hasFile`.

Resolve a hold with `ma_review_action`; resolving permits normal reconciliation to resume—there is no separate retry action or UI. For an explicit human release choice, `ma_pick` is a fresh, guarded manual pick. A matching-season-only pack may proceed with explicitly labeled inferred coverage; it is not proof that the torrent contains every missing episode.

`ma_pick`'s `releaseIndex` selects from a candidate list built fresh on every call (planner queries → Prowlarr search → guardrail filtering → seeders sort → cap). The list is not stable across calls and nothing is reserved. A dry-run call does not pin an index for later. Check the returned `releaseTitle` to see what was selected; outcomes include `grabbed`, `dry-run`, `missing-download-client`, and `reverify-failed`. An index from `ma_search` raw results does not transfer.

For the separate opt-in administrative recovery lane, see [operator recovery](operator-recovery.md). `allowOperatorActions` defaults to `false` in the UI, and host approval is required for every MCP call if enabled. The lane does not search, grab, invoke an LLM, or call the normal runner.

## HTTP and MCP interfaces

| Endpoint | Purpose |
|---|---|
| `GET /health` | Liveness response |
| `GET /api/settings` | Full settings document and readiness/scheduler status |
| `PUT /api/settings` | Validate and atomically persist the complete settings document |
| `POST /cycle` | Trigger one full cycle (unauthenticated; may incur LLM/indexer activity) |

| MCP stdio tool | Purpose |
|---|---|
| `ma_status` | Config-safe status, review count, and work-queue state |
| `ma_cycle` | Run one full cycle |
| `ma_review_list` | List manual-review rows |
| `ma_review_action` | Resolve a review; optional operator recovery actions require explicit opt-in and fresh evidence |
| `ma_search` | Search Prowlarr and return URL-free release summaries |
| `ma_pick` | Manually select a fresh candidate; guardrails and the dry-run safety check still apply |

## SQLite, backups, and idempotence

`DB_PATH` defaults to `data/media-agent.db` under `./data`, which Compose bind-mounts. To make a filesystem copy, stop the daemon and every separate MCP/operator/CLI process or other writer, then back up the entire `data/` directory, retaining SQLite `-wal`/`-shm` sidecars. Do not copy only the main database file while any connection may be writing. Alternatively, use SQLite's backup API with a deliberate consistent snapshot. See [publishing](publishing.md) for rollback and schema-compatibility cautions.

Durable `(indexerId, guid)` release identity plus seen-infoHash dedupe is used when a hash is available; hashless releases have weaker cross-indexer detection. A decided work unit is not re-attempted until its retry window is due; indexer `429` and `Retry-After` are honored. Do not clear SQLite state to force retries.

## Troubleshooting

- **DB permission error on Linux:** the container's `node` user is UID 1000. If `./data` was pre-created as another user or auto-created root-owned, fix ownership deliberately, for example `sudo chown 1000:1000 data`, then restart.
- **Arr imports do not appear:** verify the Prowlarr download-client entry/category, Sonarr/Radarr client category, root folder, and Completed Download Handling. Media Scout does not write directly to the download client or library.
- **Repeatedly reaching `/cycle` from the LAN:** the default mapping is loopback-only because the endpoint is unauthenticated and can trigger paid LLM cycles/searches. Do not widen the bind address without a separately reviewed access-control design.
- **Operator recovery:** read [operator recovery](operator-recovery.md) before enabling `allowOperatorActions` in the UI; do not release a reservation based on an empty *arr queue alone.
