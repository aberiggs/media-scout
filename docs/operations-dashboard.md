# Operations dashboard

The dashboard's **Queue** shows Media Scout's tracked work items, scheduling, observations, and held coverage. It is not a view of live download-client jobs. By default, fulfilled and inactive history is excluded before filtering and pagination; choose a terminal status or `scope=all` to inspect it. `counts` describe the returned scope, `scope` reports the requested scope, and `countScope` reports the effective scope (a terminal-status filter includes history). Pending-reset items remain hidden until a later known library observation.

Observation freshness uses one response-time snapshot and a 24-hour threshold. A missing or unknown queue timestamp/completeness is reported as unknown; an older library or queue observation is stale. Actions remain unavailable for either state. Reviews identify media type and TV season without exposing raw work-unit data, so separate season reviews can be distinguished.

`GET /api/operations/reviews` preserves the raw per-cause row response by default. `grouped=true` opts into one item per work key; filtering matches a cause/title first but returns every cause in that matching group, then pagination applies to groups and `total` counts groups. Each grouped item keeps representative review fields for compatibility and adds `reviews` with every underlying row and ID, plus saved `workStatus` and `availability` (`waiting-release`, `available`, or `unknown`). Availability uses fresh identity-matched Radarr eligibility captured during reconciliation or known episode metadata, never work status or a title alone. Work `openReviewCount` counts distinct open work keys; raw review history remains available in ungrouped mode. Reset eligibility uses current work-state safety checks, while Retry remains restricted to ordinary review reasons. Eligible association is a fresh-evidence assessment (`requiresAssessment: true`), not assurance that a commit will be available. Queue summaries use allowlisted saved causes; legacy reviews without one say so explicitly.

TV work rows may include additive `episodeProgress` with observation knowledge, lifecycle confidence, completion (`caught-up` is distinct from all-files-imported), counts, and earliest eligibility/retry timestamps. Counts are `null` when episode observations are absent, identity-mismatched, stale, omit a previously tracked target, or are not from the work row's current library poll; work status alone never establishes completion. Lifecycle `finished` requires positive finale evidence and known elapsed timing; the absence of future episodes does not establish that a season ended. Timing counters and safety holds can overlap (for example, a future episode under a broad queue hold), but observed/reserved download coverage is a unique episode union and is never counted twice.

`GET /api/operations/episodes?workKey=<key>&limit=50&offset=0` returns the same summary plus a stable, paginated season inventory (limit 1–100, offset 0–1,000,000). It requires an existing TV work key (invalid keys/parameters return 400; missing or non-TV work returns 404). Episode rows expose sanitized titles, numbering, monitoring/file facts, timing basis, safe progress/hold labels, and observation freshness; they never expose episode IDs, raw Sonarr objects, release identifiers, queue payloads, or claim tokens. The endpoint is read-only and terminal season work remains inspectable. `ma_status.workQueue.items[].episodeProgress` carries only the same coarse summary, not episode titles/details.

Queue season rows show imported inventory separately from airing lifecycle: “Caught up · awaiting airtime” means currently known aired targets are handled while future episodes remain; “Known inventory imported” does not assert that no further episodes will be added or that airing is finished. Unknown/stale episode observations are shown as unavailable rather than an empty inventory. Expand **Episode details** to read the paginated inventory, including each episode's timing basis, next eligible/retry time, and any precise episode-level hold explanation. Broad work-level holds remain distinct from exact episode holds; uncertain download coverage is described as a safety hold, not as an airtime delay. The same read-only episode inventory is available from TV review details. These controls only read saved operations data: they do not change action eligibility or trigger searches. Retry, Reset, association, and release controls remain gated by the existing API action eligibility and evidence workflow.

Refreshing Queue, Reviews, or Search history reads the local SQLite projection; it does not trigger a cycle or search.

**Search history** records bounded search activity for seven days, up to 2,000 entries. Query terms can reveal what you are looking for; this is an operational view, not raw server logs.

New activity entries include `scope`: stage (`pack-batch`, `episodes`, `movie`, or `manual`), whether it was fallback, and season/episode-number attribution. Scope summaries retain at most 20 work references and the first 100 episode numbers per reference, with each reference's full episode count. Older rows without scope remain readable. `scope.event: capacity-deferred` is explicitly **not a search**: no query was executed and no attempt clock was advanced for those deferred episodes. Its query label says `No query: capacity deferred`, its result count is unknown, and `deferredEpisodeCount` identifies outstanding work. Failed stage searches keep their attributed scope and safe error code; raw release or queue payloads are never added to diagnostics.

## Retry and Reset

Actions require fresh known observations, no competing live worker/group claim and no active rate-limit deadline. TV actions also require the same-series group lease. Retry additionally requires ordinary scheduling/review state with no open reservation, retained coverage or safety review. Reset can clear unlinked review clutter while retaining those independent download protections.

- **Retry** clears ordinary cooldown/backoff scheduling and eligible ordinary reviews while preserving the last search time. It makes work eligible for a later processing pass; it does not start a cycle or promise when the scheduler will process it.
- **Reset item** clears current retry/attempt scheduling and unlinked reviews (kept as resolved history), then records a pending reset. The work item is hidden from Queue until a later known library observation; a read begun before reset cannot authorize paid work. Reset does not search, grab, cancel downloads, or clear linked reviews, queue coverage, reservations, receipts, dedupe markers, decisions, associations or audit history. Actual download problems can correctly remain or reappear after rediscovery.

For TV, Retry also clears the current content identity's episode retry deadlines and scheduling outcomes while preserving episode attempt times. Reset clears those attempt times as well. Both retain observed episode facts and historical records; neither can make a future, unmonitored, imported, or safety-held episode searchable. Historical rows belonging to a different content identity are not reset. Explicit manual picks can bypass ordinary scheduling, but still require known aired missing targets and all download-safety checks.

Known positive file evidence takes precedence over an item's becoming unmonitored: if every previously tracked TV target is positively observed with a file, or a tracked movie is positively observed with a file, normal reconciliation marks it fulfilled. Missing targets, removal from a source library, empty inventory, and unknown reads do not prove completion; unresolved or incomplete work remains inactive/held as appropriate. This happens on a normal successful library poll—there is no manual database reclassification.

Retry and Reset are gated by **Safety → Allow operator actions**, which is off by default. This is an opt-in, not user authentication.

## Review recovery

Completed-season legacy title warnings are cleaned up automatically on a normal successful library poll, not by Retry/Reset or a dashboard dismiss action. Once fresh, identity-matched evidence confirms the exact season is fully imported, obsolete unlinked `legacy-ineligible` title rows are deleted from SQLite and stop contributing to open-review counts. Captured-target title reviews retain their existing evidence-based resolution behavior. Intent/queue-linked reviews and unresolved download holds are not removed by this cleanup. See [operations](operations.md#queue-and-manual-review) for evidence requirements.

Association and reservation release use a separate prepare/commit flow. Prepare reads the current library and complete Sonarr/Radarr queues and returns a short-lived preview, explicit choices, and an exact challenge. Review the affected targets and queue evidence before committing; changed or stale evidence requires a fresh preview. Association commits only the explicit supplied selection.

Reservation release requires confirmation that all relevant download clients and the original submission routing were inspected, followed by the exact challenge text. An empty *arr queue by itself is not proof that a download is inactive. The recovery lane does not search, grab, invoke the LLM, or mutate a download client.

## Network and startup

The HTTP UI/API has no authentication. Keep it on loopback or a trusted private network; do not expose it to untrusted networks. See [operations and safety](operations.md), [setup and configuration](setup.md), and [operator recovery](operator-recovery.md) for broader guidance.

From a checkout, the documented Compose startup is:

```sh
mkdir -p data
docker compose up -d --build
```

Open <http://127.0.0.1:7877/>. For local source development and the existing web build/run commands, follow [setup and configuration](setup.md).

Chat is deferred; the current operations dashboard covers Queue, Reviews, and Search history.
