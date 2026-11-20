# Show-level acquisition planning

> **Superseded implementation plan (2026-11):** the approved #52+#55 release-set
> backend uses one asynchronous search request and a single overlap-tolerant
> release-set result. Do not implement this document's separate batch API,
> ranked alternatives, disjoint per-release target assignment, or acquisition
> flow. Whole-show scheduling and guarded release-set execution now use the
> unified runtime described in [Search subsystem](src/search/README.md).
> Retain this document as historical design context only.

**Status: approved; implementation in progress.** Torrent inspection and CRW
remain out of scope. Validation must not send live download-client requests.
Offline characterization is not live search evaluation. Search-only live probes
now include full collapsed-season anime workloads; results and limitations are
recorded in `AUTOMATION_AUDIT.md`. No download trial is included here.

Delivery checklist:
- [ ] Shared batch contracts, workload/context builder, bounded search and selection.
- [ ] Durable release-level submission, bindings, holds and recovery.
- [ ] Batch HTTP/MCP entry points and show-level automation without show cooldown.
- [ ] Plan/partial-outcome presentation and rendered acceptance.
- [ ] Independent review, regression checks, search-only evaluation and publication.

## 1. Decision and product behavior

Keep episode-level eligibility, tracking, and recovery. Change Sonarr automation's
planning unit from one episode to **one show's currently actionable missing
episodes**, across seasons. Ask the existing search agent for ranked alternative
acquisition plans; each plan can contain multiple releases.

Optimize for suitable quality/language/health and useful requested coverage,
then fewer releases and less redundant downloading. Do not prefer one poor
complete-series torrent over two good packs merely to minimize release count.
Partial progress is valid: download a good pack and available individual episodes,
report what remains, and retry those targets later.

No new planner service, cross-show optimizer, anime-specific mapping database,
CRW dependency, torrent engine, or direct Seerr integration in the first version.
Sonarr monitoring remains our proxy for "requested": this does not recover
Seerr users, approval state, or request priority. Radarr remains movie-at-a-time.

## 2. Architecture

```text
Seerr -> Sonarr/Radarr
             |
     read-only Arr observation
             |
     workload builder
       TV: one show, many due targets + related episode context
       movie: existing single target
             |
     existing bounded SearchService / LLM / Prowlarr reads
             |
     stored ranked options, each an entire acquisition plan
             |
     explicit SubmissionService (or automation policy chooses rank 1)
             |
     reserve -> revalidate -> journal -> sequential Prowlarr grabs
             |
     reconcile each release's expected targets against Arr observations
```

Search cannot submit downloads. The model chooses a plan, not a download client,
credentials, arbitrary URL, or unobserved release. Automation remains the owner
of whether a stored plan may be executed.

### Workload and context

Introduce a small `ArrShowWorkload` value built from one successful observation:

- Show identity, aliases, show overview, series type, language/profile context.
- **Acquisition targets:** monitored, missing, aired/available, not queue-covered,
  not reserved/in queue grace, and due under target retry/provider policy.
- **Related episodes:** everything else in the show, including owned, queued,
  future, unmonitored, unknown-airtime, and temporarily retry-held episodes.
  Include the reason each is context-only, not an acquisition instruction.
- Episode records include opaque reference, seasonal/absolute numbers when
  supplied, episode title, air date/eligibility time, and relevant state flags.
- Observed time and a diagnostic workload revision; source bindings stay private.

Preserve show overview separately from episode synopsis. Do not repeat the whole
show synopsis/profile on every episode. Extend `ArrObserver` to retain show-level
context and queue/eligibility reasons while keeping current eligibility timing.
An incomplete episode read is unknown, not an empty show.

Typical shows get all due requested episodes in one workload. Search direction
is agent-directed generous exploration: distinct broad/alias/season/absolute
numbering queries and evidence-driven refinement, rather than rigid tiny
search/decision budgets. The search-only implementation now reports new candidate
and observation counts, deduplicates identical evidence and repeated effective
queries, and fixes configured budgets being silently limited by old defaults.
Defaults are 40 decisions / 30 searches; settings accept up to 80 / 60 while
preserving saved lower budgets. Existing provider cooldowns, cancellation, context
and overall deadline bounds remain. This is not unlimited execution or a semantic
proof of search exhaustion; broader long-running exploration remains to evaluate.
The opt-in anime harness uses ten-minute model/indexer call limits, a thirty-minute
overall deadline and an appropriately longer claimed lease, without changing
production timeouts or saved settings. Initial batch ceilings are 200
acquisition targets and 24 selected releases per plan, not the current three.
Oversized backlogs use deterministic oldest-due slices, retain compact whole-show
context, and explicitly report deferred counts. Context rendering also needs a
byte/token-oriented bound: retain target details, compact related episodes, and
label omitted detail/totals rather than silently truncating or inventing it.
These are operational limits, not inferred season boundaries; test long shows
and tune the constants before rollout rather than introducing many settings.
Bound accumulated candidate evidence separately from episode context: store full
observations privately, render compact evidence with explicit unexamined counts,
and never hide contradictory observations behind a "best alias." Stop collection
at the input budget; if a faithful bounded view cannot fit, return a clear budget
outcome instead of overrunning the model context. A target deferred outside the
slice is **unsearched**, not searched-but-uncovered; return both counts separately.

Use persisted per-target attempt times to rotate slices and choose shows fairly.
Do not always take the first 200 seasonal numbers or let newly arriving episodes
permanently jump an older backlog.

## 3. API changes

### Extend the existing generic search API

`POST /api/v2/searches` still returns `202 { searchId, status: "queued" }`.
Add `context.scope.type: "episode-set"`; preserve existing episode/season/movie
requests and their behavior unless explicitly updated in the implementation.
Extend target metadata and add context-only `relatedEpisodes`.

Illustrative request (abridged, not a final JSON Schema):

```json
{
  "prompt": "Find good releases covering these missing episodes",
  "context": {
    "kind": "tv",
    "titles": ["Example", "Alternate title"],
    "seriesType": "anime",
    "scope": { "type": "episode-set" },
    "targets": [
      {
        "targetId": "e26",
        "seasonNumber": 1,
        "episodeNumber": 26,
        "absoluteEpisodeNumber": 26,
        "title": "Episode title",
        "airDateUtc": "2026-01-01T12:00:00Z"
      }
    ],
    "relatedEpisodes": [
      {
        "episodeRef": "e50",
        "seasonNumber": 1,
        "episodeNumber": 50,
        "title": "A future episode",
        "hasFile": false,
        "queued": false,
        "monitored": true,
        "available": false,
        "contextReason": "unaired"
      }
    ]
  }
}
```

Generic callers supply their own context; that does not grant authority over
real Arr targets. Only server-resolved Arr bindings can reserve/revalidate Arr
work. Both APIs use the same search executor and stored-result format.

Persist one versioned binding with the immutable original target set and source/
show identity. Current `search-arr:<searchId>` storage overwrites that key once
per target and retains only the last binding (`store.ts:78,93`); simply passing
an array through today's runtime is not sufficient. Read old singleton bindings
through a compatibility adapter. Refresh *state* before sending, not the original
identity/authorization or the model's stored coverage assignments.

### Add an Arr-backed batch-search entry point

`POST /api/v2/automation/search-batch`:

```json
{ "targetIds": ["opaque-arr-episode-a", "opaque-arr-episode-b"] }
```

The server resolves IDs against a fresh observation, requires one Sonarr
source/show, checks actionable eligibility, and supplies the rest of the show
as related context. Invalid, held, or mixed-show requests return specific
validation/availability errors rather than silently changing the requested set.
Return the usual queued search handle. **This endpoint searches only.**
As an explicit manual action, it may reset ordinary target search retry/backoff
like the existing single-target endpoint; it never bypasses active reservations,
queue grace, provider cooldowns, or unavailable observations. Oversized explicit
requests receive a clear batch-size error; only scheduled work is auto-sliced.

Keep `/api/v2/automation/search` as the single-target entry point. Scheduled
automation builds the same workload internally; it does not call its own HTTP API.

### Extend stored options, not the number of submission endpoints

`GET /api/v2/searches/:id` continues returning ranked alternative `options`.
For episode-set searches, each option is a complete selectable plan:

```json
{
  "optionId": "plan-a",
  "rank": 1,
  "releases": [
    {
      "candidateId": "pack-a",
      "coveredTargetIds": ["e26", "e27"],
      "coverageReason": "These episode titles and absolute numbers align despite different season labels.",
      "uncertainty": "Coverage inferred from release naming; contents not inspected."
    },
    {
      "candidateId": "episode-b",
      "coveredTargetIds": ["e28"],
      "coverageReason": "Matching individual episode.",
      "uncertainty": ""
    }
  ],
  "coveredTargetIds": ["e26", "e27", "e28"],
  "uncoveredTargetIds": ["e29"],
  "coverage": "partial",
  "reason": "Good pack plus one episode; no suitable release found for e29.",
  "uncertainty": "Pack contents are inferred."
}
```

This example illustrates a separate four-target request. Aggregate coverage,
uncovered IDs, and `complete|partial` are computed from the per-release assignments
and original request, not trusted as independent model assertions. Keep concise
uncovered-target explanations when available. `matched` means at least one useful
release, not that all targets were covered or imported.

`POST /api/v2/submissions` keeps its current request:

```json
{ "searchId": "...", "optionId": "plan-a", "idempotencyKey": "..." }
```

It commits **one stored plan**, never all ranked alternatives. The caller does
not resupply release URLs, coverage, or arbitrary candidate IDs. No separate
bulk-download endpoint or auto-submit tool is needed.

MCP shares the schemas: extend `ma_search_v2`/status/submit and add
`ma_automation_search_batch_v2`. Internal LLM `finish` gains release-level coverage
fields; it still cannot grab. Version the prompt/result interpretation so existing
stored searches remain readable and old options are not reinterpreted as batches.

After a completed, failed, or ambiguous acquisition attempt, apply a one-hour
whole-show grace. Then require a fresh complete Sonarr observation before retrying
targets that remain missing and not queued. Agent-assigned coverage is predictive,
not ground truth; Arr's fresh state determines whether target need remains.
Ambiguous sends may be retried after this grace, accepting possible duplicate
downloads. Do not require indefinite physical-release quarantine or an operator
allow-retry workflow. Do not add qBittorrent introspection in this increment.
Search-only/no-match retries remain governed by ordinary target search retry and
provider cooldowns; they do not start acquisition grace. A related hold must not
outlive acquisition grace indefinitely.

## 4. Agent reasoning and validation

Teach the agent to:

- Use titles, aliases, episode names, dates, absolute numbering, release wording,
  and any supplied file evidence together. Season markers are clues, not universal
  identifiers across different editions/providers.
- Treat roughly 10–13/24–26-episode groupings as investigative hints, not rules:
  long-running shows, specials, split cours, and double-length episodes exist.
- Recognize future context and currently airing shows. A partial-season pack may
  cover aired episodes; individual releases are another valid answer.
- Explain alternate-numbering coverage using the supplied context. Reasonable
  inference is allowed; authoritative web research or manifest proof is not a
  prerequisite. Express uncertainty rather than claiming verified completeness.
- Compare whole plans, prefer useful coverage at suitable quality, and avoid
  gratuitous overlapping packs or releases adding no requested coverage.

For the new scope, replace unconditional "wrong Sxx" vetoes and the parser-based
multi-release non-overlap proof with **requested-episode coverage assignments**.
Parser output remains evidence for reasoning, not the authoritative mapping.
An unparseable/`invalid` marker is not automatically proof of wrong content.

Hard validation stays deliberately small:

- Only observed, unexpired candidates and requested target IDs.
- Every selected release must cover at least one requested target; related/future
  episodes can never be assigned acquisition coverage.
- Unique physical releases; assign each requested target to at most one release.
  Actual packs may incidentally contain owned/unrequested/overlapping episodes:
  we do not pretend to selectively download only the assigned files.
- Reject explicit conflicting show identity IDs; unknown IDs alone are acceptable.
- Check per-target exclusions against each release's claimed coverage.
- Require concise coverage rationale; preserve uncertainty. Do not invent a
  deterministic semantic proof engine or treat a confidence percentage as proof.

`SearchService` currently marks a candidate excluded if *any* target excludes it.
Batch candidates instead need `excludedTargetIds`, validated against that release's
coverage; retain legacy semantics for old search scopes.
Keep ordinary target/release-pair failures scoped to those pairs. Any release-
wide barrier after an ambiguous POST is bounded: acquisition grace is at most
one hour, after which a fresh complete Arr observation showing missing and
not-queued targets permits retry. Do not impose indefinite physical-release
quarantine across new target sets or idempotency keys.

This intentionally delegates semantic matching to the agent. Bookkeeping prevents
duplicate/unauthorized work; it does not promise the agent will never misidentify
an episode. Live evaluation and recovery are part of acceptance.

## 5. Multi-release execution and recovery

This is the main necessary backend change beyond richer prompts. Today receipts
contain flat `targets` and `physicalReleases`; reconciliation treats them as a
Cartesian product. That cannot describe packs covering different target subsets.

Persist immutable release-to-target coverage and **incremental per-release
outcomes**, not just an aggregate outcome written after the final POST. Add a
small `submission_releases` journal under the existing parent submission:

- Stable child identity from parent idempotency key + selected candidate.
- Candidate/physical identity, assigned targets, execution order.
- State: prepared, sending, submitted, rejected, uncertain, skipped, not-attempted.
- Timestamps and safe diagnostic outcome; locators remain private candidate data.

Replace the current boolean validation callback with
`send(residualTargetIds) | skipNoNeed | stop(reason)`. An unknown or failed
selected-show observation means stop, not "already satisfied." Add a targeted
show observation path: refresh show metadata, its episodes, and queue without
refetching episodes for every other library show before every release.

Keep download-ID/info-hash correlation privately where available. A recognized
queue row for an earlier child in this plan should suppress that child's mapped
targets, not accidentally the whole collapsed metadata season. Do not arbitrarily
reinterpret coarse/unattributed queue rows from other work: retain conservative
suppression and surface that limitation when a reliable association is unavailable.
This needs fixtures for coarse queue rows as well as exact episode associations.

Flow:

1. Validate the stored plan/expiry and configuration; atomically reserve its
   targets and physical releases against concurrent manual/automation work.
2. Immediately before **each** POST, reobserve the relevant show, verify source,
   settings/client routing, lease ownership, and residual need for that release.
   Skip if all its targets are now owned/queued/unrequested. If only some remain,
   a pack may still be useful; record the remaining actionable targets rather
   than rejecting the entire plan because an earlier release changed the queue.
3. In one transaction, verify ownership, establish/refresh that child's target/
   physical holds, and persist `sending` before the POST; persist its outcome
   before proceeding. Renew plan/resource leases during execution and abort on
   renewal failure; the current fixed 15-minute lease is not a promise a plan
   will finish safely before expiry. Lease loss/abort during an in-flight POST
   does not prove upstream cancellation: keep a sending child ambiguous unless
   a definitive outcome is durably recorded, stop all subsequent POSTs, and
   apply the one-hour acquisition grace followed by a complete fresh Arr read;
   do not retain indefinite quarantine.
4. On definite failure or an uncertain POST, stop the remaining plan. Do not
   automatically submit another ranked alternative or roll back successful grabs.
   Unsent releases are explicit `not-attempted`, not inferred failures.
5. Apply one-hour whole-show acquisition grace after a completed, failed, or
   ambiguous attempt; then use a fresh complete observation to retry only targets
   still missing and not queued. Release unused reservations for skipped/unsent/
   rejected work. Do not let related holds outlive that grace.
6. Reconcile submitted, uncertain, and recovered-sending children against their
   own assigned/residual targets. File/queue changes can satisfy targets
   independently; do not require every episode in the batch to import before
   resolving successful work. A file arriving from an unrelated download resolves
   target need, not certainty about prior physical sends. Retry after grace accepts
   duplicate risk; reliable correlation may improve diagnostics but is not required.

Return per-release outcomes plus aggregate `submitted|partial|uncertain|...`.
Any ambiguous child makes the aggregate `uncertain`, even if earlier releases
succeeded; otherwise mixed successful and failed/unsent children are `partial`.
All resolved without a POST because no need remains is `skipped`; all useful
children submitted is `submitted`. Preserve existing definite error/defer/expiry
outcomes where no release was submitted. `partial` and batch-level `skipped` are
new additive outcomes understood by activity, HTTP, MCP, and UI, not new search
statuses. Expose counts and child outcomes so the summary does not hide success.
A replay of the parent key returns the durable receipt without sending again.
After process death, `sending` is uncertain until reconciled; prepared/unsent work
is not automatically resumed. A later fresh plan may address remaining need only
after the one-hour acquisition grace and a complete fresh Arr observation.

Apply one-hour whole-show acquisition grace after completed/failed/ambiguous
attempts. After grace, a fresh complete Arr observation showing a target missing
and not queued permits a new plan; that does not prove a prior ambiguous POST
failed, and duplicates are an accepted risk. There is no mandatory indefinite
physical quarantine or operator allow-retry workflow. Search-only/no-match does
not enter acquisition grace. No immediate fallback inside the original execution.

Correct content may still fail Sonarr's filename/import mapping. This work does
not rename files or rewrite Sonarr numbering: expose stalled/import-pending work
and avoid a silent repeated-download loop, rather than claiming acquisition
inference alone fixes import compatibility.

Migrate storage additively. Preserve existing single-release receipts and their
current holds; do not fabricate precise mappings for old multi-release receipts.
Reconcile those conservatively on the legacy path until resolved/expired under
the existing policy. Do not reset saved monitoring, dry-run, retries, or credentials.

## 6. Automation and the five-minute delay

**Remove the blanket per-show search cooldown after batch planning is enabled.**
Its purpose was spacing sibling episode searches while Arr caught up. A batch
already accounts for all selected targets and installs local reservations before
Arr has observed anything.

| Mechanism | Proposed behavior |
| --- | --- |
| Five-minute per-show search cooldown | Remove for new show-batch automation; ignore old show-cooldown settings |
| `intervalMinutes` (default five minutes) | Keep as idle observation cadence, not a per-release wait |
| Delay between releases in a selected plan | None intentionally; POST sequentially with fresh checks |
| Acquisition grace (one hour) | Whole-show grace after completed/failed/ambiguous attempt; then fresh complete Arr read |
| Target search retry (default 30 minutes) | Keep for searched-but-uncovered/no-match targets and dry-run searches |
| Failure backoff / provider Retry-After | Keep; operational failures still need pacing |
| Live queue/import-pending suppression | Keep while observed active; not a timed five-minute assumption |

Remove show-cooldown handling from status projections as well as scheduling;
otherwise the UI would still falsely report a show-wide cooldown.

Scheduler algorithm:

1. Observe and reconcile; derive due targets using existing eligibility, target
   retries, reservations, and provider deadlines, **not** a show cooldown.
2. Choose the oldest-due work fairly among shows and movies. Build one show batch
   from its due targets, with other episodes as context.
3. Run one bounded search; automation chooses rank one and executes that plan only
   when enabled and not dry-run. Search-only/manual callers never auto-submit.
4. Update attempts per target: submitted/uncertain -> whole-show acquisition grace;
   uncovered/no-match -> ordinary retry; operational failure -> backoff; unchanged
   unsent targets get appropriate failure retry without being marked downloaded.
   Targets not in this bounded search are not charged a search attempt.
5. Continue immediately to other due work after a completed pass. If nothing is
   due, sleep until the next observation/deadline. Prevent a partial/no-match
   batch from creating a zero-delay loop.

A newly requested/newly aired episode need not wait for an unrelated show-level
retry, but can only be noticed at the next observation unless a user explicitly
refreshes. The entire plan does not wait for Sonarr queue visibility between
releases. Local coverage/reservations bridge that gap.

## 7. Code impact and delivery order (after implementation approval)

1. **Contracts and workload builder:** `contracts.ts`, `arr.ts`, `runtime.ts`,
   `store.ts`; versioned multi-target bindings and a legacy singleton reader;
   preserve episode/movie APIs; fixtures for complete/mixed/airing/collapsed shows.
2. **Read-only batch planner:** `service.ts`, `selection.ts`; new prompt/version,
   per-release coverage, scoped exclusions, partial results, shared bounds. Prove
   search-only behavior before enabling any automation submission.
3. **Journaled plan submission:** `submission.ts`, `store.ts`; incremental receipts,
   residual revalidation, reservations, crash/uncertainty recovery, legacy adapter.
4. **Wire automation and APIs:** `automation.ts`, `runtime.ts`, `daemon.ts`,
   `search/mcp.ts`; whole-show grouping and fairness, remove show cooldown only
   after multi-target holds/reconciliation exist.
5. **Presentation and docs:** show planned coverage, uncovered episodes, per-release
   reasons and partial outcomes. One confirmation means the complete selected
   plan. Activity must not label submitted as imported. Designer involvement and
   rendered review are required for that future UI slice.

Do not ship an intermediate state that merely removes the cooldown or increases
the release array cap without the coverage/reservation changes.

File-list inspection can later be a bounded, read-only `inspect_release` tool
returning sanitized filenames/sizes for observed candidates. It enriches the same
coverage decisions; it is not a prerequisite or part of this initial plan.
CRW and magnet swarm metadata retrieval remain separate follow-ups.

## 8. Acceptance before enabling

- Complete ordinary season -> one good pack where available, all requested targets
  assigned; suitable split packs beat an inferior all-in-one release.
- Multiple seasons / collapsed season metadata -> multiple releases in one plan,
  contextual numbering inference accepted without a blanket same-season veto.
  Include negative cases for unrelated content and unsupported mapping guesses.
- Mixed owned/queued/missing and specials -> only actionable requested targets
  assigned; incidental pack extras are visible, not a new acquisition instruction.
- Airing show -> future episodes inform context but are never acquisition targets;
  partial pack or singles can cover the aired subset.
- No packs -> multiple singles execute sequentially without a five-minute pause.
- Partial/no match -> explicit uncovered set and bounded retry, no busy loop;
  a new episode is not blocked by an old show cooldown.
- Oversized backlog -> deterministic bounded slice, truthful deferred counts,
  fair progress for another show/movie and no starvation from repeated new targets.
- Queue remains stale between POSTs -> local target/physical holds prevent an
  overlapping plan from submitting the same expected work.
- Coarse queue rows from earlier children -> correctly correlated rows use stored
  target mappings, not an accidental whole-show suppression; unknown external
  coarse rows remain conservatively blocked and explain why.
- Arr state changes mid-plan -> skip fully satisfied releases, keep useful residual
  packs, and avoid a false all-targets-must-still-be-missing failure.
- A failed/uncertain second POST, or a crash before/after a POST -> preserve the
  first outcome, do not replay ambiguous work, do not hold unsent targets as if
  they were submitted, and do not exclude every release against every target.
- Source/config change, pause/dry-run, lease loss, expired candidate -> no subsequent
  POST; same idempotency key returns the same durable execution.
- Ambiguous POST -> whole-show acquisition grace delays retry; after grace a
  fresh complete missing/not-queued observation permits retry, with duplicate
  risk accepted. Search-only/no-match uses ordinary target retry instead.
- Upgrade -> old searches/receipts/settings remain readable and safe; movie and
  single-episode APIs and explicit approval boundaries remain intact.

Use real search/submission/storage components with fake external effects for
failure tests. Repeat live search-only evaluations on representative shows; assess
actual selected coverage and release quality, not only schema validity. Any real
download/import trial needs separate authorization. Planning itself requires no
production database reads, model calls, or download-client actions.
