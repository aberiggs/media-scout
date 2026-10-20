## Purpose

Keep ordinary release waiting automatic while retaining evidence-backed, recoverable reviews for real acquisition and download uncertainty.

## ADDED Requirements

### Requirement: Metadata gates release searches
The system SHALL wait without release searches or availability reviews until Radarr reports a movie available or Sonarr episode timing establishes eligibility. Missing or unknown metadata SHALL NOT prove availability.

#### Scenario: Unreleased movie becomes available
- **WHEN** a monitored missing movie is unavailable on one known poll and available on a later known poll
- **THEN** it waits without searches or retry deadlines before that transition and becomes eligible afterward, subject to independent safety holds

#### Scenario: Future episodes remain after imports
- **WHEN** all currently aired episodes are imported but known future episodes remain
- **THEN** the season waits for airtime without an availability review or a paid search of future episodes

### Requirement: Released missing content retries ordinarily
The system SHALL schedule finite existing-cadence retries for successfully searched released content with no admitted release, without creating availability reviews. Independent identity, configuration, rate-limit and download holds SHALL remain effective.

#### Scenario: Released movie has zero search results
- **WHEN** a search for an available missing movie succeeds with zero results
- **THEN** a persisted finite retry deadline replaces manual review and survives restart

#### Scenario: Legacy availability review coexists with a queue hold
- **WHEN** old no-release state is considered for automatic conversion alongside an unresolved safety cause
- **THEN** conversion does not clear or bypass that safety cause

### Requirement: Reviews retain their causal evidence
New queue reviews SHALL retain versioned cause, content identity, affected scope and observation time privately, with only allowlisted explanations exposed publicly. Duplicate observations of the same unresolved incident SHALL NOT create additional incidents; resolved history SHALL NOT suppress a new incident.

#### Scenario: Queue disappearance is observed repeatedly
- **WHEN** the same captured queue coverage remains missing across polls
- **THEN** one unresolved incident records the affected scope and its disappearance cause

### Requirement: Positive imports retire scoped obsolete reviews
The system SHALL resolve a captured-target queue review only after fresh known identity-matched library evidence proves all its captured targets imported. Unknown, partial, stale, missing-target or changed-identity observations SHALL NOT resolve it. Legacy unknown-cause reviews SHALL NOT be assigned invented historical targets.

#### Scenario: Imported target leaves future siblings
- **WHEN** every target captured by a queue review has a file and future siblings remain missing
- **THEN** that review resolves as history without holding those siblings or declaring the season finished

### Requirement: Reset preserves download safety
Reset SHALL clear current scheduling and unlinked reviews, record audit history and wait for a later known library observation to rebuild tracking. It SHALL preserve linked reviews, reservations, observed or vanished queue coverage, receipts, successful-grab dedupe and association history. Reset SHALL NOT search, cancel downloads, bypass provider throttling or interrupt a live claim.

#### Scenario: Reset a legacy review without a download reservation
- **WHEN** the operator confirms reset of an idle item with an old unlinked review
- **THEN** the review becomes resolved history and the next successful poll rebuilds the item using current source eligibility

#### Scenario: Reset an item with uncertain download coverage
- **WHEN** an item retains a reservation or vanished coverage
- **THEN** reset does not remove that protection or authorize resubmission even if an unlinked review is cleared

### Requirement: Resolving reviews cannot discard queue protections
The system SHALL preserve unresolved vanished coverage independently of review visibility. Queue read failures SHALL remain unknown rather than empty, and direct contradictory identifiers SHALL NOT become trusted associations.

#### Scenario: Review cleared while coverage is still unaccounted for
- **WHEN** a review is resolved or tracking reset without positive import evidence or guarded hold release
- **THEN** previously held missing-target coverage remains a download safety hold on reconciliation
