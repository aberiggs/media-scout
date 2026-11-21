# Media Scout

Media Scout turns a natural-language request into bounded Prowlarr searches and a versioned release-set plan. Manual search is read-only until you confirm the set. Optional Sonarr/Radarr automation can search and submit a stored set under your saved settings.

Prowlarr provides indexer search and routed submissions. Sonarr/Radarr supply library and queue observations for optional automation.

> [!WARNING]
> Media Scout is in early development and breaking changes should be expected. If that concerns you, pin a specific image version rather than following `latest`.

## Quickstart

```sh
docker pull ghcr.io/aberiggs/media-scout:latest
docker run -d \
  --name media-scout \
  --restart unless-stopped \
  -p 127.0.0.1:7877:7877 \
  -v media-scout-data:/app/data \
  ghcr.io/aberiggs/media-scout:latest
```

With Docker installed, these commands pull and run the published image—no clone or source build needed. Open <http://127.0.0.1:7877/> to configure the app. Docker creates the named volume `media-scout-data` to persist settings and history.

For a fixed image, replace `ghcr.io/aberiggs/media-scout:latest` in both commands with `ghcr.io/aberiggs/media-scout:sha-<full-commit-sha>` or an image digest. There are no semver release tags.

### Moving from the old database

This release requires a fresh database. Set `DB_PATH=data/media-scout-agent.db` in your Compose `.env` (or add `-e DB_PATH=data/media-scout-agent.db` when recreating the Docker container). The path is inside the existing data mount. The app refuses older database formats without modifying them; do not copy the old database to the new path. Re-enter your integrations and preferences in Settings. Old search history, receipts, and pending work are not carried over. Check your existing downloads in Arr and your download client before opting back into automation.

## Setup and safety

- Prowlarr with configured indexers and an LLM API endpoint are needed for searching. Sonarr/Radarr are optional context providers.
- Settings, including integration credentials, are stored in SQLite in the data volume; protect that volume and its backups as secrets. Monitoring starts disabled. Dry-run records receipts without submitting downloads; searches can still incur indexer and LLM costs.
- The web interface and API have no authentication. The quickstart binds to loopback; expose it only on trusted networks.

Configure Prowlarr, LLM, and optional Arr connections in the web UI. In **Settings → Automation and retries**, choose the TV and/or movie download client and set any preferences for scheduled searches. Enable monitoring for scheduled searches. Automatic downloads additionally require **Allow automatic downloads** and dry-run off. A fresh database starts with dry-run on and both monitoring and automatic downloads off. **Refresh Arr observations** never starts a search or download.

Each scheduled search lists the show's actionable episodes across seasons, or one movie, and adds the saved automation preferences to the prompt. Manual Search uses one prompt for the request and any preferences; open a saved result to see its full prompt. After a submitted or possibly submitted download, Scout waits for Arr to see it before researching that title again (30 minutes by default). Scout does not inspect or repair qBittorrent downloads or Arr imports.

Manual confirmation uses an explicit Prowlarr download client, its configured
category routing, and the saved dry-run setting. Expired candidates require a new
search. Durable receipts distinguish accepted submissions, partial failure,
uncertain sends and releases not attempted; accepted does not mean downloaded or
imported. Interrupted/uncertain sets are never automatically replayed.

### Optional research tools

1. In **Settings → Optional research services**, paste the exact Streamable HTTP MCP URL reachable from Media Scout and choose **Connect**. For a self-hosted CRW server on a shared container network, this could be `http://crw:3000/mcp`. Do not put credentials in the URL.
2. Optionally configure bearer auth using the `Authorization` header and `Bearer <token>` value, or a supported custom header. Connecting verifies the server and makes its usable tools available to the planner; there is no separate discovery or per-tool approval step.
3. The planner uses suitable tools when they can improve search terms or clarify evidence that could change the selection, such as an anime batch with unclear season numbering. Missing or unavailable research tools do not block Prowlarr searches.

Connecting trusts the server: every usable tool it exposes may be called by the model, and model-authored tool arguments can include the search request/context. Use only trusted services. Credentials are stored in SQLite and hidden from Settings readbacks. The integration supports Streamable HTTP and static headers, not stdio, OAuth, or credential-bearing URLs. Redirects are rejected; metadata and link-local destinations are blocked while localhost and trusted private LAN endpoints are supported.

## Search execution

Search jobs require the daemon's bound internal Streamable HTTP MCP route. The standalone stdio MCP adapter can read status/history, but cannot start a search when no daemon HTTP listener exists. The backend refuses instead of launching a second listener or alternate engine.

## Develop from source

See [source development and checks](src/README.md). The default `docker-compose.yml` builds the source image; use `docker-compose.ghcr.yml` explicitly for the published image.

Licensed under [MIT](LICENSE).
