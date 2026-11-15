# Setup and configuration

Media Scout is an early-stage homelab application. This guide starts its own container; it does not deploy or alter your other applications.

The runtime keeps the `media-agent` container/service identifier. The v2 search interface is new; there is no migration or compatibility layer for the former tracking engine.

## Requirements

- Docker Engine and Docker Compose v2.24 or later. The Compose files use an optional `.env` declaration supported by Compose 2.24+.
- For standalone searching/submission: reachable Prowlarr with indexers and enabled download clients, plus an LLM API endpoint. For TV/movie automation, configure the corresponding Sonarr/Radarr services and libraries.
- Node.js 22+ is only needed for host-side source development or MCP use; it is not needed to run the container.

## Start from source with Compose

Clone the repository, then run:

```sh
git clone https://github.com/aberiggs/media-scout.git
cd media-scout
mkdir -p data
docker compose up -d --build
```

The Compose file builds the app and web UI from the checkout and stores SQLite data/settings in the host `./data` directory. On Linux, if the container cannot write there, the runtime `node` user is UID 1000; fix ownership deliberately with `sudo chown 1000:1000 data`. This is often unnecessary on Docker Desktop; do not recursively change ownership unless needed.

Open <http://127.0.0.1:7877/> for the UI. Check liveness and logs with:

```sh
curl --fail http://127.0.0.1:7877/health
docker compose logs -f media-agent
```

No `.env` is required. The optional `.env.example` documents bootstrap-only overrides (`DB_PATH`, `HTTP_PORT`, `HTTP_HOST`, and `LOG_LEVEL`). Do not commit a real `.env`. If you change `HTTP_PORT`, Compose keeps the container listener and published host port synchronized.

## Configure the existing services

Enter integration URLs, API keys, Prowlarr download-client names, and LLM settings in the local UI and save. These settings are stored in SQLite, not in the Compose environment; treat `./data` and its backups as secrets. The UI/API returns saved API keys for local reveal/copy workflows, so do not expose it to untrusted networks.

Before enabling monitoring, prepare the *arr/Prowlarr routing:

1. Enable Completed Download Handling in Sonarr and Radarr. Their download-client categories must match the categories configured in Prowlarr. Example categories are `tv-sonarr` and `radarr`.
2. In Prowlarr, configure download-client entries routed to the intended torrent client, for example `qBit-TV` with category `tv-sonarr` and `qBit-Movies` with category `radarr`. Enter the exact entry names in the UI; the names themselves are arbitrary.
3. Review Prowlarr application sync before changing indexer configuration. Synced indexers can let Sonarr/Radarr continue their own searches; removing them can change existing search/RSS behavior. Make such changes manually only if intended. Media Scout does not edit those applications or remove indexers.
4. Verify Prowlarr can route grabs through the intended entries and that *arr root folders, categories, and Completed Download Handling are set up for the media you expect to import.

Settings default to monitoring disabled and dry-run enabled. Dry-run prevents grab POSTs, but searches may still contact indexers and call the configured LLM; see [operations and safety](operations.md) before searching or enabling monitoring.

## Local web development

Install dependencies from the repository root:

```sh
npm ci
npm run web:install
```

Start the backend in one terminal and Vite in another:

```sh
npx tsx src/daemon.ts
```

```sh
npm run web:dev
```

Open <http://localhost:5173/>. Vite proxies `/api` and `/health` to the backend on port 7877. For a local production-style run, build with `npm run web:build`, then start the daemon; Fastify serves `web/dist`.

## MCP stdio

Run the MCP server inside a source-build container:

```sh
docker exec -i <container-name> node_modules/.bin/tsx src/mcp/server.ts
```

It shares SQLite state with the daemon. Stop the daemon and every MCP or other database writer before a filesystem backup. The server uses stdio and has no built-in user identity/authentication; require host approval for `ma_submit_v2` and `ma_automation_poll_v2`. The unauthenticated HTTP API is loopback-bound by default. See [operations and safety](operations.md) and [operator recovery](operator-recovery.md).
# Search-first database boundary

The fresh search runtime uses `DB_PATH=data/media-scout-search.db` by default. Stop existing writers before switching versions. Existing nonempty legacy databases are refused without modification; there is no migration and no need to delete the old database. Configure connections and preferences in Settings; monitoring starts disabled and dry-run starts enabled. Normal restarts retain search and submission state. Keep the old database and matching binary for rollback. Changing paths does not undo external downloads; account for them before starting the prior runtime. Never run old and new writers together.
