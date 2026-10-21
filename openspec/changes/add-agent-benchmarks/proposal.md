# Agent benchmarks

## Why

[Issue #6](https://github.com/aberiggs/media-scout/issues/6) needs evidence of which models make good acquisition decisions at acceptable cost, not just which pass scripted tests. A reviewed real-release dataset also gives [#15](https://github.com/aberiggs/media-scout/issues/15) a repeatable development baseline for seasonal/absolute query improvements without tuning against the final evaluation set.

## What Changes

- Discover and compare bounded query families using public metadata and explicitly approved Prowlarr search captures; freeze sanitized releases, requests, provenance, labels, and observation time.
- Evaluate single/group planning, single/group picking, queue association, and frozen decision replay separately. Keep deterministic lifecycle/coverage regressions separate from model quality.
- Add attempt-level model telemetry and budget/cancellation controls, including unsuccessful calls and retries; distinguish unknown cost from zero cost.
- Add a Benchmarks page to launch ad-hoc comparisons on approved datasets, choose model/endpoint and versioned prompt variants, inspect progress, cancel, compare results, and inspect failures. Experiments never change production settings.
- Separate frozen-data model runs from live retrieval experiments. Unsupported frozen queries remain unknown, never simulated empty results.

## Capabilities

### New Capabilities

- `agent-benchmarks`: reviewed dataset capture, isolated model evaluation, safety/quality/accounting metrics, and operator-launched comparisons.

### Modified Capabilities

None. Production acquisition behavior and prompts remain unchanged in this proposal.

## Impact

New benchmark modules and isolated artifact storage; narrow changes to `src/clients/llm.ts` for telemetry/control, prompt builders in planner/picker/association, `src/daemon.ts` for benchmark routes, and `web/` for the launch/results view. Reuse production decision classes and validators without composing the production runner or opening its State store. Existing tests remain deterministic/offline.

Confirmed from source: inline prompts, three queries per planner stage, staged primary/fallback acquisition, structured-output validation, candidate cap, and DI seams already exist. `LLMClient.json` currently returns only parsed output, Prowlarr's adapter exposes both search and grab, and full-stack composition opens app state. No benchmark facility was found.

Not established: effective live query forms, release availability, model accuracy/cost, or the reported Blue Box numbering diagnosis. These require later approved captures/runs. No live indexer/model call, credential inspection, or production data read is authorized by this planning request.

Non-goals: automatic prompt deployment, grabs/downloads/import verification, production library exports, metadata correction, unrestricted scraping, general prompt editing in settings, and statistically broad model rankings from the pilot. Implementation requires approval; each live run additionally requires selected sources, data-disclosure permission, and explicit budgets.
