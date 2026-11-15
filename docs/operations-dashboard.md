# Operations dashboard

The current UI has four views: **Search**, **Activity**, **Automation**, and **Settings**. The former Queue/Reviews tracking dashboard and recovery actions are not part of this runtime.

## Search

Submit a natural-language prompt; structured media context and descriptive preferences are optional. Search shows progress, query/candidate counts, warnings, ranked alternatives, concise reasons, and uncertainty. A matched result is a recommendation, not a download or import. Submission is a separate explicit confirmation; alternatives are not submitted together. Enabled Prowlarr download clients may be selected from the safe server-provided list. Expired candidate references require a new search.

## Activity

Activity shows retained search attempts and submission outcomes, with source/status, media, creation-date and text filters and pagination. Date filters include the entire selected days in your local timezone; requests without TV/movie context appear under Other / no context. Open search details for actual queries, recommendations and recorded per-release submission outcomes. It distinguishes errors, no-match, dry-run, submitted, rejected, and uncertain outcomes; submission is not proof of downloading or import. Retention defaults to 30 days or 10,000 searches. Search request text may be sensitive; avoid secrets in prompts. Private locators and credentials are not shown.

## Automation

Automation displays saved settings and the last known Arr observations, with their source, timestamp, and completeness. Refreshing this view reads saved data only. **Poll now** is an explicit upstream read and may lead to searches or submissions when monitoring and real submissions are enabled; scheduled polling is active only when monitoring is enabled. **Search this item** starts a read-only search for an eligible Arr target.

Sonarr eligibility is based on monitored series/episode, missing file, and reached airtime; Radarr eligibility uses monitored, missing file, and Radarr's `isAvailable`. Nonterminal queue rows are associated using Arr identifiers; incomplete/failed reads are shown as unknown and cannot be interpreted as empty. Automation attempts individual TV episodes rather than implicitly batching seasons. Observation of a file in Arr, not a search result or submission, establishes import.

## Settings and safety

Fresh setup defaults monitoring off, dry-run on, five-minute cadence, six-hour minimum retry, 5/60-minute failure backoff, 30-minute queue appearance grace, and search bounds of 20 model decisions, 12 Prowlarr calls, and 10 minutes. Settings are stored in SQLite. Dry-run prevents grab POSTs but search can still incur model/indexer network activity. The UI/API is unauthenticated; keep it on loopback or a trusted network. Require human host approval for side-effecting MCP tools.

See [operations and safety](operations.md) for routes, tool names, exact policy and backup/rollback instructions.
