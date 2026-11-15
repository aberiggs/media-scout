## Purpose

Operate as an automated client of release search using fresh Sonarr/Radarr library and queue observations, without maintaining an independent authority over media completion or indefinite download uncertainty.

## ADDED Requirements

### Requirement: Arr owns media eligibility
Automation SHALL derive monitored/missing/imported/available state from current Arr observations. TV searches SHALL require monitored series/episode, no file and reached airtime; movies SHALL require monitoring, no file and Radarr availability. New local history SHALL not override a later known observation.

#### Scenario: Imported episode is deleted
- **WHEN** Sonarr later reports the same monitored aired episode without a file
 - **THEN** it is eligible again subject only to current queue, finite retry/grace, ownership and source backoff rules

#### Scenario: Future or unknown timing
- **WHEN** a missing episode has future or unknown airtime
- **THEN** it is not searched; valid date-only timing becomes eligible at the following UTC midnight

#### Scenario: Movie becomes available
- **WHEN** Radarr changes a monitored missing movie from unavailable to available
- **THEN** it becomes eligible without a local review-resolution requirement

### Requirement: Unknown observations are not empty
Automation SHALL require complete current applicable library and queue observations to establish eligibility or absence. Failures SHALL defer only affected providers or scopes, expose unknown status and never fabricate completion or an empty queue.

#### Scenario: Queue pagination fails
- **WHEN** one queue page fails or completeness cannot be established
- **THEN** affected automation sends no search/submission based on presumed queue absence and a later healthy poll can recover automatically

### Requirement: Current Arr associations scope suppression
Current nonterminal matched queue records SHALL suppress associated targets using Arr IDs, not fuzzy Scout title matching. Exact episode rows SHALL not suppress unrelated episodes. Coarser season/series associations SHALL suppress only that scope for the current poll; unidentified rows SHALL not create a durable hold.

#### Scenario: Episode three is downloading
- **WHEN** Arr matches a queue job to episode three and episode four is eligible and missing
- **THEN** episode three waits while episode four can be searched

#### Scenario: Import blocked or unmatched job
- **WHEN** a matched row is paused or import-pending and a separate row has no media association
- **THEN** matched targets wait, the unidentified row is diagnostic only, and neither creates a persistent Scout review

### Requirement: Automation is a search client
Automation SHALL send saved preferences and allowlisted relevant Arr context to the neutral search contract. Initial automated TV requests SHALL target individual episodes with fair attempt ordering; cross-request batching SHALL not be required. Only a valid matched rank-1 option SHALL be automatically selected.

#### Scenario: Large newly missing backlog
- **WHEN** many eligible episodes appear together
- **THEN** bounded passes select oldest-unattempted targets without inventing an implicit season batch or starving siblings

#### Scenario: No suitable match
- **WHEN** search returns no-match, needs-input or an incomplete/error outcome
- **THEN** automation does not select a release and records an explainable finite retry outcome

### Requirement: Fresh checks precede side effects
Before each grab, automation SHALL re-read applicable Arr state and verify target eligibility, queue absence, source identity/configuration, current ownership and enabled side effects. Invalidated rank 1 SHALL not silently promote rank 2. Submission success SHALL not establish downloading or import.

#### Scenario: Episode imported during search
- **WHEN** a fresh pre-submit read shows the target now has a file
- **THEN** no grab occurs and the result records the changed-state reason

#### Scenario: Automation paused during search
- **WHEN** the operator disables automation before a pending grab
- **THEN** that grab is prevented even if search returned a suitable recommendation

### Requirement: Finite appearance grace replaces permanent uncertainty
Submitted or uncertain attempts SHALL reserve captured targets for a persisted finite appearance grace, default 30 minutes. After expiry, a fresh missing observation without matched queue coverage SHALL permit a new attempt without human release. Polls and restarts SHALL not extend that deadline.

#### Scenario: Bad untracked release is deleted
- **WHEN** appearance grace expires and Arr still reports the target missing with no matching queue job
- **THEN** automation can search again without resetting tracking or resolving a review, accepting the documented unmatched-duplicate risk

#### Scenario: Matched download later disappears
- **WHEN** an earlier observed queue match disappears and the target still lacks a file
- **THEN** no vanished-coverage ledger blocks it indefinitely or holds unrelated episodes

### Requirement: Explainable retry and release exclusion
Automation SHALL retain finite per-target retry deadlines, default six hours after no-match/needs-input and 5-to-60-minute exponential operational backoff. Provider Retry-After SHALL take precedence. Unconfirmed/failed physical releases SHALL receive a target-scoped 24-hour exclusion where identity is known, not permanent successful-release dedupe.

#### Scenario: Repeated failures
- **WHEN** a target encounters repeated model/indexer failures
- **THEN** it retries with visible backoff rather than escalating to permanent manual review

#### Scenario: Search now during throttle
- **WHEN** a user requests an immediate search while a provider Retry-After is active
- **THEN** source throttling remains effective even though an ordinary no-match cooldown can be cleared

#### Scenario: Unmatched release is offered again
- **WHEN** a known release failed to appear after grace and search finds another plausible release
- **THEN** the first is excluded for that target for the finite exclusion period and the alternative can be recommended

#### Scenario: Matched dry-run repeats across restart
- **WHEN** automation recommends a suitable release in dry-run and polls again before six hours, including after restart
- **THEN** the target retains its ordinary cooldown without a new paid search, submission grace or failed-release exclusion

### Requirement: Explicit automation controls
Automation SHALL default disabled and dry-run enabled on fresh setup. Polling SHALL be an explicit action or enabled schedule, not a view refresh. No automatic action SHALL cancel downloads, alter Arr metadata or remove queue rows.

#### Scenario: Refresh automation view
- **WHEN** the user refreshes the Automation page
- **THEN** only saved observations are read and no model, indexer or grab call starts
