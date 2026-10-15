# Spec Delta

## Purpose

Give operators a truthful season summary and safe episode-level explanations of availability, scheduling, imports, and download uncertainty.

## ADDED Requirements

### Requirement: Season summaries distinguish caught up from complete
The operations API and dashboard SHALL retain season-level navigation while exposing episode progress and lifecycle confidence. Imported, aired missing, future, timing-unknown, downloading/reserved, and held targets SHALL be distinguishable without treating overlapping coverage counts as separate episodes.

#### Scenario: All aired episodes imported but future episodes remain
- **WHEN** E1 is imported and E2 has a future airtime
- **THEN** the season is shown as caught up and awaiting airtime, not fully imported or awaiting manual review

#### Scenario: All observed episodes imported with uncertain schedule
- **WHEN** all known episodes have files but the schedule does not establish that the season finished airing
- **THEN** the UI distinguishes known inventory completion from confirmed airing completion

### Requirement: Episode details explain scheduling and safety
Safe episode details SHALL expose season/episode labels, timing basis, next eligibility or retry time, progress, and an explicit hold reason. Unknown timing, waiting for a release, active download, unknown observation, and queue/intent ambiguity SHALL have distinct explanations.

#### Scenario: Release not available yet
- **WHEN** a known aired episode has an ordinary empty-search outcome
- **THEN** the UI shows a release retry and its deadline rather than requiring manual review

#### Scenario: E1 uncertainty affects E2
- **WHEN** uncertain E1 download coverage conservatively holds E2
- **THEN** the UI explains the affected scope and safety reason without suggesting that E2 merely has not aired

### Requirement: Existing interfaces remain safe and compatible
New progress fields SHALL be additive to existing operations responses and use existing pagination, freshness, and action gates. HTTP and MCP status projections SHALL agree on eligibility and hold meaning. UI refresh SHALL remain read-only and SHALL not trigger searches or release reservations.

#### Scenario: Unknown or stale observations
- **WHEN** saved episode progress exists but its required source observations are unknown or stale
- **THEN** the UI displays that uncertainty and does not enable an unsafe action based on the saved progress

#### Scenario: Safe data projection
- **WHEN** episode details and acquisition diagnostics are requested
- **THEN** responses omit API keys, hashes, GUIDs, private release URLs, raw queue messages, and claim owner tokens
