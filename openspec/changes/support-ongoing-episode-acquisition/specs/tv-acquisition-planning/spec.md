# Spec Delta

## Purpose

Plan season and episode acquisitions using explicit lifecycle context while keeping query costs bounded and download authorization tied to exact eligible targets.

## ADDED Requirements

### Requirement: Plans receive explicit lifecycle context
TV planning SHALL receive known episode timing, imported/future/eligible/held counts, due target descriptions, and the confidence of season lifecycle evidence. A continuing series SHALL not imply every season is airing, and absence of future metadata SHALL not prove a season finished airing.

#### Scenario: Continuing series with different season states
- **WHEN** a continuing series has an old backfill season and a current season with future episodes
- **THEN** the planner receives distinct season contexts and independently actionable episode targets

#### Scenario: Incomplete schedule
- **WHEN** there are no known future episodes but season completion is unconfirmed
- **THEN** planning identifies lifecycle uncertainty rather than asserting the season is finished

### Requirement: Search stages reflect the acquisition context
Caught-up airing seasons SHALL use episode-first searches for newly due episodes. Substantial aired backlogs SHALL support pack/batch-first searches followed by explicit episode fallback for uncovered due targets when a suitable pack is absent, insufficient, or rejected. Search stage progression SHALL be executable policy, not only prompt advice.

#### Scenario: One weekly episode is due
- **WHEN** an airing season has one due missing episode and earlier aired episodes are imported or covered
- **THEN** the initial search stage explicitly targets that episode, not a required full-season pack

#### Scenario: No acceptable pack is available
- **WHEN** a backfill pack stage yields no acceptable selection for its due episodes
- **THEN** an episode-targeted fallback stage executes within the pass budget before those attempted targets are recorded unavailable

#### Scenario: Partial acquisition leaves due episodes
- **WHEN** an acceptable pack or batch covers only some actionable due targets
- **THEN** uncovered due episodes can enter the bounded fallback stage without overlapping the provisional acquisition

### Requirement: Search and acquisition budgets remain bounded and fair
Each group processing pass SHALL have explicit query and physical-release selection limits. Targets not attempted because the budget is exhausted SHALL remain due, not be marked unavailable or failed. Repeated passes SHALL prioritize older unattempted due targets so a large season does not starve later episodes.

#### Scenario: Backlog exceeds one pass
- **WHEN** a backlog requires more episode searches than one pass permits
- **THEN** only attributed attempted targets receive attempt timing, remaining due targets are retained, and subsequent passes progress through the backlog

#### Scenario: Upstream rate limit interrupts fallback
- **WHEN** an upstream rate limit is returned during either search stage
- **THEN** search stops, the retry deadline is honored, and unattempted targets are not reported as searched or unavailable

### Requirement: Acquisition coverage is exact and revalidated
Every selected release SHALL capture only authorized eligible episode IDs from the current claim, excluding imported, held, or provisionally selected targets. Pack coverage inferred from a title SHALL remain labeled inferred. Search success and grab submission SHALL not prove import.

#### Scenario: Pack advertised for an ongoing season
- **WHEN** a matching pack is selected while later episodes remain unaired
- **THEN** its authorized capture excludes unaired targets and does not mark future episodes covered or imported

#### Scenario: Episode becomes eligible during an in-flight claim
- **WHEN** another episode is discovered or reaches airtime after initial target capture
- **THEN** it is excluded from that acquisition and is reconsidered on a subsequent safe pass

#### Scenario: Coverage changes before submission
- **WHEN** a target imports, becomes unmonitored, changes identity, or acquires conflicting coverage before submission
- **THEN** the selection is revalidated and cannot submit a duplicate or stale acquisition

### Requirement: Diagnostics preserve stage and target attribution
Search history SHALL identify the pack/batch or episode stage, attributed target scope, result outcome, and whether fallback or budget exhaustion occurred. Candidate parsing diagnostics SHALL not masquerade as reviews of unaired episodes. Diagnostic projections SHALL exclude credentials and private release identifiers.

#### Scenario: Pack search fails to find a usable release and fallback succeeds
- **WHEN** a fallback episode search leads to a valid acquisition after an unsuccessful pack stage
- **THEN** history records both attempts with their stages and target attribution without calling the entire season unavailable
