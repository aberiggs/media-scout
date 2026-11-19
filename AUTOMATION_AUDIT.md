# Automation product audit

The original audit sections below describe the initial audit against the
pre-batch runtime. Follow-up sections record subsequent work; historical gaps
are not assertions that every later search scope still has those behaviors.

## Scope and acceptance

Trace requests **after Seerr has populated Sonarr/Radarr**, through observation,
eligibility, LLM search, selection validation, and submission guards. Exercise
ordinary season packs, partial episode workloads, conflicting anime numbering,
and overlapping pack submissions.

This increment adds characterization tests, not production fixes. No live grab
requests, production database writes, monitoring changes, or saved-setting
changes are authorized by this audit. Live searches use an in-memory store and
a search-only dependency surface without a submission service. Submission tests
use an in-memory database and a fake `grab` function with no network effects.

## Findings

### Unsupported workflow: evidence-backed alternate season numbering

Automation always supplies one episode and one target
(`src/search/automation.ts:79–89`). The validator rejects any explicit season
claim differing from that target (`src/search/selection.ts:24`), even if absolute
numbering is supplied and the model explains an alternative numbering scheme.
There is no explicit mapping/evidence contract between release numbering and Arr
numbering. This is a missing capability for the requested workflow, not proof
that rejecting an unmapped season conflict is wrong. The model's only tools list
indexers and search releases; it cannot
consult an authoritative episode-mapping service.

Synthetic examples: an Arr S01E26 / absolute 26 request rejects both `S02E01`
and an `S02` pack. These examples do **not** establish that those episodes are
equivalent for any particular edition of Re:Zero.

A live search for the hypothetical collapsed-numbering Re:Zero request reproduced
the rejection: 7 decisions, 5 searches, 147 physical candidates, two
`explicit wrong season` rejections, final `failed`, zero options. The user-facing
message was only “Search unavailable or invalid model output.” That generic
error obscures the actual conflict; it does not prove an equivalent release was
incorrectly rejected.

**Recommendation:** introduce explicit, evidence-backed episode mapping before
relaxing season guards. Unresolved mappings should surface as an actionable
ambiguity, not a generic failed search. Letting an LLM simply waive conflicts
would remove useful protection against downloading the wrong season.

### High: important safety checks still depend solely on model compliance

`SearchService` provides external IDs and parsed scope to the model, but its
deterministic validation passes candidate IDs, target IDs, and coverage only
(`src/search/service.ts:169–172`). It does not compare release TVDB/TMDB IDs with
the request. A scripted model selecting an explicitly wrong TVDB ID reaches the
fake submission boundary.

The validator also accepts an episode candidate with coverage `kind: none`:
it rejects explicit contradictions but does not require usable evidence
(`src/search/selection.ts:20–28`). `Anime Complete 1080p` demonstrates this path.
The system prompt asks for stronger behavior than the executable guard enforces.

For season requests, target IDs are validated for membership, not whether the
release evidence covers each target's episode. The validator does not receive
target-to-episode bindings. An actual season search with a target bound to E14
accepts E01-only evidence claiming coverage of that target.

**Recommendation:** reject explicit identity conflicts; distinguish missing scope
evidence from positive coverage; validate claimed targets using their episode
bindings and any approved numbering mappings. Unknown identity metadata alone
should not become a mandatory rejection.

### Medium: full-season intent becomes independent episode work

Automation never constructs a season-wide plan. It picks one eligible target;
episode options must contain exactly one release
(`src/search/selection.ts:15`). Thus a same-season pack can be selected, but
automation cannot express a multi-pack plan for a collapsed season. Even explicit
season searches allow at most three releases (`contracts.ts:18`), and combining
season-only packs lacks the episode evidence required by the non-overlap check
(`selection.ts:30–36`).

The model receives no sibling missing/owned/queued episode inventory in an
automation search. A pack selected for one episode only reserves that target.
Physical-release grace prevents an immediate duplicate submission for a sibling,
but does not prevent the sibling's redundant search. The new test demonstrates
one fake grab, then a matched sibling search whose submission is deferred.

**Recommendation:** plan against the show's eligible missing-episode set and
record a pack's justified coverage across targets. Preserve imported/queued,
unmonitored, and unaired distinctions. Do not label inferred pack completeness
as verified content.

## What worked

- Existing observation tests distinguish missing, owned, unavailable,
  unmonitored, episode-queued, season-queued, and import-pending items.
- Failed observations are not treated as an empty library. Scoped episode-read
  failures are exposed separately without preventing unrelated work.
- Show cooldown, target retry, provider cooldown, source fingerprints, fresh
  pre-submit validation, physical-release reservations, and durable idempotency
  provide useful independent protections.
- A live Frieren explicit-season search matched 3 alternative single-pack
  options after 1 search / 2 decisions / 90 candidates. The request included
  target episodes 1, 14, and 28; this was **not** manifest verification of all 28.
- A live Big Buck Bunny movie search matched 3 alternatives after 1 search /
  2 decisions / 12 candidates.

All three live searches used `z-ai/glm-5.3-flash`. They establish search behavior,
not successful download, Arr import, or completeness.

## Verification and remaining boundaries

`tests/automation-product-audit.test.ts` adds 8 scenarios using real
`ArrAutomation`, `SearchService`, `SubmissionService`, and SQLite storage with
fake external boundaries. Tests marked **GAP** intentionally characterize
defects; update those expectations when fixing the underlying behavior.

Checks: backend tests and TypeScript; web tests and TypeScript. No UI code changed.

Not established: real Seerr request ingestion/approval, a concurrent multi-user
burst, native Arr search races, actual Re:Zero metadata equivalence, torrent file
contents, real download-client routing, and successful Arr imports. Those are
separate integration acceptance scenarios; no-download authorization precludes
proving the last two here.

## Offline characterization follow-up (November 2026)

Added an offline, synthetic episode-set probe in
`tests/search-episode-set-service.test.ts`. It follows the real
`ArrObserver -> buildEpisodeSetRequest -> SearchService -> SQLite` path with
fake Arr/Prowlarr and a scripted LLM. It models a collapsed metadata season with
synthetic season-label ranges for both reported shapes (four release seasons vs
collapsed S1 for Re:Zero; two vs one for Kaiju No.  8), broad then refined
alias/season queries, and partial plans including one where a release pack is
missing. A queue-covered related episode is context-only. A separate negative probe
characterizes rejection of an explicit unrelated TVDB ID and a related/future
episode reference used as requested coverage. A real `SubmissionService` is
invoked against the stored match and remains blocked; fake grab is not called.

These probes demonstrate pipeline/schema/validation/persistence contracts, not
real LLM reasoning, public metadata equivalence, or actual episode correspondence
for Re:Zero or Kaiju No. 8. The range fixtures are invented test data. No live
search was run by this increment; authorized read-only live evaluation remains
pending separately. No production code, live API, model, download, or web files
were changed. The older findings above describe historical audit observations,
not universal claims about current live behavior or those shows' factual mappings.

## Search-only workflow tuning (November 2026)

The user authorized real model/indexer evaluation, but no download requests.
`scripts/evaluate-anime-search.ts` reads existing SQLite settings read-only, runs
the real search service with an in-memory store, and exposes only indexer/status/
search reads. It has no submission service or grab dependency. Its synthetic
collapsed-S1 inventories contain 85 Re:Zero or 23 Kaiju No. 8 targets; these are
test workloads, not reads or verified representations of the user's Sonarr/TMDB
library. Owned/queued specials and a future episode are context-only.

Prompt version `episode-set-2` encourages broad discovery and gap refinement,
reasonable numbering inference, useful packs with incidental extras, and partial
progress. It distinguishes main-story content from specials/print results and
does not infer all-season completeness from a bare title/year. One strong plan
is sufficient; five alternatives are not a quota. Semantic coverage still
depends on the model, not a deterministic episode-mapping proof.

Workflow changes retain distinct/conflicting observations while deduplicating
identical evidence. Repeated queries with the same effective healthy indexer and
category scope are not resent. Query results report new candidate/observation
counts. Configured constructor budgets now actually apply above the old default
ceiling: an offline reproduction previously stopped at 12 searches despite a
configured allowance of 30. New defaults are 40 decisions / 30 searches; settings
accept 80 / 60. Saved lower values remain unchanged and honored.

### Timeout evidence and evaluation policy

Initial real runs with `z-ai/glm-5.3-flash` hit the model client's 60-second
deadline: Re:Zero before its first query, Kaiju after one query. Model-only
replays completed at 109 seconds for Re:Zero's first query and 69 seconds for
Kaiju's next decision. A prompt-append probe completed Re:Zero's first query in
48 seconds but Kaiju timed out at 180 seconds. These do not establish a provider
root cause or a reliable latency improvement from prompting.

At the user's request the evaluation harness allows ten minutes per model and
Prowlarr call, with a thirty-minute overall deadline and a forty-five-minute
claimed worker lease. Boundary timings separate model time from indexer time.
Production model/Prowlarr timeouts and saved settings were not changed. The model
client supports bounded per-call timeout overrides and reports a safe actionable
model-timeout message rather than a generic invalid-output error.

### Live results

- **Kaiju, realistic full-workload request:** matched after one broad query,
  two model decisions, 297 physical candidates, about 90 seconds overall.
  The single ranked plan assigns targets 1–12 to a SubsPlease S1 pack and 13–23
  to an Anime Time S2 pack, with inferred coverage and incidental NC extras.
  Prowlarr search took about 4.9 seconds; model decisions about 41 and 44 seconds.
- **Re:Zero, initial full-workload pilot:** matched after four queries and five
  decisions, 117 physical candidates, about 366 seconds overall. Rank one uses
  an Anime Time S1+S2 pack, Judas S3 and Judas S4, assigning 1–50, 51–66 and
  67–85 respectively. Its final model decision took about 309 seconds; each
  indexer query took about four seconds. A repeat with the cleaned-up request
  remains pending.
- **Harness correction:** the initial request unnecessarily instructed the model
  not to assume factual mappings and supplied fabricated episode titles. Kaiju
  returned unexplained `needs-input` despite plausible packs. The corrected
  request is ordinary acquisition intent permitting reasonable inference; the
  synthetic-data caveat stays in the report. This is a changed-input evaluation,
  not a controlled claim that prompt tuning alone caused success.

These plans have plausible release-title coverage, not inspected contents.
Official references corroborate seasonal/absolute numbering as useful evidence:
https://kaiju-no8.net/en/ lists episodes through 23 and seasons 1/2;
https://kadokawa-anime.com/titles/entry-224.html labels Re:Zero season 4 and
episodes starting at 67. Neither proves the user's metadata or torrent contents.
All live probes made zero download submissions. Actual import behavior,
automatic batch submission, and one-hour acquisition grace remain unimplemented
or unverified; the batch submission guard is still enabled.

### Checks for this increment

- Backend: 480 tests passing, TypeScript and diff checks passing.
- Harness: standalone strict TypeScript check passing.
- Web: 33 tests, TypeScript and production build passing. The only newly delivered
  UI change is the settings-cap display; pre-existing batch UI work remains
  uncommitted and excluded from publication.
- Settings caps rendered at 1440×1000 and 390×844 with mock API boundaries:
  80/60 values saved, a simulated 503 preserved drafts, retry succeeded.
  No application exceptions or unexpected console errors; the injected 503
  produced the expected browser resource error. This does not validate the
  unfinished batch UI or real settings writes.

Jev evaluation is tracked separately in issue #50:
https://github.com/aberiggs/media-scout/issues/50.
