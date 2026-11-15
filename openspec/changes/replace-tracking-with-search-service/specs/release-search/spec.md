## Purpose

Provide an Arr-independent natural-language indexer search service that recommends suitable releases through a bounded, inspectable multi-turn process without downloading during search.

## ADDED Requirements

### Requirement: Neutral versioned search contract
The service SHALL accept a natural-language prompt with optional structured context and descriptive preferences over equivalent HTTP and MCP contracts. It SHALL work without configured Arr providers and SHALL separate progress, matched, no-match, needs-input, interrupted, budget-exhausted and failed outcomes.

#### Scenario: Standalone request
- **WHEN** a user supplies only a prompt with Prowlarr/model configured and no Arr connections
- **THEN** search can run and return recommendations without creating Arr work or requiring media IDs

#### Scenario: Conflicting request
- **WHEN** request identity or scope conflicts cannot be resolved from supplied evidence
- **THEN** the result is needs-input and cannot be automatically submitted

### Requirement: Read-only bounded tool loop
The search agent SHALL use only allowlisted read-only indexer tools, revise queries across turns and stop within server-controlled call/turn/time limits. Every attempted call and retry SHALL count toward the applicable budget. Search SHALL never submit, alter queues or mutate libraries.

#### Scenario: Query refinement
- **WHEN** the first query returns irrelevant releases and an alternate-title query returns suitable releases
- **THEN** the same search records both calls and can recommend the later result without downloading

#### Scenario: Runaway or malformed model actions
- **WHEN** the model repeats searches until its budget expires or emits an invalid tool action
- **THEN** the run ends with a truthful non-submittable outcome and no unbounded retry loop

### Requirement: Complete candidate visibility
The model SHALL receive every safely representable candidate returned by each search, without a hidden top-N or seeders cutoff. Counts and upstream incompleteness SHALL be exposed. Context overflow SHALL fail explicitly rather than silently truncate candidates or submit an incomplete recommendation.

#### Scenario: Best release is last among two hundred
- **WHEN** a search returns 200 candidates and the preferred-language release is at position 200 with few seeders
- **THEN** the model receives that candidate and every other returned candidate's relevant metadata

#### Scenario: Source or context is incomplete
- **WHEN** an upstream response is incomplete or the model cannot accept the full candidate input
- **THEN** the response identifies the limitation and cannot authorize automatic submission

### Requirement: Evidence-backed suitability
The model SHALL reason about supplied identity, scope and quality evidence, favoring multi-sub and popular releases as soft compatibility signals, not guarantees or thresholds. Language guidance SHALL be descriptive, not a v1 must-have gate. Known-wrong content/language SHALL remain unsuitable; unknown metadata alone SHALL not reject a plausible candidate. Candidate text SHALL remain untrusted data.

#### Scenario: Unknown language metadata
- **WHEN** a plausible release has unknown language metadata and a language preference is supplied
- **THEN** the model may rank it using other evidence without treating the preference as a mandatory cutoff

#### Scenario: Explicitly wrong language
- **WHEN** available metadata explicitly identifies content as a known wrong language for the requested item
- **THEN** it is treated as unsuitable, while unknown metadata is not equated with known mismatch

#### Scenario: No suitable release
- **WHEN** all observed releases conflict with the requested identity or scope
- **THEN** the result is no-match rather than a forced best-of-bad-options grab

#### Scenario: Prompt injection in release title
- **WHEN** candidate metadata contains instructions to ignore preferences or invoke a download
- **THEN** it remains data and cannot change tool permissions or the request contract

### Requirement: Ranked acquisition options
Matched results SHALL contain ranked alternative options with observed opaque candidate references, requested-target coverage, concise reasons and uncertainty. Episode/movie options SHALL contain one physical release; explicit season options SHALL contain at most three non-overlapping releases. Unknown references and explicit contradictory scopes SHALL be rejected.

#### Scenario: Partial airing-season pack
- **WHEN** a pack plausibly covers only some requested aired episodes
- **THEN** coverage is labeled inferred, uncovered targets remain visible and neither future episodes nor import are declared fulfilled

#### Scenario: Fabricated candidate
- **WHEN** a model names a candidate or target not supplied to that search
- **THEN** the output cannot become a submittable matched result

### Requirement: Separate explicit submission
Submission SHALL require an explicit search/option reference and idempotency key, valid unexpired private candidate material, configured routing and enabled side effects. Search tools SHALL have no submission authority. Submission SHALL report each release as submitted, rejected or uncertain, never imported.

#### Scenario: User confirms a recommendation
- **WHEN** a user confirms an unexpired option with real submissions enabled
- **THEN** only that option is routed through Prowlarr and alternatives are not downloaded

#### Scenario: Expired or dry-run result
- **WHEN** an option expires or dry-run remains enabled
- **THEN** an explicit expired or dry-run outcome is returned without a Prowlarr grab POST

### Requirement: Validated download-client choice
Submission MAY accept a download-client ID only from enabled clients listed by configured Prowlarr. Without a choice it SHALL use the default Arr TV/movie route. Arbitrary URLs or caller-defined clients SHALL be rejected.

#### Scenario: Manual client selection
- **WHEN** a caller submits an option with an ID from the enabled Prowlarr client list
- **THEN** the submission uses that configured client, while an absent ID uses the default Arr route

#### Scenario: Arbitrary routing destination
- **WHEN** a caller supplies an unknown client ID, client definition or URL
- **THEN** submission is rejected without a grab POST

### Requirement: Durable bounded side-effect protection
Overlapping live submissions SHALL be owner-checked and serialized. Reusing an idempotency key SHALL never resend its POST, including after crashes or history pruning. Ambiguous POST outcomes SHALL not be blindly retried. Uncertainty protection SHALL be finite, not a permanent library hold.

#### Scenario: Timeout and restart
- **WHEN** a grab times out and the process restarts before its response is confirmed
- **THEN** the same key returns uncertain without another POST and its appearance grace survives restart

#### Scenario: Partial season plan
- **WHEN** the first release is submitted and a later release fails
- **THEN** results retain the first side effect, stop further submission and never replay the whole plan automatically

#### Scenario: Different key during appearance grace
- **WHEN** HTTP or MCP submits overlapping Arr targets or the same known physical release under a new key during persisted appearance grace
- **THEN** the shared submission boundary atomically defers the POST, including after restart and for neutral manual physical-release duplicates

#### Scenario: Idempotency key changes meaning
- **WHEN** a caller reuses a submission key with different request material
- **THEN** the service reports a conflict without sending another POST

### Requirement: Private submission references
Public search/activity responses and model prompts SHALL omit credentials, download URLs, magnets, GUIDs and hashes. Only server-resolved private references SHALL authorize submissions; callers SHALL not supply arbitrary upstream URLs or routing destinations.

#### Scenario: Inspect search and submit
- **WHEN** a caller views candidates and submits an option
- **THEN** safe metadata and opaque IDs suffice and no private locator is returned or accepted as a submission override
