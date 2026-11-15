# Design: Search-first replacement

## Context

See `proposal.md` for motivation, issue ownership and the approval boundary. Current useful seams are thin Arr/Prowlarr HTTP clients, schema validation, SQLite, dependency injection in `compose.ts`, and React/Vite. The LLM client currently exposes one-shot JSON rather than a conversational tool loop; Prowlarr already supports search and routed submission. Current state, runner and operations projections are tightly coupled to work keys, intents and reviews: they should not become the foundation of the new search service.

API baseline is Sonarr v4 and Radarr using `/api/v3`, Prowlarr `/api/v1`. Official resource documentation consulted through Context7: [Sonarr EpisodeResource and queue resources](https://github.com/Sonarr/Sonarr/blob/develop/_autodocs/types.md), [Sonarr episodes](https://github.com/Sonarr/Sonarr/blob/develop/_autodocs/api-reference/05-episodes-calendar.md), [Radarr movie resource](https://github.com/Radarr/Radarr/blob/develop/src/Radarr.Api.V3/Movies/MovieResource.cs), and [Radarr queue controller](https://github.com/Radarr/Radarr/blob/develop/src/Radarr.Api.V3/Queue/QueueController.cs). Develop documentation is not proof of a particular deployed version; adapters and fixtures must verify supported fields. No production requests were made.

## Goals / Non-Goals

**Goals:** two isolated domain units, one shared submission boundary, testable typed tools, upstream-derived eligibility, observable finite retries, and a standalone search experience. Keep a modular monolith in one process/SQLite database rather than introduce distributed services.

**Non-goals:** a second library, a second queue matcher, a chat product with indefinitely resumable conversations, automatic pack optimization across requests, or a generic autonomous agent framework. The model judges relevance/quality; deterministic code owns permissions, references, budgets, explicit scope contradictions and side effects.

## Decisions

### 1. Module boundaries

`SearchService` depends on model, read-only indexer tools and a search repository. It knows nothing about Arr state, claims, reviews or download clients. `ArrAutomation` builds requests from observations and invokes the same service in-process; HTTP and MCP expose that service rather than force internal network calls. `SubmissionService` resolves private release references and owns Prowlarr POSTs. A small store provides audit, retry deadlines, leases and submissions. Domain units depend on interfaces, not each other's persistence tables.

Prefer this over microservices (operational overhead) or modifying the existing runner (retains unwanted state-machine coupling). Reuse independently tested transport, parsing and date helpers only; delete obsolete runtime modules/tests once replacement coverage exists. Do not retain a dormant alternate engine or new code paths back into operator recovery.

### 2. Search request and response contract

Versioned routes:

| Interface | Behavior |
| --- | --- |
| `POST /api/v2/searches` | Validate request and create a search; return 202 with `searchId` and status URL |
| `GET /api/v2/searches/:id` | Progress or terminal result; no new search/network action |
| `GET /api/v2/activity` | Paginated/filterable attempt history |
| `POST /api/v2/submissions` | Explicit option submission with idempotency key; never implicit in search |
| `GET /api/v2/submissions/:id` | Recorded per-release outcomes |

MCP tools `ma_search_v2`, `ma_search_status_v2`, `ma_submit_v2`, `ma_activity_v2` use identical schemas/services. Search is non-download-mutating but costs network/model calls; submit is destructive and requires host approval. No model in the internal search loop can invoke submit. Existing `ma_status` can report interface version, readiness and automation summary without work-key projections.

Request shape (illustrative field names, normative meaning):

```json
{
  "prompt": "Find this episode, original audio with English subtitles, preferably 1080p",
  "context": {
    "kind": "tv",
    "titles": ["Example", "Alternate title"],
    "year": 2026,
    "externalIds": {"tvdb": 123},
    "scope": {"type": "episode", "seasonNumber": 2, "episodeNumber": 1, "absoluteEpisodeNumber": 26},
    "targets": [{"targetId": "e1", "seasonNumber": 2, "episodeNumber": 1}]
  },
  "preferences": {
    "audioLanguages": ["ja"],
    "subtitleLanguages": ["en"],
    "resolutions": ["1080p"],
    "notes": "Multi-sub is welcome"
  },
  "requirements": {"subtitleLanguages": ["en"]}
}
```

Only a nonempty prompt is required. Context, individual fields and preferences are optional. Other neutral requests use `kind: other` or omit context; Arr identifiers/episode fields are never mandatory. Preferences are descriptive guidance, not language gates. The model should favor compatible multi-sub releases and widely compatible/popular choices with strong seed/grab counts as soft evidence, not a guarantee or mandatory cutoff. Explicitly known wrong content/language is unsuitable; unknown metadata is not grounds to reject an otherwise plausible choice. No language must-have enforcement exists in v1.

Terminal response includes `searchId`, `status`, safe request summary, warnings, budget usage, prompt/model version, examined candidate count and ranked `options`. Status is `matched`, `no-match`, `needs-input`, `budget-exhausted`, `failed` or `interrupted`; in-progress status is `queued`/`running`. Only `matched` permits submission. Errors, incomplete model output and incomplete upstream searches must not masquerade as exhaustive no-match. A partial-source run can retain provisional options but is not automatically submittable.

An option has `optionId`, `rank`, `releases`, `coveredTargetIds`, concise selection reason and uncertainty. Each release has an opaque `candidateId` and allowlisted title/indexer/size/health/scope/language evidence; no private URLs, GUIDs or hashes. Options are alternatives, not a list to download together. For episode/movie requests each option contains one physical release. Explicit season requests permit up to three non-overlapping releases per option, with up to five ranked options. Partial season coverage is labeled and uncovered targets remain explicit. Rank 1 is the model's best suitable acquisition plan, not a calibrated probability. Inferred packs are never labeled verified contents/imports.

Server validates referenced candidates were actually observed in that search, ranks and target IDs are valid, and explicit known-wrong scope/season conflicts cannot pass. Fuzzy identity and quality remain model judgments, not a homegrown deterministic title scorer. Prose-only requests can be searched, but unresolved target identity becomes `needs-input`; the model cannot manufacture a confident structured request to bypass ambiguity.

### 3. Multi-turn loop and full candidate visibility

Use a small schema-constrained next-action protocol: `list_indexers`, `search_releases`, `finish`. Each model call receives the conversation/tool transcript and a typed next action; the server executes only allowlisted read-only actions. This builds on the existing JSON model seam without requiring every configured provider to implement native tool calling. HTTP/MCP and internal tools share underlying indexer functions. Do not add arbitrary external MCP servers, shell, URL fetching or torrent-content browsing.

`search_releases` accepts query/categories and optional configured indexer IDs. The server enforces enabled/cooling-down state and returns all candidates supplied by Prowlarr with relevant safe fields, observed counts and incompleteness flags. Deduplicate repeated physical observations while preserving conflicting metadata and query provenance. No seeders-based top-N shortlist, hidden 100-candidate cap, automatic summary replacing candidates, or pagination in v1. At least the 100- and 200-result fixtures must reach the model in full, including low-seeder/last-position winners. "Examined" means delivered to the model, not proof of its internal attention. API truncation is reported, not disguised as complete recall.

Proposed generous operational defaults: 20 model decisions, 12 actual Prowlarr search calls, 10-minute total deadline, one active search worker and one automated target per poll pass. Every tool/retry counts against the same deadline/call budget; model schema correction is limited to one attempt. Existing provider Retry-After is respected. A context overflow ends explicitly without auto-submission or token-driven silent filtering. Budgets can be lowered per request, never raised above server settings by a caller/model. No small token cap is introduced to optimize cost; configured model/provider context limits still exist.

Prompts explicitly compare suitable alternatives, use supplied aliases/numbering, distinguish original/dubbed audio and subtitles, prefer evidenced requested-language support, handle unknowns honestly and allow no-match. Media/indexer text is untrusted data, not role instructions. Store tool actions and concise rationales, never request or display hidden chain-of-thought.

### 4. Arr poll, eligibility and request context

Each enabled pass reads complete current library/episode data and all queue pages. Successful reads replace the displayed observation cache; incomplete/failed reads are marked unknown and cannot establish absence. One provider failure defers that provider, not the healthy provider. Fresh submission checks always reread the applicable provider, rather than use a 24-hour freshness allowance.

- TV eligibility: monitored series and episode, no file, airtime reached. Preserve valid `airDateUtc`; date-only fallback remains next UTC midnight; invalid/absent timing stays unknown. Use episode IDs/seasonal/absolute numbering, aliases, year, type, airtime, overview, original language and relevant profile/custom-format context when available. Future/imported siblings are context, never acquisition targets.
- Movies: monitored, no file, Radarr `isAvailable: true`; include titles/aliases/year/external IDs/original language and available quality-profile context. Do not replace Radarr's availability calculation with a Scout guess.
- API clients retrieve necessary quality-profile/custom-format resources if not embedded, caching by source configuration and version. These are descriptive selection context, not a promise to reimplement the entire Arr scoring engine. Do not transmit paths, credentials, raw queue messages or download URLs to the LLM.
- Queue suppression uses Arr-provided series/episode/movie IDs and current state. All directly matched nonterminal rows (queued/downloading/paused/warning/import-pending/delay/unknown-state) suppress only covered targets until Arr removes them; failed terminal rows do not claim healthy downloading. Import pending is not imported. An Arr-ID season-level row without episode IDs conservatively suppresses that season for that poll, not other seasons. A row with only series ID suppresses that series for the current poll. An unidentified row suppresses no target; display its count as a diagnostic. No fuzzy queue-association LLM or durable vanished-coverage ledger.

Automated TV requests are individual episodes, oldest last-attempt first, then airtime and stable ID. Do not group a new influx into packs in this version. Explicit manual season requests use only the supplied eligible target set and can recommend packs with inferred coverage warnings. This trades throughput for simplicity; increasing worker throughput or batching is separate work.

### 5. Automatic selection and submission

Automation sends its saved preference profile plus fresh context. On `matched`, submit only rank 1 after verifying all its targets still monitored/missing/eligible, no matching queue coverage, unchanged source identity/configuration, and automation still enabled. If rank 1 is stale or invalid, do not silently promote rank 2; record the changed-state reason and reconsider on a later pass. No-match/needs-input/model errors become visible retryable outcomes, never permanent reviews.

Submission accepts `{searchId, optionId, idempotencyKey, downloadClientId?}`. The API exposes the enabled download-client choices listed by configured Prowlarr; the caller may choose only one of those validated IDs. Without an explicit choice, retain the default Arr TV/movie route. Never accept arbitrary URLs or client definitions from callers. A server-owned Arr context attached by automation (or by a UI "Search this item" action) adds fresh Arr rechecks; a neutral manual search has no invented Arr requirement. Successful POST means submitted, not downloading or imported. The UI presents client choice plainly at submission.

Persist an owner-checked target/release lease and a `submitting` record before POST. Never blindly retry a non-idempotent POST after timeout. Per-release outcomes are `submitted`, `rejected` or `uncertain`; multi-release season plans stop at the first failure and report partial submission. The same idempotency key always returns its recorded outcome and never sends again, including after restart; the same key with different request material is a conflict. A new attempt uses a new key. Existing active-search and active-submission leases prevent concurrent callers from submitting overlapping target/release identities.

Under acquired ownership, `SubmissionService` atomically rechecks persisted target appearance grace and physical-release grace before recording any new POST, including different-key manual Arr-linked submissions. These checks are not merely poller hints: sequential callers cannot bypass grace after a live lease ends. Neutral manual submissions have no Arr target gate, but share the finite 30-minute physical-release grace, so repeated new-key confirmations cannot immediately resend the same known release. Grace returns an explicit already-pending/deferred result; no override action is added. It expires without requiring operator release. UI repeat clicks reuse the original key. Hashless cross-indexer physical identities remain best-effort, not a claim of perfect duplicate detection.

Lease TTL is 15 minutes, exceeding the 10-minute search deadline; renewing or committing requires current ownership. A stale worker cannot continue writes/POSTs after lease loss. Do not implement infinite locks. Search jobs are not resumed across process crashes; mark them interrupted, retain audit, and expire their owned leases. A pre-POST crash yields at worst finite uncertainty/grace, not a permanent hold.

### 6. Finite retry policy (proposed defaults for approval)

| Condition | Default behavior |
| --- | --- |
| Poll cadence | Every 5 minutes; view refresh is read-only; "Poll now" explicitly reads upstream |
| Submitted or uncertain POST | 30-minute appearance grace for exactly captured targets, persisted across restart |
| Grace expires; fresh known Arr still missing, no matched queue | Eligible on next poll; no operator release/reset required |
| Previously matched download disappears, file still absent | Eligible subject only to ordinary timing/source backoff; no durable queue hold |
| No suitable match / needs-input | Retry after 6 hours; UI offers Search now to clear this ordinary deadline |
| Suitable recommendation in dry-run | Record dry-run with a 6-hour per-target cooldown; no submission/grace or failed-release exclusion is created |
| Model/indexer/transport failure | 5-minute exponential backoff capped at 60 minutes, no third-failure manual review |
| Provider Retry-After | Honor it even when longer than local caps; Search now cannot bypass it |
| No queue after grace or explicit failed submission | Exclude that physical release for that exact target for 24 hours, so another release can win; show why |

Temporary release exclusion is target-scoped, finite and not a permanent successful-grab dedupe ledger. Imported-then-deleted content can be searched again; legacy release/hash markers never veto it. A currently failed matched queue row also excludes its release when a reliable physical identity is available; absent that identity, do not invent a match. Audit this limitation. A successful queue match ends appearance-grace scheduling; future eligibility continues to depend on current Arr observations. Every retry obtains fresh observations and reruns search; no blind cached grab.

"Search now" bypasses ordinary no-match cooldown only, not active queue coverage, appearance grace, concurrent ownership or provider throttling. Do not reset grace by restarting/repeatedly polling. No automation or UI action removes, cancels or edits Arr/download-client jobs. Persistent matched warnings remain visible as Arr facts; operator fixes those in Arr/download client, not in a Scout review queue.

### 7. Persistence and observability

Use versioned tables for searches, query/tool events, candidates, ranked options, per-target attempt deadlines, provider backoff, leases and submissions. Keep repository interfaces narrow; no generic event-sourcing framework. A read-only observation cache supports the Automation page but is labeled with source/time/completeness and cannot authorize a submission. Never persist a local imported/fulfilled state that overrides a later known observation.

Store sanitized request/context, model/prompt version, query attribution/counts, safe errors, outcomes and usage when the provider supplies it. Private submission references (indexer/GUID/hash/routing) remain local; never appear in public API, issue evidence or model prompts. Plain user request text is potentially sensitive: bound its size, warn not to paste secrets, and avoid logging raw prompts in application logs. Provider calls contain only allowlisted context; no entire database/configuration export.

Proposed retention: 30 days/10,000 searches, whole-search pruning oldest first; activity exposes this limit. Private submit-capable candidate material expires 30 minutes after search completion. Readable audit can outlive submit capability. Persist submission receipts and active deadlines/grace through ordinary restarts; do not introduce indefinite tombstone compatibility machinery. Private candidate material can be purged without losing a still-retained receipt/outcome. On history-storage failure, do not submit an unrecorded side effect; return an explicit failed attempt.

### 8. UI replacement

- **Search:** natural-language input, optional scope/context and descriptive preferences, visible running query trail, no-match/error explanations, ranked options with reasons/evidence/uncertainty, clear explicit submit confirmation. A selected option is a plan, alternatives are not auto-selected checkboxes. Expired results offer a new search, not a fabricated retry of old references.
- **Activity:** filter by source/manual/automation, media, time and outcome; attempt detail shows requested target, actual queries, observed candidate counts, recommendation and per-release submission outcome. Keep "submitted", "Arr downloading" and "Arr has file" distinct.
- **Automation:** provider health/last poll, current missing/downloading/waiting work grouped by movie/series with episode detail, reason and next time; pause/enable, explicit Poll now, and Search this item. Partial observations remain visibly unknown; no cached completion claims. No Reviews, Reset, associate, or release-reservation controls.
- **Settings:** search/model/indexers, default preferences/requirements, routing, Arr connections, retries/budgets and automation toggle. Standalone search remains ready when Arr is unconfigured. Saved configuration applies to new requests; in-flight operations use a snapshot and revalidate side-effect-relevant changes.

Retain the project's existing visual tokens, accessible keyboard navigation, labeled controls, focus restoration and narrow-screen layouts. UI mockups/rendered review belong to implementation; this proposal does not dictate a new visual brand.

### 9. Fresh database and deliberate removals

Remove work-key-bound `/api/operations/*` actions, old search/pick/review MCP tools and operator CLI recovery mutations; no retirement compatibility scaffolding or aliases. `/cycle` and `ma_cycle` are removed rather than rebound. New explicit `POST /api/v2/automation/poll` follows enabled/dry-run/side-effect gates; Automation GET/refresh never polls.

Preserve health/settings endpoints, runtime identifiers and connection configuration. Manual submission can choose from configured enabled server-listed Prowlarr clients; default Arr routing remains. On startup, detect an existing old nonempty database and fail fast with clear instructions to configure a fresh database path. Never delete or mutate the old database automatically. No legacy copying, migration, tombstones or old/new engine coexistence. A genuinely fresh database stores all new search/submission state persistently across normal restarts. Do not close unrelated GitHub issues or archive old OpenSpec changes by implication.

## Risks / Trade-offs

- [Unmatched downloads can coexist with retries] → accepted, documented risk; finite grace, target/release exclusions, cadence and concurrency controls, never automatic client cleanup.
- [A matched warning can persist] → mirror Arr and explain its status; do not add an independent Scout hold or suppress unrelated exact episodes.
- [LLM selects a bad release] → explicit requirements, complete candidate evidence, frozen quality cases, inspectable reasons; no claimed statistical accuracy before evaluation.
- [100–200 results consume substantial context/cost] → expose usage and operational budgets, fail explicitly on overflow; do not silently shrink input.
- [Neutral manual search cannot precheck an unknown library target] → explicit confirmation and separate submission contract; no claim of Arr eligibility checking where none applies.
- [Existing policy prohibits discarding uncertain coverage] → approval of this proposal must explicitly replace that policy; amend guidance and docs before replacing runtime behavior. Do not leave contradictory instructions in force.
- [Arr source/schema drift] → version-matched fixtures and explicit unknown/read errors; deployed-version validation remains an operator rollout check, not an invented pass.

## Fresh Database Rollout

1. During approved implementation, update project guidance to the approved finite-grace policy while retaining unknown-vs-empty, owner checks, pre-submit rechecks and no-import-without-file rules. Link supersession to #24; leave historical task evidence untouched.
2. Build replacement domains and deterministic tests against isolated synthetic fresh databases. Existing old nonempty databases are refused with fresh-path guidance; never auto-delete or migrate them.
3. Verify fresh startup, normal restart persistence and fail-fast protection for existing old databases. Run bounded authorized live dry-run evaluation under the aggregate caps in the proposal; use synthetic/sanitized request context, no grabs or production writes, private credentials and safe aggregate reporting.
4. Rollback uses a fresh database path and matching binary. Downloads created externally are not undone by changing database paths; operator must account for them before resuming the old engine.

## Acceptance and evidence

Capability scenarios are in `specs/`; executable matrix and commands are in `tasks.md`. Completion requires focused red/green regressions, full backend/frontend checks, rendered synthetic UI review, fresh/restart/concurrency tests, required bounded live dry-run evaluation, and actual container/SQLite checks or an explicit remaining blocker. OpenSpec validation is artifact validation only. Scripted-model tests do not replace live evaluation or establish general accuracy.
