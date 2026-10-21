# Agent benchmarks

Issue [#6](https://github.com/aberiggs/media-scout/issues/6). Production prompt
improvements remain separate in #15. No benchmark deploys a prompt or changes
production settings, monitoring, library state or downloads.

## Evidence and claims

The [versioned fixture](../benchmarks/README.md) contains actual sanitized release
observations: 12 works, 38 exact request mappings, 262 retained physical candidates
from a 2,010-observation capture. It preserves within-case physical equivalence,
upstream response order, distractors, original response counts and uncertainty.
The public subset is deliberately not the entire private capture. Canonical
numeric features are the first retained observation of each physical release;
they are frozen for comparison, not a per-query live health remeasurement. The
full private capture has nine physical IDs whose seeders varied across queries;
no physical ID had contradictory observed titles. No current-health claim follows.

Human review approved the assisted identity/coverage rubric, specific distractors,
inferred-pack acceptance and publication/provider disclosure. Ambiguous claims
stay uncertain. Multiple acceptable releases receive credit; preferences are
neutral, so there is no fabricated preference winner/tier. Inference is not proof
of file contents. The exposed eight/four split is not a blind future holdout.

The separately versioned `synthetic-safety` dataset covers not-found, unavailable,
held, wrong-identity/injection, missing absolute mapping/split naming, partial
coverage, inferred packs and ambiguous association. It is authored safety evidence,
not captured availability or live model quality. Ordinary deterministic episode
eligibility/lifecycle regressions remain ordinary tests, not LLM scores.

## Decision-only isolation

`src/benchmarks/evaluate.ts` constructs real Planner, Picker and QueueAssociator
instances and uses their production serializers, schemas and semantic validators.
It never constructs Runner, State, Watcher, Prowlarr or Arr clients. Synthetic
`benchmark:unreachable` link-presence placeholders cannot fetch a download.
Unknown identity/season mappings stay unscored; they are never replaced with
invented catalog mappings. Absolute numbering remains nullable.

Tracks are single/group planning, single/group picking, association and supported
decision replay. Group planning selects the production primary stage for the
supplied missing inventory (three episodes: pack/batch; one/two: episodes).
Grouped candidate ordering uses coverage diversity then stable seeders ordering;
single picking uses stable seeders ordering. Both use the production 100-item cap
and real deterministic coverage admission. Retrieval/admission/cap losses remain
separate. This evaluates decisions, **not** adaptive scheduling, submission or import.

All library/queue context is synthetic and frozen; association uses a captured
title with synthetic aligned lookup tables. It is mixed provenance, never a
production queue export. The synthetic ambiguity case supplies two possible media
identities. Held targets are refused before a paid call; that deterministic safety
outcome is not evidence of LLM judgment.

`evaluateRecordedCase(case, track, outputs)` constructs a network-free recorded
output client internally. `evaluateBenchmarkCase` accepts an explicit model-only
client for live use. Default tests stay offline.

## Scoring

- `correct`: reviewed acceptable selection or structurally grounded planner result;
  structural planning correctness alone is **not** retrieval quality.
- `unsafe-proposal`: accepted decision proposes wrong identity/unsupported scope,
  or a planner invents supplied identity/numbering references. Guardrail rejection
  is reported separately with `validatorRejected`; blocked unsafe is not success.
- `validator-rejected`: schema/semantic rejection with safe raw indices and a
  malformed-proposal flag. Invalid JSON/schema, refusal, transport and unsupported
  strict-output errors are separately retained in attempt telemetry.
- `justified-abstention` versus `avoidable-abstention`: whether reviewed acceptable
  choices were actually admitted and shown. Admission/cap losses are not hidden.
- `uncertain`: unresolved annotations/identity; excluded from a definitive quality
  denominator, never silently wrong or right.
- Picker outcomes also report reviewed identity correctness and claimed target
  coverage independently; a useful partial selection can be acceptable while
  covering only 1/3 of targets. Inferred/mixed pack coverage is explicitly labeled,
  never verified contents. Optional reviewed preference tiers use `1/(1+tier)`
  (zero is best), averaged across acceptable selections. The real pilot has no
  human-ranked tiers, so preference credit remains unknown rather than invented.
- `provider-failure`, `retrieval-unavailable`, `unsupported-retrieval`: not ordinary
  wrong answers and not proof of empty retrieval.

Frozen replay resolves exact query text, category set, selected indexer set and
limit. Meaningful punctuation is not normalized away. It assembles an ordered,
deduplicated union from recorded candidate IDs. New queries remain unsupported;
there is no substring indexer simulator. Recall, when supported, is relative to
the reviewed **subset pool**, not the whole indexer or unretained observations.
No unqualified model ranking is supported by unequal replay support.

`paired.ts` freezes and fingerprints interleaved participant query manifests before
retrieval. It bounds each participant, source fan-out, requests, rows and deadlines;
fake-transport tests exercise capture without network. Live paired capture needs
separate source/data/budget authorization and a scoped read-only sanitizing adapter,
not the production client with grab capability. No paired live capture was added
to the model-run API or automatically performed for the baseline. Independent
primary/fallback query rounds are not adaptive acquisition equivalence.

## Spending and accounting

Every transport attempt (including 5xx retry and JSON correction) reserves calls,
tokens and cost **before** send. A synchronized pending record is written before
network access. Cancellation aborts supported in-flight work and retry waits;
incurred charges remain. There is one active job per service; use one owner process
per artifact directory. Repeated request IDs cannot create duplicate paid work;
changed configuration with the same key conflicts.

OpenRouter hard-dollar runs require advertised structured-output support and finite
token-only pricing. The runner reserves the entire advertised context plus bounded
output for each attempt and sends provider `max_price` token ceilings and zero
request-fee ceiling. An unavailable conservative bound rejects launch. Tokenizer
heuristics are **not** used for hard-dollar reservations. Reliable observed cost
can release unused reservation; unknown cost cannot. A reported bound contradiction
invalidates further spending. A user-authorized aggregate cap still applies across
separate launches; per-run caps are not an account-wide provider key limit.

Telemetry records logical/transport IDs, correction status, timestamps, request
fingerprints, nullable actual model identity, schema validity, tokens and provider
reported cost before validators can discard evidence. Unexpected returned model
strings are not persisted. SDK-unexposed provider identity stays unknown. No raw
provider body, reason, arbitrary error, credential or request URL is saved. Missing
usage/cost is null, not zero. Summaries show known partial cost and unknown-attempt
counts; first/final schema validity and transport retries are distinct.

## App workflow and server profiles

Open **Benchmarks**. Select reviewed dataset/revision, split, tracks, model/profile,
registered prompt variant, repeats and limits. Inspect provenance/disclosure and
confirm the paid action. Temperature defaults to zero; seed defaults to unsupported/
not requested unless explicitly supplied and supported in the CLI/API snapshot.
`production-v1` uses unchanged production request bytes; the optional neutral
data-only benchmark variant never edits production prompts/settings.

Progress, per-stage counts, unsafe proposals, validator/provider failures, abstention,
replay support, latency/tokens/cost and paginated case outcomes are retained. Candidate
evidence links open sanitized ordered pools/labels. Export contains sanitized JSON
only. Compare completed compatible snapshots; model/prompt may differ, but dataset,
source and evaluation settings must match. Unequal support still prevents ranking.
Cancel stops further work. Reload observes runs; restart marks unfinished work
interrupted and never automatically resumes paid work.

The configured model is the default server-side profile. `BENCHMARK_MODELS` can
register comma-separated experimental hosted models using the same endpoint/key,
without writing production settings. `BENCHMARK_PROFILES_FILE` can name an operator-
owned private JSON array of profiles (`id`, `label`, `model`, `baseUrl`, `apiKey`).
Never commit that file. Browser requests can select only registered IDs/models,
not destinations or credentials. Keep deployment trusted/local; mutation-origin
checks are not authentication.

For a compatible local server, a profile additionally declares
`local: { contextTokens: 32768, structuredOutput: true, seedSupported: false }`.
Unknown-price profiles require loopback (use an operator-managed tunnel for a LAN
server). Explicit `local-call-token` mode bounds attempts/tokens/time, **not** compute
cost. Local compute is unknown, never inferred from hosted pricing or declared free.
Hard-dollar mode is rejected for such profiles; strict output is not silently
downgraded if the server lacks capability.

## Artifacts and API

`BENCHMARK_DIR` defaults to `~/.local/share/media-scout/benchmark-runs`, separate from
SQLite. Both supplied Compose files persist it in a dedicated named volume. Existing
deployments must configure persistent storage before running benchmarks; this PR
does not deploy or migrate their files. Artifacts use private permissions, strict
schemas, immutable dataset/snapshot revisions, atomic synchronized updates and a
100-file/100-MB ceiling. No automatic eviction; repair storage before retrying a
blocked launch. A persistence failure blocks subsequent launches in that process.

- `GET /api/benchmarks`: reviewed catalog, profiles, prompts and bounds.
- `GET/POST /api/benchmarks/runs`: bounded history / idempotent launch (`202`).
- `GET /api/benchmarks/runs/:id`: snapshot, summary and paginated results/attempts.
- `POST /api/benchmarks/runs/:id/cancel`: idempotent cancellation.
- `GET /api/benchmarks/runs/:id/export`: sanitized full export.
- `GET /api/benchmarks/datasets/:id/revisions/:revision/cases/:caseId`: reviewed evidence.

The explicit `src/benchmarks/cli.ts` accepts only selected AI connection settings
on stdin and requires `--execute --approve-disclosure --root ... --request-id ...
--max-dollars ...`. Do not pipe a whole settings document or DB export. A repeat
invocation with the same request ID observes its existing run, not another charge.
See the issue-6 baseline report for the actual invocation, measurements and limits.
