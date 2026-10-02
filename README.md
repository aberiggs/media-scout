# Media Scout

Media Scout is an LLM-assisted Sonarr/Radarr search-and-pick sidecar. It reads monitored missing items from Sonarr and Radarr, plans Prowlarr searches, applies deterministic TV coverage guardrails, and uses an LLM to judge plausible identity and quality. Searches go through Prowlarr; the agent does not send Sonarr/Radarr command-based search requests. A selected torrent is submitted through Prowlarr using the configured download-client entry; Sonarr/Radarr Completed Download Handling (CDH) remains responsible for import and library management.

It does **not** replace Sonarr, Radarr, Prowlarr, or a torrent client. Jellyfin can continue scanning the *arr-managed libraries. Jellyseerr/Seerr can continue its existing direct-to-*arr request flow, but a Seerr API shim is not implemented. There is no web UI. A future direction may be more interactive AI-assisted media discovery; that experience is not shipped here.

This is an early, development-stage homelab project, not a stable release or production-readiness claim. See [Publishing](docs/publishing.md) for the current dev-only image process. Licensed under [MIT](LICENSE).

**Name compatibility:** Media Scout is the public project/display name. The Compose service (`media-agent`), configuration keys, file paths, container commands, and MCP tool names retain their existing `media-agent` identifiers; this documentation does not rename runtime interfaces.

Repository: [github.com/aberiggs/media-scout](https://github.com/aberiggs/media-scout).

## Requirements and preparation

- Docker Engine and Docker Compose v2. Node.js 22+ is needed for source development and host-side MCP use, not for the container quickstart.
- Existing, reachable Sonarr and Radarr instances, with their libraries, quality profiles, and **root folders** already configured.
- Existing Prowlarr with the desired torrent indexers and a torrent client configured **in Prowlarr**. Prowlarr must be able to reach that client.
- API keys for Prowlarr, Sonarr, Radarr, and the configured LLM endpoint. Treat these as secrets; keep them in the gitignored `.env`, not in command history, screenshots, or issues.
- Optional: Jellyfin may continue to scan the *arr-managed libraries. Jellyseerr/Seerr is not required and is not directly integrated by this project.

Before starting the agent, configure the surrounding applications deliberately:

1. In Sonarr and Radarr, enable **Completed Download Handling**. Ensure their configured download-client categories match the categories you choose in Prowlarr. The examples are `tv-sonarr` for Sonarr and `radarr` for Radarr.
2. In Prowlarr, configure two download-client entries pointing to the intended torrent client, for example `qBit-TV` with category `tv-sonarr` and `qBit-Movies` with category `radarr`. The entry names are arbitrary; the categories must match the *arr clients. Put the exact names in `PROWLARR_CLIENT_TV` and `PROWLARR_CLIENT_MOVIE`.
3. **Review Prowlarr application sync before changing indexer configuration.** Sonarr/Radarr should not run their own searches through synced Prowlarr indexers when Media Scout is intended to own search. Removing synced indexers can change existing *arr search/RSS behavior. Make that change manually only if intended; Media Scout and its Compose files never edit the existing applications or remove indexers for you.
4. Verify Prowlarr can route grabs through the intended download-client entries, and that Sonarr/Radarr root folders and CDH are set up for the media you expect to import.

## Quickstart: build from source

```sh
git clone https://github.com/aberiggs/media-scout.git
cd media-scout
```

Review the cost/safety note below before starting: `DRY_RUN=true` prevents grabs, **not** LLM calls or Prowlarr searches.

```sh
cp .env.example .env
# Edit .env with service URLs, API keys, exact Prowlarr client names, and preferences.
mkdir -p data
# On Linux, only if needed: the container's node user is UID 1000.
# sudo chown 1000:1000 data
docker compose up -d --build
```

The supplied `docker-compose.yml` builds the image from this checkout and bind-mounts `./data` for SQLite state. The Linux ownership command may be unnecessary on Docker Desktop; do not recursively change ownership unless required. Check liveness on the loopback-only health endpoint:

```sh
curl --fail http://127.0.0.1:7877/health
docker compose logs -f media-agent
```

`.env.example` documents the config surface. Compose passes `.env` to the container; do not commit your filled-in `.env`.

### Published GHCR image (alternative)

After the image has first been published, set `MEDIA_AGENT_IMAGE` in `.env` to `ghcr.io/aberiggs/media-scout:dev` and use the standalone published-image Compose file:

```sh
docker compose -f docker-compose.ghcr.yml pull
docker compose -f docker-compose.ghcr.yml up -d
```

This file does not build from source. GHCR packages are private by default, even when the GitHub repository is public; the maintainer must explicitly make the package public for anonymous pulls, or authenticate to GHCR. See [docs/publishing.md](docs/publishing.md). The dev image is not a stable release and is not automatically deployed to your host.

## Cost and safety before the first cycle

`DRY_RUN` defaults to `true`. It blocks the actual grab, but a normal due-work cycle can still call the LLM planner/picker and search Prowlarr. Those operations may incur model-provider charges, use indexer quota, and contact configured indexers. The daemon schedules cycles at `CYCLE_INTERVAL_MIN` (default 5 minutes); planning/search is gated by each work unit's due time, not by a guarantee that each interval is free. `POST /cycle`, `ma_cycle`, and `ma_search` can trigger network work when called.

The container port is bound to `127.0.0.1` by default. `POST /cycle` has **no authentication**; do not expose it to a LAN or the internet without a separately reviewed access-control layer. MCP uses stdio and has no built-in user identity/authentication. Review the host's tool approval policy, especially for `ma_review_action` and `ma_pick`.

Keep `DRY_RUN=true` while verifying configuration and reviewing logs. Dry runs may persist ordinary scheduling and decision state, but do not create active grab intents or successful-grab dedupe markers. Do not clear SQLite state to force retries. Only consider `DRY_RUN=false` after an operator has reviewed real candidates and routing; this setting is not a substitute for an import test or operator review.

## How selection works

- The watcher reads Sonarr/Radarr libraries and tracked queues. Search eligibility is per work unit and retry-window gated.
- The LLM plans Prowlarr queries and is the judge of fuzzy identity and quality; deterministic code does not add title/quality matching heuristics.
- TV guardrails require explicit episode coverage or a single matching-season-only pack claim. Inferred pack coverage is labeled inferred, not proof of torrent contents. Known wrong seasons and malformed/conflicting scopes are rejected.
- The picker sees at most the runner's **100** candidates. `MEDIA_PREFERENCES` is optional soft ranking guidance, not a filter, identity rule, or override of guardrails.
- Successful real grabs are deduplicated by `(indexerId, guid)` and infoHash when available. Hashless releases have weaker cross-indexer detection. Dry runs and failed grabs do not create successful-grab markers.
- Unparseable/ambiguous candidates, searches with no admitted candidates, and repeated ordinary operational failures can enter manual review. Unknown, paused, active, import-blocked, uncertain, or ambiguous queue evidence remains held rather than being automatically resubmitted.

For example, optional plain-language ranking guidance may be set in `.env`:

```dotenv
MEDIA_PREFERENCES=Prefer 1080p over 4K.
```

It is guidance only. After changing `.env`, recreate the container with `docker compose up -d --force-recreate`.

## Interfaces

### Daemon HTTP

| Endpoint | Purpose |
|---|---|
| `GET /health` | Liveness/config-safe health response |
| `POST /cycle` | Trigger one full cycle (unauthenticated; may incur LLM/indexer activity) |

### MCP stdio

| Tool | Purpose |
|---|---|
| `ma_status` | Config-safe status, review count, and work-queue state |
| `ma_cycle` | Run one full cycle |
| `ma_review_list` | List manual-review rows |
| `ma_review_action` | Resolve a review; optional operator recovery actions require explicit opt-in and fresh evidence |
| `ma_search` | Search Prowlarr and return URL-free release summaries |
| `ma_pick` | Manually select a fresh candidate; guardrails and the `DRY_RUN` chokepoint still apply |

Run the stdio server inside the source-build container:

```sh
docker exec -i <container-name> node_modules/.bin/tsx src/mcp/server.ts
```

The MCP process and daemon share the SQLite database. State claims serialize cross-process work, but stop **all** daemon, MCP, CLI, and other database writers before a filesystem backup. For `ma_review_action` operator recovery, see [docs/operator-recovery.md](docs/operator-recovery.md); `ALLOW_OPERATOR_ACTIONS` defaults to `false`, and host approval is required for every MCP call if enabled. The operator lane does not search, grab, invoke an LLM, or call the normal runner.

## Operations

- **Cadence versus paid searches:** `CYCLE_INTERVAL_MIN` (default 5) is the reconciliation cadence, not a promise to call the planner every five minutes. A picker `skip` or dry-run decision is cooled down by `MIN_RETRY_HOURS` (default 6). A successful search with no candidate admitted by guardrails instead creates a `no-suitable-release` manual hold; it is not an LLM picker skip. Only work whose next-search time is due is eligible for another paid plan/search.
- **Failure and queue holds:** `FAILURE_BACKOFF_MIN`/`FAILURE_BACKOFF_MAX_MIN` default to 5/60 minutes and cap exponential failure delay; a longer upstream `Retry-After` takes precedence. The third consecutive ordinary operational failure enters manual review; rate limits stay on backoff and do not escalate solely due to quota. Diagnostics include safe stage, error code/type, HTTP status, and retry seconds, not exception messages, response bodies, or authenticated URLs. `QUEUE_GRACE_MIN` defaults to 30 minutes for a submitted job to appear in the tracked *arr queue; it is an appearance deadline, not a download-duration limit. `ma_status` exposes safe queue counts, next-search times, coverage IDs, freshness, and coarse hold reasons; it omits credentials, URLs, hashes, GUIDs, and raw queue messages.
- **Queue association is monitoring evidence:** a confirmed intent can link to one unique, fresh, healthy physical job whose direct Sonarr/Radarr IDs cover all remaining captured targets. The link does not prove submission provenance, torrent contents, or import. Missing jobs after the appearance grace period, disappeared linked jobs, and unhealthy or ambiguous observations go to review while captured holds and successful dedupe records are preserved. Work is fulfilled only after the library reports `hasFile`.
- **Manual review:** resolve a hold through `ma_review_action`; resolving it permits normal reconciliation to resume—there is no separate retry action or UI. When a human wants to choose a release, explicit `ma_pick` remains a fresh, guarded manual pick. A matching-season-only pack may proceed with explicitly labeled inferred coverage; it is not proof that the torrent contains every missing episode.
- **`ma_pick` index contract:** `releaseIndex` selects from the candidate list built fresh on every call (planner queries → Prowlarr search → guardrail filtering → seeders sort → cap). That list is not stable across invocations, and nothing is reserved. A dry-run call does not pin an index for later. Check the returned `releaseTitle` to see what was actually selected; outcomes include `grabbed`, `dry-run`, `missing-download-client`, and `reverify-failed`. An index from `ma_search`'s raw results does not transfer.
- **SQLite state and backups:** `DB_PATH` defaults to `data/media-agent.db` under `./data`, which Compose bind-mounts. To make a filesystem copy, stop the daemon **and every separate MCP/operator/CLI process or other writer**, then back up the entire `data/` directory, retaining any SQLite `-wal`/`-shm` sidecars. Do not copy only the main database file while any connection may be writing. Alternatively, use SQLite's backup API with a deliberate consistent snapshot. See [docs/publishing.md](docs/publishing.md) for rollback and schema-compatibility cautions.
- **Idempotence:** durable `(indexerId, guid)` release identity plus seen-infoHash dedupe when a hash is available; hashless releases have weaker cross-indexer detection. A decided work unit is not re-attempted until its retry window is due; indexer `429` and `Retry-After` are honored.

## Troubleshooting

- **DB permission error on Linux:** the container's `node` user is UID 1000. If `./data` was pre-created as another user or auto-created root-owned, fix ownership deliberately, for example `sudo chown 1000:1000 data`, then restart.
- **Arr imports do not appear:** verify the correct Prowlarr download-client entry/category, Sonarr/Radarr client category, root folder, and CDH settings. Media Scout does not write directly to the download client or the library.
- **Repeatedly reaching `/cycle` from the LAN:** the default mapping is loopback-only because the endpoint is unauthenticated and can trigger paid LLM cycles/searches. Do not widen the bind address without a separately reviewed access-control design.
- **Operator recovery:** read [docs/operator-recovery.md](docs/operator-recovery.md) before enabling `ALLOW_OPERATOR_ACTIONS`; do not release a reservation based on an empty *arr queue alone.

## License

MIT. See [LICENSE](LICENSE).
