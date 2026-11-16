# Media Scout

Media Scout turns a natural-language request into bounded Prowlarr searches and ranked release alternatives. Search is separate from explicit download submission; Sonarr/Radarr automation is optional.

Prowlarr provides indexer search and routed submissions. Sonarr/Radarr supply library and queue observations for optional automation.

> [!WARNING]
> Media Scout is in early development and breaking changes should be expected. If that concerns you, pin a specific image version rather than following `latest`.

## Quickstart

```sh
git clone https://github.com/aberiggs/media-scout.git
cd media-scout
mkdir -p data
export MEDIA_AGENT_IMAGE=ghcr.io/aberiggs/media-scout:latest
docker compose -f docker-compose.ghcr.yml pull
docker compose -f docker-compose.ghcr.yml up -d
```

This pulls and runs the published image (it does not build from source). Open <http://127.0.0.1:7877/> to configure the app. Compose v2.24 or later is required.

For a fixed image, use a `sha-<full-commit-sha>` tag or an image digest. There are no semver release tags.

## Setup and safety

- Prowlarr with configured indexers and enabled download clients, and an LLM API endpoint, are needed for searching. Sonarr/Radarr are optional.
- Settings, including integration credentials, are stored in SQLite under `./data`; protect that directory and its backups as secrets. Monitoring starts disabled and dry-run enabled. Dry-run prevents download submission, but searches can still incur indexer and LLM costs.
- The web interface and API have no authentication. The supplied Compose files bind to loopback; expose them only on trusted networks.
- On Linux, if the container cannot write its database, ensure `data/` exists and is writable by UID 1000 (`node` in the image). For example, `sudo chown 1000:1000 data` changes ownership of that directory only.

Configure Prowlarr, LLM, and optional Arr connection details in the web UI. For Arr automation, configure download-client categories consistently between Prowlarr and Sonarr/Radarr, then enter the exact Prowlarr client names in Media Scout.

## Develop from source

See [source development and checks](src/README.md). The default `docker-compose.yml` builds the source image; use `docker-compose.ghcr.yml` explicitly for the published image.

Licensed under [MIT](LICENSE).
