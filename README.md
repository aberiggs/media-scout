# Media Scout

Turn a plain-language request into a release set using Prowlarr and an LLM. Review the proposed releases before downloading, or use optional Sonarr/Radarr monitoring to search for missing media on a schedule.

## Install

```sh
docker run -d \
  --name media-scout \
  --restart unless-stopped \
  -p 127.0.0.1:7877:7877 \
  -v media-scout-data:/app/data \
  ghcr.io/aberiggs/media-scout:latest
```

Open <http://127.0.0.1:7877/>. The volume keeps SQLite settings and history across container replacements. Protect the volume and its backups: they contain integration credentials. The UI and API have **no authentication**. Keep the loopback binding unless you've secured access; never expose Scout directly to the internet.

Media Scout is in early development. To avoid unexpected changes, pin `ghcr.io/aberiggs/media-scout:sha-<full-commit-sha>` or an image digest rather than `latest`. For Compose, use [`docker-compose.ghcr.yml`](docker-compose.ghcr.yml) with `MEDIA_AGENT_IMAGE` set to the desired image; the default [`docker-compose.yml`](docker-compose.yml) builds from source. Both Compose files bind-mount `./data`: create it before starting and make sure the container user (UID 1000) can write to it.

> [!WARNING]
> If you're upgrading from an unsupported older database format, Scout refuses to start and leaves the old file untouched. Keep that database as a backup and point `DB_PATH` at a new file inside the data mount, for example `data/media-scout-agent.db` in the Compose `.env` or `-e DB_PATH=data/media-scout-agent.db` when recreating the container. Do not copy the old database to the new path. Re-enter settings; old history, receipts, and pending work won't carry over. Check existing Arr and download-client jobs before re-enabling automation. New installs can use the default path.

## Configure

1. In **Settings**, enter your Prowlarr URL and API key (with indexers already configured in Prowlarr), and your LLM API key, model, and Responses API base URL. Use URLs reachable **from the container**; `localhost` inside it is the container itself.
2. For scheduled searches, add Sonarr and/or Radarr. Save the Prowlarr connection before selecting TV or movie download clients for automation.
3. Optionally connect a trusted Streamable HTTP MCP endpoint under **Optional research services**. The model may call any usable tool there and pass search context in its arguments. Don't embed credentials in the URL; use the credential field. See [research service behavior and timeouts](src/search/README.md#optional-external-research-mcps).

If Prowlarr is behind a reverse proxy, give it at least five minutes of read timeout for Scout's indexer searches.

## Use safely

- **Manual search** is read-only. Describe what you want in **Search**, then review the set, coverage, and gaps. Submitting requires an explicit download client and confirmation of the whole set. Expired candidates require a new search.
- **Dry-run** starts on and prevents submissions, but model and indexer requests still run and can incur costs. Monitoring and automatic downloads both start off.
- To enable scheduled searches, turn on **Automatic monitoring** under **Settings → Automation and retries**. To allow scheduled submissions, also select the applicable TV/movie client, turn on **Allow automatic downloads**, and turn dry-run off. **Refresh Arr observations** does not start searches or downloads.
- **Submitted** means Prowlarr accepted the request, not that the release downloaded or imported. Review receipts and check Arr and your download client before retrying anything uncertain. Scout never replays an interrupted or uncertain submission; later scheduled searches against fresh Arr observations can still find and select the same release.

[Source setup and checks](src/README.md) · [Search, automation, and API reference](src/search/README.md) · [MCP stdio setup](src/mcp/README.md) · [MIT license](LICENSE)
