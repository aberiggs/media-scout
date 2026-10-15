# Proposal

## Why

[Issue #11](https://github.com/aberiggs/media-scout/issues/11) needs reliable weekly episode discovery without redownloading imported or covered episodes. Investigation confirmed premature date-only eligibility, season-wide blocking after an empty candidate search, and missing lifecycle-aware search orchestration; these mechanisms are reproduced with synthetic inputs, not established as Blue Box's production history.

## What Changes

- Make episode observations and scheduling progress durable, retaining existing season work keys and acquisition/intent history for compatibility. A season is a planning/dashboard aggregate, not a single indivisible retry target.
- Prefer Sonarr's precise UTC airtime; distinguish awaiting airtime, unknown airtime, aired/unavailable, downloading, imported, and safety-held targets.
- Treat an ordinary successful search with no usable release as retryable unavailability for the attempted TV episode targets, not an indefinite season-wide manual hold. Preserve actual identity, configuration, operational, queue, and intent safety holds.
- Supply explicit season lifecycle and episode timing context to planning. Execute bounded pack/batch-first searches for substantial backfills with explicit episode fallback for uncovered due targets; use episode-first searches for caught-up airing seasons.
- Keep pack captures limited to currently authorized eligible episode IDs. Newly discovered episodes never widen an in-flight capture, and only positive library file evidence proves completion.
- Add SQLite-backed multi-cycle regression tests before behavior changes, migration/lease/safety tests, and operations API/UI explanations of episode progress and holds.
- Add conservative legacy compatibility: preserve reviews/audit history and safety reservations; convert only demonstrably ordinary, unlinked TV empty-search holds to the new retry policy under fresh identity-matched evidence.

## Capabilities

### New Capabilities

- `episode-lifecycle`: Durable per-episode observation, eligibility, retry state, aggregation, compatibility, and safety-preserving reconciliation.
- `tv-acquisition-planning`: Lifecycle-aware, bounded pack/episode search stages and exact episode capture across grouped acquisitions.
- `episode-progress-visibility`: Safe episode/season progress projections and operator explanations distinguishing airtime, availability, downloads, and uncertainty.

### Modified Capabilities

None. This repository has no existing main capability specs.

## Impact

- Backend: `src/types/sonarr.ts`, watcher, state/migrations, work queue, grouped context/contracts, planner/picker, runner, operations projections, and shared status/operator/MCP seams affected by scheduling changes.
- Frontend: existing Queue/Reviews presentation and API types in `web/`; retain the season-level entry point with episode detail and explicit next eligibility.
- Tests: watcher/types/client, SQLite state and migration, work queue, grouped planning/coverage, runner, review policy, operations API/UI, operator/MCP compatibility. No new external dependency is expected.
- Persisted schema additions and additive safe API fields; preserve `media-agent` identifiers, existing work keys, claims, receipts, dedupe, queue associations, and recovery history. No production database rewrite or rollout is performed during implementation verification.
- Non-goals: query-numbering strategy overhaul, indexer routing, model benchmarking, RSS ingestion, movie retry-policy changes, blanket review dismissal, clearing uncertain downloads, deployment or live evaluation.
- Runtime evidence still needed to explain the historical report: deployed revision and sanitized Sonarr observations, review reasons/targets, queries, queue coverage, and intent transitions. This evidence is not required to reproduce and fix the confirmed synthetic failure paths; do not claim historical attribution without it.
