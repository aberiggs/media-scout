# Spec Delta

## Purpose

Track TV episode availability and acquisition progress independently so weekly releases and season backfills reconcile safely across polls and process restarts.

## ADDED Requirements

### Requirement: Episode eligibility respects precise airtime
The system SHALL search only known, monitored, missing episodes whose eligibility time has arrived. Valid precise UTC airtime SHALL take precedence over a calendar date. Date-only observations SHALL use an explicit conservative fallback; absent or invalid timing SHALL not authorize a search.

#### Scenario: Same date but airtime is still future
- **WHEN** an episode has an air date of October 15 and a UTC airtime of October 15 at 23:00, and observation time is 00:01 UTC that day
- **THEN** the episode remains awaiting airtime without a search or availability review

#### Scenario: Precise airtime arrives
- **WHEN** a subsequent known observation reaches the episode's UTC airtime and the episode remains monitored and missing
- **THEN** it becomes independently eligible unless a specific scheduling deadline or safety hold applies

#### Scenario: Timing is unavailable
- **WHEN** neither a valid UTC airtime nor a valid calendar date is known
- **THEN** the episode is displayed as timing unknown and is not searched

#### Scenario: Only a calendar date is supplied
- **WHEN** UTC airtime is absent and a valid calendar date is supplied
- **THEN** automatic eligibility begins no earlier than the start of the following UTC day and the fallback basis is retained

### Requirement: Episode progress survives aggregation and restarts
The system SHALL persist episode-specific observations, retry timing, attempt outcomes, and held coverage independently of the season aggregate. Import completion SHALL require positive file evidence. Unknown reads, empty inventories, library removal, and unmonitoring SHALL not constitute import evidence.

#### Scenario: Weekly progression survives restart
- **WHEN** S1 is imported, S2E1 is aired and missing, and S2E2 is future, followed by E1 downloading and importing, a process restart, and E2 reaching airtime
- **THEN** only E2 becomes searchable, E1 remains imported, S1 is not searched, and no future-episode review is created

#### Scenario: Unknown or partial read
- **WHEN** a library or queue read needed to establish eligibility or safe coverage is unknown or incomplete
- **THEN** prior positive observations and reservations are retained, no false completion is recorded, and unsafe automatic acquisition is held

### Requirement: Availability misses schedule target-specific retries
A successful TV search with no admitted release SHALL record retryable unavailability for the attempted episode targets rather than create a blocking manual review. A newly eligible sibling SHALL not inherit another episode's availability cooldown. Operational failures, configuration errors, and explicit identity uncertainty SHALL retain their distinct policies.

#### Scenario: Release appears after an ordinary empty search
- **WHEN** an aired episode's search yields no admitted release and a later poll reaches its retry deadline
- **THEN** it can be searched again automatically without operator action

#### Scenario: A sibling becomes eligible during cooldown
- **WHEN** E1 is waiting for an availability retry and E2 reaches airtime
- **THEN** E2 can be searched on the next known safe poll without making E1 prematurely due

### Requirement: Download safety holds retain their evidence scope
Known episode coverage SHALL exclude only the covered targets from acquisition. Vanished, conflicting, or unscoped download evidence SHALL retain conservative holds over its possible coverage. Ordinary availability misses SHALL not widen a hold, and no retry SHALL silently release an intent or successful-release marker.

#### Scenario: Healthy E1 download and due E2
- **WHEN** a healthy download has exact coverage of E1 and E2 is independently due
- **THEN** E2 remains searchable and E1 remains reserved

#### Scenario: Vanished or ambiguous download
- **WHEN** a tracked download disappears or its possible coverage cannot be safely bounded
- **THEN** reservations and review history are preserved and affected targets remain held with an explicit safety reason

### Requirement: Monitoring and identity transitions are conservative
New monitored episodes and new seasons SHALL become independently discoverable. Unmonitoring SHALL remove acquisition eligibility without fabricating imports. Changed content identity or episode metadata SHALL invalidate stale acquisition assumptions without transferring completion or coverage to a different identity.

#### Scenario: Monitoring enables a previously ignored target
- **WHEN** a missing aired episode becomes monitored under a known matching identity
- **THEN** it becomes eligible without inheriting an unrelated sibling's availability delay

#### Scenario: Identity or numbering changes during processing
- **WHEN** fresh identity or episode metadata no longer matches a captured search target
- **THEN** acquisition is revalidated and stale selection cannot authorize a grab for a different target

### Requirement: Existing state remains safe through upgrade
Existing season identifiers, reviews, intents, queue associations, decisions, deduplication markers, and audit history SHALL remain usable after upgrade. Legacy empty-search holds SHALL be converted only with fresh matching evidence and no conflicting safety hold. Missing historical target evidence SHALL not be invented.

#### Scenario: Recover an ordinary legacy availability hold
- **WHEN** an unlinked TV empty-search review is reconciled under fresh matching library and queue evidence with no conflicting safety or configuration hold
- **THEN** it is retained as resolved history and observed eligible targets enter bounded retry scheduling without releasing reservations or marking them imported

#### Scenario: Legacy uncertainty cannot be safely converted
- **WHEN** a legacy review is linked to an intent, has conflicting identity, or lacks sufficient fresh evidence
- **THEN** the review and safety hold are preserved rather than guessed away
