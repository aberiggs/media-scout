# Design

## Context

See proposal.md for motivation and issue links. Source inspection found:

- `src/core/planner.ts`: single/group methods, inline prompts, three queries per stage; grouped target/episode attribution validation.
- `src/core/picker.ts`: single/group methods, URL-presence-only prompt serialization, semantic validation of coverage and physical-release sets.
- `src/core/queue-association.ts`: separately testable association with private lookup, uncertainty and prompt-versioned cache context.
- `src/core/runner.ts`: staged acquisition and candidate admission/order/cap. Current operations allow three primary plus three fallback queries; one/two due episodes are episode-first and a substantial backlog is pack-first. Do not benchmark a stale three-total-query approximation.
- `src/clients/llm.ts`: parsed-output-only interface; concrete OpenRouter client owns JSON correction, transport retries, and deadlines but discards completion usage.
- `src/clients/prowlarr.ts`: search and grab share one adapter. `src/compose.ts` constructs the full graph and opens State; unsuitable as benchmark composition.
- `src/daemon.ts`: injected app stack, same-origin mutation guard, trusted-local deployment assumption. `web/src/App.tsx`: hash navigation suitable for a separate Benchmarks page.

No dedicated architect agent was available. A read-only architecture-review specialist brainstormed these boundaries and recommended separate retrieval/picker evaluation, exact replay support reporting, physical-release-safe sanitization, and attempt-level accounting. No live execution established retrieval or model quality.

## Goals / Non-Goals

**Goals:** reuse real decision code and serializers; produce reproducible, auditable comparisons; support affordable hosted and compatible local endpoints without conflating their costs; enable bounded ad-hoc runs in the app.

**Non-goals:** full scheduler/import simulation, new acquisition policy, automatically deploying the best prompt/model, a universal indexer simulator, unrestricted capture, or a general-purpose prompt IDE. #15 supplies later prompt variants, not silent changes bundled into #6.

## Decisions

### 1. Separate capabilities, not a production dry-run

Introduce `src/benchmarks/` contracts, capture, evaluation, composition, storage, and run service. Construct Planner/Picker/QueueAssociator directly with explicit dependencies. Do not construct Runner, Watcher, OperatorActions, or production State for benchmark execution. The web daemon can read configured connection details through a narrow server-side resolver; workers receive only approved model or read-only retrieval capability, never the stack.

Use a benchmark-only artifact directory outside production database storage: immutable dataset manifests and sanitized evidence, plus run manifests and bounded append-only attempt records. Atomic updates retain terminal status; on startup, unfinished runs become interrupted. Do not store provider credentials in artifacts. Limit retained runs/bytes and expose retention policy; fail before disk exhaustion rather than silently deleting active results.

Enforce a retrieval transport allowlist for approved GET search/indexer/status paths, configured origin, and redirect policy. No POST search, download-link fetch, Arr endpoints, or arbitrary URLs. Type narrowing alone is insufficient. Frozen runs allow only selected model endpoints; offline scoring has no network transport. Search can populate Prowlarr's own cache and spend quota: promise no application/library/download mutations, not zero upstream side effects.

Alternative rejected: buildStack with dryRun. It opens production state and can persist scheduling/review changes.

### 2. Real evidence with reviewed, limited claims

Pilot: **12 works, four anime, four US TV and four movies**, following the user's revised allocation. Use one target scope each, with TV inputs covering episode-first and backlog scenarios. Select anime across seasonal/sequel and long-running absolute-number strata; movies add title/year ambiguity. Include a small synthetic edge suite for not-found, unavailable sources, ambiguous association, partial coverage, held targets and prompt injection so pilot popularity does not erase safety cases.

Candidate seed titles (not assertions of current popularity or availability): Blue Box/Ao no Hako, Frieren/Sousou no Frieren, The Apothecary Diaries/Kusuriya no Hitorigoto, One Piece; The Bear, Abbott Elementary, Severance, The Last of Us; Dune: Part Two, Everything Everywhere All at Once, The Batman, Oppenheimer. Verify scope/aliases/numbering before issuing any query. Blue Box S2E1/absolute 26 is an issue case to verify from public metadata rather than assume.

Use public metadata for discovery, not personal account/library exports. MyAnimeList seasonal listings nominate works; TMDB supplies aliases/identifiers. TMDB documents [TV alternative titles](https://developer.themoviedb.org/reference/tv-series-alternative-titles) and [external-ID lookup](https://developer.themoviedb.org/reference/find-by-id). TVDB identity is required by current TV WorkUnit semantics; TMDB/MAL IDs are separate namespaces. Review crosswalks, seasons, cours and episode mapping; metadata does not prove release contents. Prefer supported APIs over HTML scraping, respect terms/rate limits/attribution, and avoid persisting unnecessary metadata/artwork. Public seasonal search snippets were inspected, but are not verified episode metadata.

Dataset manifest: schema/version, work/franchise partition, fixed observation time, metadata source/time/IDs/mapping confidence, target input DTOs, prompt-visible evidence, query-family manifest, exact request/response mapping, availability/truncation status, opaque release IDs/physical equivalence, ordered candidate sets, labels/reviewer/revision, and disclosure classification. Sanitize before persistence: strip URLs/hashes/GUIDs/credentials, pseudonymize private indexer names, retain boolean downloadability. In-memory adapters can use non-routable synthetic identifiers to satisfy decision types; never reconstruct actionable download links.

Labels: compatible/wrong/unresolved identity; supported coverage and explicit versus inferred basis; acceptable/unacceptable/uncertain selection under declared preferences; optional preference tiers. Multiple releases can be acceptable. Season-pack inference is not verified content. Labeling is human-reviewed, blind to model identity; model assistance cannot be the sole oracle. Real release titles plus synthetic queue/library context are labeled mixed-provenance, not real queue observations.

Alternative rejected: one expected winning release or exact query string. Both punish equally correct answers and encourage overfitting.

### 3. Query discovery is an experiment

Compare these six query slots per scope, substituting only verified input values:

| Family | Example template | Purpose |
|---|---|---|
| Seasonal | `{title} S02` | Season/pack discovery |
| Alternate seasonal | `{alias} Season 2` | Alias and word-form coverage |
| Episode | `{title} S02E01` | Precise seasonal episode |
| Alternate episode | `{alias} S02E01` | Romanized/localized title coverage |
| Absolute | `{title} 26` or `{alias} - 26` | Anime with verified absolute mapping only |
| Broad/batch | `{title}`, or `{title} 01-12` with supported scope | Recall ceiling/batch coverage |

For non-anime/missing absolute data substitute a second supported seasonal/broad variant; never invent numbering or demand every work use all slots. Initial TV/anime category hypotheses follow existing `[5070,5000]` hints, with capabilities/categories frozen per capture; movie edge cases use 2000. Hold category/indexer choices fixed when comparing query text. No quality/group/codec terms in the baseline. Examples illustrate forms, not proven effectiveness.

Proposed capture ceilings: **72 Prowlarr search requests**, two selected enabled/healthy indexers, serial paced execution, **30-minute** deadline, requested **200 results/request**, **10,000 stored rows** total; skip duplicates, no automatic search retries, stop on backoff/quota. Multi-indexer requests can cause up to 144 upstream searches before provider-specific behavior; report fan-out rather than calling this 72 indexer operations. Confirm actual API limit/completeness semantics during capture; reaching a cap marks incomplete, not exhaustive. These discovery limits do not expand production query budgets.

Rank families by target hit rate, acceptable target coverage per query, unique acceptable physical releases, precision/noise, marginal gain and observed query latency. Review all retained evidence or disclose unlabeled denominators. Choose complementary queries under the production stage budget rather than choosing the single highest-volume query.

### 4. Three distinct planner measurements

1. **Offline structural quality:** schema, grounded titles/numbers, supplied target attribution, stage/query-budget compliance. Does not claim retrieval recall.
2. **Exact captured replay:** query/categories/indexers/limits map to a recorded request. Only conservative equivalence is allowed; meaningful punctuation is not normalized away. Unseen queries are unsupported. Report query and fully supported case rates; never rank unequal supported subsets as a general leaderboard. Recall is relative to the reviewed captured pool, not the whole indexer.
3. **Paired live retrieval experiment:** freeze participating models/prompts/queries before showing retrieval; deduplicate and interleave their query union in a short approved capture window, then label blindly. Evaluate each model using only its own responses at equal production query budgets. A new query requires a new capture version/approval, not an invented response.

The initial paired experiment evaluates predefined planner-stage inputs independently. Production fallback depends on primary selection and remaining uncovered targets; do not describe independent-stage capture as adaptive production-equivalent acquisition. Adaptive comparisons would require separately budgeted rounds: capture primary responses, run selection, snapshot each model's uncovered context, then capture its fallback query union. That extension is outside the initial paired experiment.

Split by work/franchise (proposed eight development/four held-out works), never candidate rows. Prompt discovery uses development data. Exposed holdouts become development data; create new held-outs for later tuning. Twelve works validate machinery and provide examples, not robust model superiority claims.

### 5. Reuse decision paths; version prompts without changing defaults

Minimally extract/version current prompt builders and permit benchmark-only registered variants; compatibility tests assert identical default rendered requests. Pin code revision, serializer/schema hashes, full rendered prompt hashes, dataset/labels, model/provider returned identity, endpoint profile, preferences, clock, generation settings, retries, and seed support. Unsupported seeds remain unsupported, not reproducibility guarantees.

Freeze production-equivalent admission, seeders sort, deduplication and candidate cap before picker comparisons. Show losses separately: retrieval -> guardrail admission -> cap -> picker. Score raw model proposal, validation result, and accepted action separately. Report justified and avoidable abstention; conservative association uncertainty differs from a false match. Run candidate-order perturbations separately from the primary fixed-order comparison.

Initial replay covers decisions through supported frozen retrieval and validations only. It has no stateful scheduling/submission/import claim. Broader lifecycle correctness stays ordinary offline regressions; no rewrite of runner orchestration solely for benchmarking.

### 6. Account for every attempt and bound spending honestly

Keep `LLMClient.json<T> -> T` compatibility. Add optional typed attempt telemetry and abort/budget controls at the concrete transport boundary, before content/schema validation discards metadata. Include logical-call and transport-attempt IDs, correction/retry identity, request/response timestamps, actual model/provider if supplied, token usage, provider-reported cost, finish/refusal status, and safe failure class. Never persist arbitrary raw provider errors or credentials. Preserve app behavior when telemetry is disabled.

Report first-response/final schema validity; semantic validity; stage-specific quality; hard safety counts; retry counts; logical and attempt latency; tokens; known billed cost; separately labeled estimates; missing-accounting counts. Provider failures, unsupported structured output, retrieval failures and unsafe proposals are separate classes. No hosted price assumptions for local compute; manual local cost estimates remain estimates.

One active benchmark job, model concurrency one initially. Default pilot suggestion: two models, one repeat; 12 cases imply 24 logical calls for one selected track, not for all tracks. UI computes maximum transport attempts including correction/5xx retries, output-token ceiling and time before launch. Server-enforced maxima apply independently of browser input. Before **every** attempt reserve call/token/cost allowance; retry waits are abortable. Use a conservative per-request price bound and max-token settings or provider-enforced spending cap for hard-dollar runs. If unavailable, reject hard-dollar mode and offer an explicitly described call/token-bounded run with observed-cost stopping, never a false guaranteed dollar cap. Cancellation aborts supported in-flight work, stops new attempts and retains any incurred charges.

### 7. Minimal useful in-app workflow

Add Benchmarks navigation using the existing dark/mint UI tokens. Launch panel: approved dataset/split, track, model endpoint profiles/models, registered prompt variants, repeats, generation controls, budgets, disclosure approval and estimated maximum work. Explicitly distinguish **frozen data / paid model calls**, **offline recorded-output scoring**, and **live retrieval capture**. Initial capture can be an explicit CLI; app model runs on approved datasets are part of the first release, not indefinite future scope.

Routes under `/api/benchmarks`: list approved datasets/prompts/model profiles, create run (`202`), inspect run/results, cancel. Validate server-selected profile IDs rather than accepting arbitrary browser-supplied destinations or credentials; experimental settings never overwrite app settings. Add idempotent start, one-active-run conflict handling, mutation-origin checks and paginated secret-free results. Poll progress; show comparable per-stage results, safety failures, sample counts, support rate, latency, tokens/cost and per-case evidence. Export only sanitized results. Runs with different revisions/settings are marked non-comparable.

## Risks / Trade-offs

- Small/popular corpus bias -> stratify pilot, explicitly limit conclusions, expand with hard/rare cases later.
- Captured pool is not complete search ground truth -> pool-relative labels, completeness/support metrics and paired capture for unseen queries.
- Prompt tuning contaminates labels/holdouts -> freeze versions and franchise-level splits, retire exposed holdouts.
- Private title/indexer evidence can still be sensitive -> explicit data-disclosure review; sanitized does not mean automatically public. Public repository publication needs separate privacy/rights approval.
- Model routes/pricing/strict-output capability vary -> record actual metadata and capability failures, do not silently downgrade or treat missing usage as free.
- Existing daemon lacks authentication -> preserve trusted-local deployment and origin checks; benchmark endpoints add no public exposure.
- Extraction can drift from production -> request-byte parity tests and unchanged default prompt behavior before live runs.

## Migration Plan

No production database migration is required for benchmark artifacts. Land isolated contracts/telemetry and offline checks first, then bounded capture tooling and reviewed dataset, then run service/app UI. Run an explicitly approved small model baseline only after isolation/privacy gates pass. Rollback disables benchmark routes and worker startup; preserve artifact files, never touch acquisition state. Existing production model/prompt settings are unchanged.

## Open Questions

Deferred to each authorized capture/run: final seasonal works and verified scopes, selected healthy indexers, endpoint/model IDs and price/capability metadata, exact dollar/token budgets and disclosure permissions. These are manifest inputs, not reasons to broaden architecture or auto-run experiments during planning.
