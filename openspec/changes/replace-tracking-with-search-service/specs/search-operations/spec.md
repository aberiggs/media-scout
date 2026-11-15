## Purpose

Make search and automation observable through safe audit history and a simple interface, using a fresh database rather than retaining the old tracking engine as an authority.

## ADDED Requirements

### Requirement: Audit does not own library truth
Persistence SHALL retain search requests, query events, recommendations, submission outcomes, retry timing and source backoff. Observation caches SHALL declare time/completeness and SHALL not authorize grabs or override current Arr data. Audit write failure SHALL prevent unrecorded submissions.

#### Scenario: Previous completion conflicts with fresh missing data
- **WHEN** current Arr data reports a target with a prior successful attempt missing
- **THEN** the new audit remains readable but does not veto the new observation

### Requirement: Attributable bounded history
Activity SHALL distinguish planning/tool failure, zero results, unsuitable candidates, no-match, budget exhaustion, recommendation, dry-run and per-release submission outcomes. Retention SHALL be disclosed and default to 30 days/10,000 searches. Pruning SHALL not erase active deadlines, appearance grace or idempotency protection.

#### Scenario: Search fails before an indexer call
- **WHEN** the model fails before making a query
- **THEN** Activity shows a failed attempt without inventing a query or claiming nothing suitable existed

#### Scenario: Submit-capable material expires
- **WHEN** a completed search is older than the 30-minute candidate lifetime
- **THEN** readable audit remains within retention but submission requires a new search

### Requirement: Search-first navigation
The UI SHALL provide Search, Activity, Automation and Settings. Search SHALL show progress, ranked alternatives, reasons, uncertainty and explicit submission confirmation including an easy choice among enabled server-listed download clients. Automation SHALL show Arr-derived per-item status/freshness and next timing. Active Reviews/Reset/reservation-release controls SHALL be absent.

#### Scenario: Review a recommendation
- **WHEN** a user opens a matched search
- **THEN** the best option and alternatives are distinguishable and nothing downloads without an explicit submission action

### Requirement: Accessible truthful interactions
Views SHALL provide keyboard navigation, labeled controls, confirmation focus management and usable narrow layouts. Loading, error, empty, stale and unknown states SHALL be explicit and not color-only. Submitted, downloading and imported SHALL remain distinct.

#### Scenario: Keyboard submit confirmation
- **WHEN** a keyboard user opens and cancels submission on a narrow screen
- **THEN** focus is managed and restored and no horizontal page overflow is required

### Requirement: Fresh database boundary
The application SHALL persist its new state across normal restarts. It SHALL fail fast with clear fresh-database-path instructions when pointed at a nonempty legacy database. It SHALL NOT delete or modify that database automatically, migrate/copy legacy history, preserve legacy tombstones, run a dual engine or add old-interface retirement scaffolding. Runtime identifiers and connection/settings configuration SHALL remain easy to configure.

#### Scenario: Existing legacy database is configured
- **WHEN** startup detects an existing nonempty legacy database
- **THEN** it fails clearly with instructions to configure a fresh database path and leaves the old database untouched

#### Scenario: Normal restart
- **WHEN** the application restarts using its new database
- **THEN** new search and submission state persists without a legacy migration path

### Requirement: Runtime configuration remains recognizable
Health endpoints, runtime identifiers and connection settings SHALL remain available to configure the replacement. The replacement SHALL NOT retain an old/new engine or old-API compatibility layer.

#### Scenario: Configure replacement runtime
- **WHEN** an operator opens health and settings on the replacement
- **THEN** runtime identifiers and current connection configuration are available without invoking old-engine interfaces

### Requirement: Sensitive material stays private
Public projections SHALL use allowlisted metadata and safe errors, omitting secrets and private release locators. Model context SHALL exclude credentials, paths, private URLs and raw production exports. History SHALL not store or display hidden chain-of-thought.

#### Scenario: Provider error includes authenticated URL
- **WHEN** an upstream failure contains secret-bearing material
- **THEN** UI/API/MCP/log output contains only the safe code/status and no sensitive response body or URL

### Requirement: Rollback is deliberate
Operator documentation SHALL require consistent pre-upgrade backup, stopped writers and restore with the matching prior binary for rollback. It SHALL explain that external downloads are not undone by database restore and live validation/deployment is separately authorized.

#### Scenario: Rollback after a submission
- **WHEN** an operator follows rollback instructions after new-version downloads were submitted
- **THEN** the instructions require accounting for those external jobs before the old engine resumes
