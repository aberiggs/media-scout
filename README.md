# Media Scout

LLM-assisted torrent searching and release picking. Media Scout helps turn what you're looking for into indexer searches, evaluates the results, and selects suitable releases.

Currently, it uses Prowlarr for searching and downloading, with Sonarr/Radarr supplying missing-media requests. It's an early-stage homelab project; broader search workflows are on the [ideas list](docs/future-features.md).

## Get started

From a checkout, run:

```sh
mkdir -p data
docker compose up -d --build
```

Open <http://127.0.0.1:7877/> to configure the app. Monitoring starts disabled and dry-run starts enabled.

See [setup and configuration](docs/setup.md) for prerequisites, Docker details, and building from source. Read [operations and safety](docs/operations.md) before enabling live downloads.

## Project notes

- [Future features](docs/future-features.md) — high-level ideas under consideration, not commitments.
- [Operator recovery](docs/operator-recovery.md) — details for the opt-in administrative recovery lane.
- [Publishing](docs/publishing.md) — development-image publishing and rollout notes.

Licensed under [MIT](LICENSE).
