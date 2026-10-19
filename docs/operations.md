# Operations and safety

This reference describes current behavior; it is not a guarantee that every cycle searches or that a result will be imported.

## Costs, network access, and safe rollout

`dryRun` defaults to `true`. It blocks an actual grab, but a normal due-work cycle can still call the LLM planner/picker and search Prowlarr. Those operations may incur model-provider charges, use indexer quota, and contact configured indexers. Monitoring defaults to disabled; when enabled, cycles use the configured interval. Planning/search is gated by each work unit's due time, not a guarantee that each interval is free. `POST /cycle`, `ma_cycle`, and `ma_search` can trigger network work.

The container is bound to `127.0.0.1` by default. `POST /cycle` has no authentication; do not expose the UI/API to a LAN or the internet without a separately reviewed access-control layer. MCP uses stdio without built-in user identity/authentication; review the host tool-approval policy, especially for `ma_review_action` and `ma_pick`.

Keep dry-run enabled while checking configuration and reviewing logs. Dry runs may persist ordinary scheduling and decision state, but do not create active grab intents or successful-grab dedupe markers. Only consider disabling dry-run after an operator has reviewed real candidates and routing. It is not a substitute for an import test or operator review.

## Search, selection, and review

- The watcher reads Sonarr/Radarr libraries and tracked queues. TV availability retries are per episode; the season entry groups planning and progress. Movie and operational-failure scheduling retain their work-unit retry gates.
- TV episode eligibility prefers Sonarr's valid UTC `airDateUtc`. When it is absent or unusable, a valid `airDate` calendar day becomes eligible at midnight UTC on the following day; an absent or invalid date and timestamp remain timing-unknown and are not searched. Exact airtime overrides a conflicting calendar date.
- The LLM plans Prowlarr queries and judges fuzzy identity and quality; deterministic code does not add title/quality matching heuristics.
- Planner context distinguishes season airing confidence, imported/known aired missing/future/timing-unknown episodes, normalized eligibility times, and actual download-held coverage. A continuing series does not imply that each season is airing; no known future episode is not proof a season finished. One or two due TV episodes use explicit episode-first searches. A substantial backlog (three or more due episodes in the group) tries pack/batch searches first, then explicit episode fallback for uncovered targets when capacity remains. A missing or rejected pack does not by itself prove individual episodes unavailable.
- Each grouped acquisition pass permits up to three primary and three fallback queries, and at most three distinct physical releases. Fallback excludes provisionally selected coverage and manual identity holds; the complete non-overlapping selection is validated before any POST and each submission uses a fresh library/queue check. Episode queries have exact validated target attribution. Unattempted capacity-deferred episodes stay due and are prioritized by oldest attempt time, then stable episode identity, across restarts. All applicable source backoff and safety holds still apply.
- TV guardrails require explicit episode coverage or a single matching-season-only pack claim. Inferred pack coverage is labeled inferred, not proof of torrent contents. Known wrong seasons and malformed/conflicting scopes are rejected.
- The picker sees at most 100 candidates. Media preferences are optional soft ranking guidance, not a filter, identity rule, or override of guardrails. For example, `Prefer 1080p over 4K.` can be entered in the UI. Saved settings apply to subsequent operations without container recreation.
- Successful real grabs are deduplicated by `(indexerId, guid)` and infoHash when available. Hashless releases have weaker cross-indexer detection. Dry runs and failed grabs do not create successful-grab markers.
- Unparseable/ambiguous candidates and repeated ordinary operational failures can enter manual review. An ordinary search with no admitted release schedules a retry only for already-eligible content; unreleased movies and future episodes wait for source metadata. Unknown, paused, active, import-blocked, uncertain, or ambiguous queue evidence remains held rather than being automatically resubmitted.

## Cadence and failure behavior

- The UI interval defaults to 5 minutes and has a maximum of 35,791 minutes (the largest whole-minute interval within Node's timer limit). It is reconciliation cadence, not a promise to call the planner every interval. Saves apply to new operations; an in-progress cycle finishes with its original settings snapshot.
- A picker `skip` or dry-run decision is cooled down by the UI retry window (default 6 hours). For TV, a successful search with no candidate admitted by guardrails records `release-unavailable` for the attempted episodes and retries automatically after that same configured window. A newly aired sibling does not inherit or reset that episode's availability deadline. An available movie with no admitted candidate uses the same finite work-item retry cadence; unavailable movies wait for Radarr metadata without a retry deadline or paid search. Rate limits, operational backoff, identity/configuration reviews, and uncertain downloads remain separate holds; availability does not override them.
- UI failure-backoff defaults are 5/60 minutes and cap exponential failure delay; a longer upstream `Retry-After` takes precedence. The third consecutive ordinary operational failure enters manual review; rate limits stay on backoff and do not escalate solely due to quota.
- Diagnostics include safe stage, error code/type, HTTP status, and retry seconds, not exception messages, response bodies, or authenticated URLs.

## Queue and manual review

Queue grace defaults to 30 minutes for a submitted job to appear in the tracked *arr queue; it is an appearance deadline, not a download-duration limit. `ma_status` exposes safe queue counts, next-search times, coverage IDs, freshness, and coarse hold reasons; it omits credentials, URLs, hashes, GUIDs, and raw queue messages.

The HTTP operations dashboard's Queue scope excludes fulfilled/inactive history by default; select a terminal status or the all-history scope to view it. Queue freshness is unknown when queue completeness/timestamps are missing, and stale when either library or queue observation is older than 24 hours. Review projections identify media type and TV season without exposing work-unit internals. See [operations dashboard](operations-dashboard.md) for response scopes and user actions.

Obsolete, unlinked TV title reviews tagged `legacy-ineligible` are automatically deleted during normal library reconciliation when a fresh, known, identity-matched read shows a nonempty, fully imported inventory for their exact season and any saved work targets have files. Missing historical review targets are not a reason to leave these completed-season warnings open forever. This cleanup needs no operator-action opt-in and does not retry work, release reservations, or delete intent/queue-linked reviews, decisions, dedupe markers, or audit records. Unknown/partial, empty, stale, identity-changed, or incomplete evidence leaves the reviews untouched; a truly orphaned row still needs a durable identity before cleanup. Dashboard Refresh alone does not run reconciliation.

A confirmed intent can link to one unique, fresh, healthy physical job whose direct Sonarr/Radarr IDs cover all remaining captured targets. The link is monitoring evidence; it does not prove submission provenance, torrent contents, or import. Missing jobs after the appearance grace period, disappeared linked jobs, and unhealthy or ambiguous observations go to review while captured holds and successful dedupe records are preserved. Work is fulfilled only after the library reports `hasFile`.

During known library reconciliation, positive `hasFile` evidence for every previously tracked TV target or for a tracked movie takes precedence over the item's becoming unmonitored, including on later polls after the item first becomes terminal. The original TV target IDs remain private reconciliation evidence; terminal status and safe projections, not an empty target list, express completion. For a legacy terminal TV row whose saved target list is already empty, completion is recovered only from a nonempty, known inventory for that exact season where every listed episode has a file. Library removal, a missing target ID, an empty season inventory, zero remaining eligible targets, or an unknown read alone is not completion evidence. A complete target set is fulfilled on the normal poll; incomplete unmonitored work becomes inactive and unknown observations remain held.

MCP `ma_review_action` with `resolve` resolves an open review; it is not the dashboard's Retry action and does not discharge vanished queue coverage. The HTTP operations dashboard provides guarded Retry for ordinary scheduling/review reasons and Reset item for rebuilding local tracking when **Safety → Allow operator actions** is enabled. Reset resolves unlinked reviews as history and clears current scheduling, but retains linked reviews and all queue reservations, coverage, receipts, dedupe markers, decisions and association history. It waits for a later known library observation before work becomes visible/actionable again. Neither action starts an immediate cycle, search, or grab. Fresh saved observations, provider throttling and owner-checked claims remain enforced. For an explicit human release choice, `ma_pick` is a fresh, guarded manual pick. A matching-season-only pack may proceed with explicitly labeled inferred coverage; it is not proof that the torrent contains every missing episode.

`ma_pick`'s `releaseIndex` selects from a candidate list built fresh on every call (planner queries → Prowlarr search → guardrail filtering → seeders sort → cap). The list is not stable across calls and nothing is reserved. A dry-run call does not pin an index for later. Check the returned `releaseTitle` to see what was selected; outcomes include `grabbed`, `dry-run`, `missing-download-client`, and `reverify-failed`. An index from `ma_search` raw results does not transfer.

Successful manual-pick searches update episode attempt clocks for their actual eligible search scope, including dry runs. Their final retry/cooldown is persisted with the season outcome so the next automatic poll does not immediately repeat the same search. Future, imported, and download-held siblings outside that scope retain their clocks. Picker identity-manual decisions are persisted under the live claim before a later fallback stage; a fallback error or different selection rationale cannot erase or relabel that hold.

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

## Episode progress persistence

Episode progress is stored additively beside the existing season work, intent, and review identities. Before upgrading, stop every writer and take a consistent SQLite backup; do not run old and new writer versions together. Rollback requires stopping writers and restoring the pre-upgrade backup with its matching binary. There is no destructive down migration; post-upgrade observations are lost on restore.

Known observations retain all episodes of a tracked season, including imported and future episodes. Episode availability deadlines determine the next searchable subset; the season work row remains the coordination and aggregate scheduling entry. Download reservations and queue coverage remain authoritative safety evidence rather than a second episode reservation ledger. Unknown/partial reads do not erase prior observations or prove imports, and an uncertain or vanished download can still conservatively hold the season. An operational retry changes only the successfully searched episodes from that attempt; it does not clear a sibling's availability deadline.

On a fresh, identity-matched known poll, an old unlinked TV or movie `no-suitable-release` review can be converted to ordinary availability handling only when no conflicting review, configuration, claim, reservation, or queue uncertainty applies. The review remains as resolved history; eligible content receives a finite retry deadline without fabricating a historical search or an import, while unavailable movies wait for Radarr metadata without an availability retry deadline. Linked, unknown/stale, identity-changed, active/ambiguous-download, and other blocking review cases remain held. An existing later ordinary retry deadline is not shortened by conversion. This policy does not require operator-action opt-in and does not release reservations.

## Queue review evidence and cleanup

Queue-related reviews retain a private, versioned cause and affected scope. The
evidence contains Arr identity and episode IDs (or movie scope), not queue
references, request URLs, or raw service messages. Repeated reads of the same
unresolved cause and scope do not create new review incidents; resolved history
does not suppress a later occurrence. Existing evidence-less reviews remain
unknown and are not assigned targets retroactively.

Captured-target reviews are retired only after a fresh, non-regressing known
library observation confirms every captured file under the same service and
external identity. Unknown or broad ambiguous scopes, stale reads, missing
targets, and changed identities remain open. Linked intent reviews additionally
require that their actual intent is fulfilled; clearing a review never releases
an independent download reservation.

An unidentified queue row still blocks potentially overlapping work, but does not
create a durable review for unreleased-only items with no captured work at risk.
Directly identified episodes positively observed with files no longer hold their
future siblings because of a lingering uncertain queue row. Missing IDs and
unknown inventory do not establish that completion.
