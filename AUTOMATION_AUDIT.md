# Automation product audit

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
