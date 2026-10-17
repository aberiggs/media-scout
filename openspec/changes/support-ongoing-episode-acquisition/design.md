# Design

## Context

See `proposal.md` for motivation and production-attribution limits. Current `work_items` hold a season's missing inventory in JSON and one scheduling status/deadline. `eligibleWorkUnits` filters by date-only `airDate`; reconciliation separately subtracts episode-ID coverage. `finishNoSuitableRelease` creates a season-wide manual hold. Group planning executes one batch of 1–3 queries, with no conditional fallback. The Queue API projects season counts without a full episode inventory.

The existing owner-checked work/series leases, immutable intent captures, fresh pre-grab reconciliation, positive-file fulfillment, unknown-vs-empty reads, and operator recovery lane remain constraints, not replacement targets. `tests/review-policy.test.ts` currently asserts the old empty-search manual behavior; update that contract only after a new reproduction fails for the intended reason.

## Goals / Non-Goals

**Goals:**
- Introduce one authoritative persisted episode progress model while preserving season coordination and existing evidence references.
- Make the exact persisted weekly transition and the premature-search/empty-search failure chains deterministic offline tests.
- Separate scheduling policy from LLM query wording and release judgments.
- Expose additive progress data without weakening action gates or leaking private state.

**Non-Goals:**
- No global scheduler rewrite, episode-key replacement of historical season work, or automatic production migration exercise.
- No claim that a season-pack title proves torrent contents; avoiding duplicate target reservations does not guarantee a pack contains no already-imported files.
- No movie policy change, general indexer/naming overhaul, live-model evaluation, blanket title-review deletion, or removal of genuine safety holds.

## Decisions

### 1. Persist episode progress alongside stable season work

Add an additive SQLite episode-progress table owned by the existing State boundary. Its identity binds Sonarr service/series ID, durable external series identity, and episode ID. Retain season number, seasonal/absolute numbering, library title, monitoring/file observations, precise and calendar timing, observation time/knowledge, scheduling deadline, attempt time/outcome, and explicit hold scope/reason. Episode IDs are stable identity within the observed series; numbering is metadata, not a primary key.

Observe all episodes, including imported ones, so counts are not reconstructed from an ever-shrinking missing list. Keep observation facts separate from derived eligibility and acquisition state. Do not copy credentials, upstream response bodies, or private release identifiers into this table. Existing intents/queue evidence remain authoritative for reservations; derive held coverage rather than creating a second competing reservation ledger.

Season work keys, coverage keys, and series coordination leases remain unchanged. Build the aggregate from episode state; use per-episode deadlines to construct actionable target subsets. Keep season-wide operational/safety blocks where their scope cannot be proven narrower. Aggregate deadlines summarize the earliest actionable episode; they must not suppress another due episode or override a source rate-limit deadline.

Apply episode updates, aggregate scheduling, and associated attempt outcomes transactionally under the existing work lease (and series lease where group coordination requires it). Reject stale/out-of-order observations and stale owners. Reads for HTTP/MCP must not update state. Manual search/pick and Retry/Reset must use the same episode eligibility ceiling; Reset must not erase facts, reservations, or historical captures.

Alternative rejected: replace every season key with an episode key. That would require rewriting intent/review/association references and leases unnecessarily. Keeping only JSON missing arrays with season-wide deadlines would retain the demonstrated coupling.

### 2. Normalize timing once and preserve uncertainty

Parse optional `airDateUtc` and relevant Sonarr lifecycle context (series status, season next/previous airing and episode finale evidence when present). Use a shared deterministic timing rule across watcher, reconciliation, runner, and projections:

1. A valid precise UTC airtime is authoritative, even when a calendar date differs.
2. With no usable precise timestamp, a strictly valid calendar date becomes eligible at the start of the following UTC day. This conservative fallback avoids inventing midnight-at-start airtime and is labeled `date-only`.
3. With neither, retain `timing-unknown` and do not search.

An episode must still be monitored, missing, freshly known, and free of applicable safety holds. Reconcile at the normal monitoring cadence; store next eligibility for visibility, without adding per-episode timers or promising an exact wall-clock search.

Lifecycle is separate from import progress. Future known episodes establish an airing/scheduled context; positive finale/ended-plus-season evidence can establish a finished-airing context. Without sufficient evidence use `unknown`, not inferred completion merely because future episodes are absent. A substantial aired backlog can still justify pack search under unknown lifecycle. Series `continuing` alone never classifies every season as airing.

Alternative rejected: retain lexicographic calendar-date comparisons or make the LLM decide eligibility. Neither provides deterministic timing or safe boundary behavior.

### 3. Empty TV searches are episode availability outcomes

Only attributed, actually attempted TV episode IDs receive `release-unavailable` and a retry deadline. Reuse the existing configured retry window (`minRetryHours`) for this change; do not add a separate tuning UI or silently change the configured cadence. New eligible episodes have their own deadlines and remain due. Query failures/rate limits remain operational backoff, not negative availability evidence. Source Retry-After and existing repeated-failure/configuration/identity policies remain enforced.

Do not create `no-suitable-release` manual reviews for new ordinary TV misses. Existing movie behavior remains unchanged. Candidate title parsing remains deterministic diagnostic evidence; existing title-review cleanup is not broadened into blanket resolution.

For legacy ordinary unlinked TV `no-suitable-release` holds, reconcile under a claim using fresh known identity-matched library and queue evidence. If no other blocking review, live claim conflict, reservation, ambiguous queue, or identity/configuration safety condition applies, resolve only that ordinary review as a policy conversion (not proof of import), preserving its row/history. Initialize current eligible episodes to a finite retry deadline no earlier than a still-applicable prior deadline; schedule a converted unknown-history miss one configured retry window after conversion. Unknown historical targets are not fabricated. Linked or insufficiently evidenced holds remain held with an explanation.

Alternative rejected: clear every season review on a new episode, or simply remove all manual-review gates. Both bypass real safety evidence and obscure historical uncertainty.

### 4. Explicit staged search policy with a fixed budget

Use structured stage intent and exact episode attribution in the planner contract; continue letting the LLM choose query strings and judge fuzzy identity/quality. Supply timing/lifecycle and real imported/future/eligible/held counts, not `missingCount - eligibleCount` mislabeled as download-held count.

Initial policy defaults for this scoped implementation:
- A caught-up airing season with one or two due episodes uses episode-first queries.
- Three or more due aired episodes constitute a substantial backlog and allow pack/batch-first, irrespective of whether lifecycle is finished or unknown. This threshold is a simple explicit policy constant, not proof a pack exists.
- A group pass uses at most six queries total: up to three primary queries, then up to three episode fallback queries if budget remains. Episode-first groups share the same total cap; there is no need to execute a redundant pack stage.
- Keep the existing maximum of three selected physical releases per pass. Fallback targets exclude provisional selected coverage and all held/imported/ineligible targets.

For pack-first work, run the primary stage and provisionally select acceptable coverage. Run fallback for still-uncovered due episodes, including when pack candidates existed but none were acceptable. A genuine picker-manual identity decision remains a review for its affected scope; do not override it through fallback. Validate the combined selection for physical duplication and overlapping original footprints before any submission. Refresh evidence again immediately before each actual grab, using the existing claim/capture ceiling.

Only executed query attributions count as attempts. Prefer oldest unattempted due episodes with a stable episode-ID tie-break; persist attempt timing so bounded passes do not repeatedly choose only the first episodes. Budget-deferred episodes remain due. Stop on rate limits and preserve unattempted targets. Stage-aware search history records bounded safe attribution; do not store raw private release payloads.

Packs are acquisition candidates, not durable completion units. Capture only authorized eligible episode IDs, label inferred pack coverage, preserve wider advertised-footprint overlap checks, and never reserve newly aired/discovered targets by widening an existing claim.

Alternative rejected: prompt-only pack-first advice, unbounded per-episode loops, or running every fallback even when coverage is already satisfied. These respectively fail to guarantee behavior or increase cost/duplicate risk.

### 5. Keep the season entry point and add episode explanations

Extend operations responses with a safe episode progress summary, lifecycle confidence, earliest future eligibility, earliest availability retry, and paginated episode details using the existing operations conventions. Keep current season work keys and existing response fields usable. Separate known file completion from finished-airing confidence; render `Caught up · awaiting airtime` when appropriate instead of misleading `Complete` or generic waiting text.

Coverage counts are unique episode unions; observed/reserved evidence can overlap and must not double-count progress. Unknown/stale observations remain explicit. Episode details show timing basis, progress, and scoped hold explanations without owner tokens, private URLs, release identifiers, or raw queue messages. Update MCP status consistently, retaining its safe coarse projection. Reuse current action gates and recovery flow; browsing and refresh never mutate scheduling.

Alternative rejected: flatten the Queue into hundreds of independent episode rows or expose raw work/queue JSON. Neither is needed for episode-level scheduling and both degrade usability or privacy.

## Risks / Trade-offs

- [Additive episode state and season aggregate diverge] → One transactional State boundary, deterministic aggregate derivation, restart tests, and explicit no-dual-authority rules.
- [Date-only fallback delays searches] → Prefer precise UTC, expose the fallback basis, and test midnight/timezone boundaries; accept conservative delay instead of premature eligibility.
- [More fallback searches increase cost] → Six-query/three-selection cap, exact attribution, fairness, and source-wide rate-limit stop behavior. No live evaluation in ordinary checks.
- [Legacy migration releases an unsafe hold] → Resolve only ordinary unlinked TV availability reviews under fresh matching evidence; preserve linked/configuration/identity/queue holds and all intent/dedupe rows.
- [Episode metadata changes or IDs are reused] → Bind external identity and captured fingerprints, reject stale observations, and revalidate selected coverage before submission.
- [Physical pack contains imported or future content] → Do not claim inspected contents; retain inferred coverage and wider advertised-scope checks. Never treat a pack as import evidence.
- [Old binary ignores the new episode scheduling model] → Do not promise mixed-version writers or binary-only rollback; use the stopped-writer backup/restore process below.

## Migration Plan

1. Add deterministic synthetic replay fixtures; record intended pre-fix assertion failures before implementation. Do not commit a failing-only checkpoint.
2. Add idempotent schema initialization and claim-checked persistence. Test opening old schemas, repeated opens, and incomplete legacy evidence with isolated databases.
3. On fresh known reconciliation, backfill observed episodes from Sonarr and conservatively inherit existing scheduling/safety evidence. Leave legacy identity/queue/intent captures untouched; initialize absent timing/file facts as unknown. Activate only one authoritative episode scheduling path for TV, keeping movie behavior intact.
4. Convert eligible ordinary legacy empty-search holds only through the reviewed guarded path. Retain explicit reasons for holds that cannot safely convert.
5. Verify persisted multi-cycle replay, leases, candidate/intent safety, APIs/UI, all project software checks, and available container native-addon checks before a coherent checkpoint. Record unavailable architecture/container checks as blockers, not passes.
6. Document deployment backup requirements without deploying: stop all writers and take a consistent SQLite backup as described in `docs/operations.md`. Do not run old and new writer versions together. Rollback requires stopping writers and restoring the pre-upgrade backup with its matching binary; post-upgrade observations would otherwise be lost and require deliberate reconciliation. No destructive down migration.
