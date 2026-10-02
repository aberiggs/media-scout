# Setup and configuration

Media Scout is an early-stage homelab application. This guide starts its own container; it does not deploy or alter your other applications.

The runtime still uses existing `media-agent` service, configuration, file, and MCP identifiers; the public project/display name is Media Scout.

## Requirements

- Docker Engine and Docker Compose v2.24 or later. The Compose files use an optional `.env` declaration supported by Compose 2.24+.
- For automated monitoring: reachable Sonarr and Radarr instances, Prowlarr, a torrent client configured in Prowlarr, and an LLM API endpoint. Sonarr/Radarr libraries, quality profiles, and root folders should already be configured.
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

Settings default to monitoring disabled and dry-run enabled. Dry-run prevents actual grabs, but search/planning may still contact indexers and call the configured LLM; see [operations and safety](operations.md) before starting cycles or enabling monitoring.

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

Open <http://localhost:5173/>. Vite proxies `/api`, `/health`, and `/cycle` to the backend on port 7877. For a local production-style run, build with `npm run web:build`, then start the daemon; Fastify serves `web/dist`.

## MCP stdio

Run the MCP server inside a source-build container:

```sh
docker exec -i <container-name> node_modules/.bin/tsx src/mcp/server.ts
```

It shares SQLite state with the daemon. Stop the daemon and every MCP, CLI, and other database writer before a filesystem backup. The server uses stdio and has no built-in user identity/authentication; review the host's tool-approval policy, especially for `ma_review_action` and `ma_pick`. The unauthenticated HTTP API is also loopback-bound by default. See [operations and safety](operations.md) and [operator recovery](operator-recovery.md).
