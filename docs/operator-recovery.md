# Operator recovery

The former tracking engine's review, reservation-release, queue-association, Retry/Reset, and interactive operator CLI recovery lane was removed by the approved search-first replacement (#24). There are no compatibility stubs, migration path, or manual release controls in the current runtime. Do not use old recovery instructions or clear an existing database to force an upgrade.

Current recovery is observation-driven: correct the upstream Sonarr/Radarr/Prowlarr/download-client issue, then let a fresh poll observe it. Automation retries are finite (ordinary no-match defaults to six hours; transport/model failures back off from five to sixty minutes, with upstream `Retry-After` honored). Submitted/uncertain targets have a 30-minute persisted appearance grace. When it expires, fresh Arr reads and queue coverage determine eligibility; Scout does not require a human to release a permanent hold and does not cancel an external download.

For a failed or ambiguous submission, inspect the Prowlarr/download-client and Arr state directly. The same idempotency key will not resend a POST; a new attempt should follow the documented finite grace/backoff and fresh-state rules. Search results and successful submission responses are not proof of download or import.

## Fresh database and rollback

The current default is `data/media-scout-search.db`. A nonempty legacy database is refused without modification. Point the replacement at a separate fresh path; do not delete, copy, or migrate the old database. To roll back, stop every writer and restore the prior binary with its matching pre-upgrade database backup/path. External downloads remain external and are not undone by database restore; account for them before restarting old automation. See [operations and safety](operations.md#database-backup-and-rollback) and [publishing](publishing.md#6-database-backup-and-rollback).

Current manual interfaces are documented in [operations](operations.md#http-and-mcp); submission and automation-poll MCP calls are side-effecting and require host-level approval. No recovery command or local override bypasses those boundaries.
