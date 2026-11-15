# Media Scout

LLM-assisted release search and selection. Media Scout turns a natural-language request into bounded Prowlarr searches and ranked alternatives. Search is separate from explicit download submission; Arr-based automation is optional.

Prowlarr provides indexer search and routed submissions. Sonarr/Radarr supply current library and queue observations for optional automation. New installs use a fresh search database; existing tracking-engine databases are refused, not migrated. It's an early-stage homelab project; broader ideas are on the [ideas list](docs/future-features.md).

## Get started

From a checkout, run:

```sh
mkdir -p data
docker compose up -d --build
```

Open <http://127.0.0.1:7877/> to configure the app. Monitoring starts disabled and dry-run starts enabled.

See [setup and configuration](docs/setup.md) for prerequisites, Docker details, and building from source. Read [operations and safety](docs/operations.md) before enabling live downloads.

## Project notes

- [Development](docs/development.md) — Ubuntu bootstrap and verification commands.
- [Feedback triage](docs/feedback-triage.md) — investigated concerns and links to the GitHub backlog.
- [Future features](docs/future-features.md) — high-level ideas under consideration, not commitments.
- [Operator recovery](docs/operator-recovery.md) — current finite retry behavior and deliberate fresh-database rollback.
- [Publishing](docs/publishing.md) — development-image publishing and rollout notes.

Licensed under [MIT](LICENSE).
