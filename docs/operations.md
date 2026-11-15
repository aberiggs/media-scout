# Operations and safety

Media Scout's current runtime is the search-first service (#24), not the former tracking/review engine. It searches neutrally, returns ranked alternatives, and downloads only after an explicit submission (or an enabled automation policy selects rank 1). A submission means Prowlarr accepted a request; it does not prove a download, queue match, or import.

## Safe operation

Fresh settings have automation disabled and dry-run enabled. Scheduled polling runs every five minutes only while monitoring is enabled. Dry-run prevents grab POSTs, but searches can still call the configured LLM and Prowlarr, incur charges, and use indexer quota. A manual search is also network activity. Keep the unauthenticated HTTP interface on loopback or a trusted network; do not expose it publicly. MCP is stdio and has no built-in user identity: require host approval for `ma_submit_v2` and `ma_automation_poll_v2`.

Configure Prowlarr and LLM for standalone search. Sonarr and Radarr are optional for that use; automation requires the relevant Arr connection. Configure integration credentials in Settings, not `.env`. The database and backups contain saved credentials and must be treated as secrets.

## Search and submission

Search is read-only toward indexers/download clients and bounded by server settings: defaults are 20 model decisions, 12 Prowlarr search calls, and a 10-minute deadline. Per-request limits can only lower these bounds. Search exposes all safely representable candidates supplied by each Prowlarr result, not a seed-ranked top-N list; upstream incompleteness or context overflow is reported and cannot authorize automated submission. Result statuses distinguish `matched`, `no-match`, `needs-input`, `budget-exhausted`, `failed`, and `interrupted`; only validated matched options can be submitted.

Submission is an explicit separate operation. It accepts an opaque search/option reference and idempotency key, with an optional enabled Prowlarr download-client ID. Client choices are server-listed and protocol-checked; otherwise the configured TV/movie routing applies. Reusing a key replays its result and never sends another POST. Ambiguous POST outcomes are not retried automatically. Private URLs, GUIDs, hashes, and credentials are excluded from public projections and model context. Submit-capable candidate references expire 30 minutes after completion; retained activity defaults to 30 days/10,000 searches.

## Automation and Arr observations

Automation uses current Arr library and queue reads, never audit history as authority. Sonarr observations read series, each series' episodes, queue, and (when available) quality profiles. TV eligibility requires monitored series and episode, no file, and reached airtime. Valid `airDateUtc` is preferred; date-only fallback becomes eligible at the following UTC midnight; unknown timing is not eligible. Context may include title/alternate titles, year/TVDB ID, seasonal and absolute episode numbering, episode title/overview, original language, series type, and summarized quality/custom-format profile. Radarr observations read movies and queue, and optionally quality profiles. Movie eligibility requires monitored, no file, and Radarr's `isAvailable`; context may include title/year/TMDb ID, overview, original language, and summarized profile.

Queue association uses Arr IDs: Sonarr series/episode/season IDs and queue status/tracked status/tracked state; Radarr movie IDs and the corresponding status fields. Nonterminal associated records suppress only their directly associated scope (season/series rows conservatively suppress that scope for the current poll). Failed/removed terminal rows do not suppress. Unidentified rows are diagnostic, not durable holds. Failed or incomplete provider reads remain unknown, never empty; one provider's failure does not turn the other provider's result into absence. Submission performs fresh applicable Arr checks before side effects.

Supported API fields are Sonarr series `id`, `tvdbId`, `title`, `alternateTitles[].title`, `monitored`, `seriesType`, `overview`, `originalLanguage`, and `qualityProfileId`/`qualityProfile`; episodes `id`, `seasonNumber`, `episodeNumber`, `absoluteEpisodeNumber`, `title`, `overview`, `monitored`, `hasFile`, `airDateUtc`, and `airDate`; queue `seriesId`, `episodeId`, `seasonNumber`, `status`, `trackedDownloadStatus`, and `trackedDownloadState`. Radarr uses movie `id`, `tmdbId`, `title`, `year`, `overview`, `originalLanguage`, `monitored`, `hasFile`, `isAvailable`, and quality-profile fields, plus queue `movieId` and the same status fields. Queue clients walk all pages; failed/inconsistent pagination is unknown. Profile context summarizes allowed qualities and named/scored custom formats, not a reimplementation of Arr scoring.

Automated TV work is attempted episode-by-episode, oldest last-attempt first. Defaults: 5-minute poll cadence, 6-hour no-match/dry-run retry, operational failure backoff from 5 to 60 minutes exponentially, 30-minute appearance grace for submitted/uncertain attempts, and a 24-hour target-scoped exclusion for known releases not observed after grace or explicitly failed. Provider `Retry-After` takes precedence. After grace, if fresh Arr data still says missing and no matching queue coverage exists, an attempt can recur; this accepts the risk that an unmatched prior download may still exist. Scout never cancels or edits download-client/Arr jobs. Dry-run recommendations get a six-hour cooldown but no submission/grace.

## HTTP and MCP

| HTTP route | Purpose |
|---|---|
| `GET /health`, `GET/PUT /api/settings` | Health, settings and readiness |
| `POST /api/v2/searches`, `GET /api/v2/searches/:id` | Start search (202) and read progress/result |
| `GET /api/v2/activity` | Filtered, paginated activity |
| `GET /api/v2/download-clients` | Enabled safe client choices |
| `POST /api/v2/submissions`, `GET /api/v2/submissions/:id` | Explicit submit and recorded outcome |
| `GET /api/v2/automation` | Saved automation settings and observations only |
| `POST /api/v2/automation/poll` | Explicitly poll; scheduler does so when enabled |
| `POST /api/v2/automation/search` | Search an eligible Arr target read-only |

MCP tools are `ma_status`, `ma_search_v2`, `ma_search_status_v2`, `ma_activity_v2`, `ma_download_clients_v2`, `ma_submit_v2`, `ma_automation_status_v2`, `ma_automation_poll_v2`, and `ma_automation_search_v2`. Status/activity/observation reads do not start searches. There is no `/cycle`, legacy review/queue interface, recovery CLI, or old MCP alias.

## Database, backup, and rollback

Default `DB_PATH` is `data/media-scout-search.db`. Startup refuses a nonempty database without the search schema, read-only and without modifying it; configure a fresh path rather than deleting or migrating the old database. New search, submission, settings, deadlines, and observations persist across normal restarts. Running searches are marked interrupted at restart; they are not resumed. The rollback path is deliberate: stop all daemon/MCP/other writers, take a consistent backup, switch to the matching prior binary and its matching database backup/path. Never run old and new writers together. Downloads already submitted externally are not undone by restoring a database; account for those jobs before resuming the old runtime.

Do not start the daemon against production data, run live evaluation, or submit real downloads without separate authorization. Ordinary tests must use isolated databases and synthetic/offline services.
