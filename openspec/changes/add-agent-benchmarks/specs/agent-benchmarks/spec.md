# Agent benchmarks

## Purpose

Let operators compare media-agent models and prompt variants reproducibly using reviewed real release evidence, bounded costs, and explicit safety boundaries.

## ADDED Requirements

### Requirement: Immutable reviewed datasets
The system SHALL version datasets with input context, exact retrieval requests, observation time, source provenance, completeness, reviewed labels, and development/held-out partitions. Unknown identity or numbering mappings MUST remain unknown.

#### Scenario: Anime metadata differs between catalogs
- **WHEN** an anime catalog entry does not establish a TVDB season or absolute episode mapping
- **THEN** the dataset retains that uncertainty and does not manufacture equivalent season or episode identifiers

#### Scenario: Dataset labels change
- **WHEN** a reviewer changes acceptable-candidate or coverage labels
- **THEN** a new dataset/label revision is created and previous runs retain their original revision

### Requirement: Explicit bounded capture
Live retrieval SHALL require explicit source selection and request, time, and result limits. Capture MUST stop on quota/backoff signals and record failure or truncation separately from successful empty results.

#### Scenario: Indexer becomes unavailable
- **WHEN** capture encounters a rate limit or source failure
- **THEN** affected retrieval is recorded as unavailable, not as proof that the target has no releases

### Requirement: Sanitized evidence
The system SHALL remove credentials, private URLs, magnets, raw GUIDs/hashes, and personal library exports before dataset persistence or provider submission. It MUST preserve opaque duplicate relationships and downloadability booleans. Hosted submission of private-derived evidence requires explicit disclosure approval.

#### Scenario: Private release capture
- **WHEN** a captured release contains authenticated links and duplicate hashes
- **THEN** stored/model-facing evidence contains no original links or hashes but retains pseudonymous physical-release equivalence

### Requirement: Separate stage quality
Runs SHALL score single/group planning, single/group picking, association, and supported decision replay separately. Scores MUST allow multiple acceptable selections and report reviewed denominators, uncertainty, abstention, identity, coverage, and query attribution rather than requiring exact output strings.

#### Scenario: Two suitable releases
- **WHEN** either candidate meets reviewed identity, coverage, and preference criteria
- **THEN** either valid selection receives credit without requiring one exact winner

### Requirement: Honest retrieval evaluation
Frozen retrieval SHALL resolve only captured equivalent requests. Unsupported requests MUST remain unknown. Reports MUST disclose replay support and distinguish pool-relative recall from indexer-wide recall; partial support MUST NOT produce an unqualified model ranking.

#### Scenario: New planner query
- **WHEN** a model emits a query absent from the frozen request inventory
- **THEN** retrieval is marked unsupported, not approximated by substring search or scored as an empty result

### Requirement: Explicit safety failures
Reports SHALL expose unsafe model proposals and accepted unsafe outputs separately from average quality. Wrong identity, fabricated references, unsupported coverage, held-target selection, duplicate/overlapping selection, mutation attempts, and prohibited disclosure MUST be hard-failure categories.

#### Scenario: Validator blocks an unsafe selection
- **WHEN** a model proposes overlapping releases and the validator rejects them
- **THEN** the run records an unsafe proposal blocked by validation, not a safe successful answer or an ordinary provider failure

### Requirement: Bounded accountable model execution
Model runs SHALL require explicit endpoint/model, prompt/dataset revisions, repeat count, concurrency, deadlines, attempt/token limits, and a spend policy. Every retry/correction MUST count. Missing usage/cost MUST be unknown, never zero; incompatible output capabilities MUST be reported without silent validation downgrade.

#### Scenario: Correction call consumes tokens
- **WHEN** malformed output causes a second model request
- **THEN** both attempts appear in usage, latency, cost, and budget accounting with first-attempt validity separate from final validity

#### Scenario: Hard spend limit cannot be enforced
- **WHEN** a hosted endpoint supplies neither enforceable spending controls nor a conservative per-request cost bound
- **THEN** a hard-dollar-budget run is rejected rather than presenting observed-cost stopping as a guaranteed cap

### Requirement: Structurally isolated execution
Benchmark execution SHALL have no grab path, production application state writer, monitoring loop, or library/download-client mutation capability. Offline evaluation MUST remain network-free, and live model execution and live retrieval MUST be independently authorized.

#### Scenario: Attempted submission during benchmark
- **WHEN** a benchmark attempts a Prowlarr submission or Arr mutation
- **THEN** the transport rejects the request and records a safety failure regardless of production dry-run settings

### Requirement: Ad-hoc app comparisons
Operators SHALL launch bounded runs on approved datasets from a Benchmarks page, inspect status/results and per-case failures, compare compatible model/prompt runs, and cancel further work without changing production settings. Duplicate launch requests MUST NOT duplicate paid work. Restarted runs MUST become interrupted without automatic paid resumption.

#### Scenario: Cancellation and reload
- **WHEN** an operator cancels a run and reloads the app
- **THEN** retained results and cancellation status remain visible, in-flight requests are aborted where supported, and no further attempts begin

#### Scenario: Model selection for an experiment
- **WHEN** an operator chooses an experimental model and prompt version
- **THEN** the run snapshots those choices while production AI settings and prompts remain unchanged
