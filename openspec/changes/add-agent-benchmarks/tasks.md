# Tasks

Implementation approved by the user for PR #22. Paid baseline: configured model,
US$2 total including retries/corrections. Targeted label/rubric and sanitized subset
publication/provider disclosure approved in-session. No merge or deployment.

## 1. Dataset and isolation foundations

- [ ] 1.1 Define versioned dataset/label/run/attempt contracts and isolated artifact storage, with synthetic safety cases; verify offline schema, immutable revision, interrupted-run, disk/retention-limit and no-secret persistence tests, and document the formats.
- [ ] 1.2 Implement isolated benchmark composition and transport allowlists; verify deterministic tests reject every grab/Arr/download-link path, redirect escape, production-state writer and offline network attempt, and document the capability boundary.
- [ ] 1.3 Extract versioned prompt builders/registered benchmark variants without changing defaults; verify rendered-request parity and existing planner/group-planning/picker/group-picking/association suites, and document variant/version rules.

## 2. Accountable model execution

- [ ] 2.1 Add optional attempt telemetry before response validation; verify successful, refusal, invalid JSON/schema, correction, 5xx retry, missing usage/cost and provider-error redaction fixtures in focused LLM tests; document known versus estimated/unknown accounting.
- [ ] 2.2 Add abort and per-attempt call/token/spend reservation controls, endpoint capability reporting and run configuration snapshots; verify cancellation/backoff, exhaustion, retry accounting, unsupported strict output, unenforceable hard-dollar rejection and unchanged ordinary-client behavior offline; document budget semantics.

## 3. Capture and reviewed evidence

- [ ] 3.1 Implement explicit metadata/query capture CLI and sanitizer under the design's source/request/time/result ceilings; verify fake-HTTP category/indexer scoping, deduplication, pacing, empty/unknown/truncated distinctions, backoff stop, opaque physical equivalence and sanitization canaries, and document dry manifest review and capture invocation.
- [ ] 3.2 After separate live authorization, verify identity/season/absolute crosswalks and capture the proposed 12-work real-release pilot; deliver sanitized immutable requests/evidence/provenance, reviewed multi-acceptable labels, franchise-level development/held-out split and capture/privacy report. Record exact commands and actual counts; remain incomplete if permissions, mappings or reviewed evidence are missing.

## 4. Scoring and replay

- [ ] 4.1 Implement separate single/group planning, picking and association scoring, including first/final validity, graded preference tiers, abstention, reviewed denominators and hard safety failures; verify offline multi-correct, ambiguous, overlap/hold, inferred-pack, injection and wrong-identity cases, and document metric definitions.
- [ ] 4.2 Implement exact-request decision replay and paired live experiment manifests without substring retrieval simulation; verify unseen queries are unsupported, cap/admission losses and support rates are reported, unequal support/revisions are not ranked unqualified, and document pool-relative recall and holdout limitations. Verify paired-capture behavior with fake transports; real execution needs separate authorization.

## 5. In-app ad-hoc runs

- [ ] 5.1 Implement benchmark run service/API with server-side endpoint profiles, idempotent start, one-active-run bounds, polling/cancel, immutable snapshots and sanitized exports; verify API origin/input/conflict/duplicate/restart/cancel/privacy tests and document routes, retention and trusted-local deployment.
- [ ] 5.2 Add the Benchmarks page with dataset/track/model/prompt/repeat/budget selection, explicit disclosure/cost confirmation, progress, comparable results and per-case failures; verify frontend launch/reload/cancel/error/comparison tests, responsive keyboard-accessible rendered review and no production-settings changes; document the operator workflow.

## 6. Integration and baseline

- [ ] 6.1 Run focused suites, then `npm run typecheck`, `npm test`, `npm --prefix web run typecheck`, `npm --prefix web test`, `npm run build`, `git diff --check`, and `openspec validate add-agent-benchmarks --strict`; record commands/outcomes in progress.md. Verify applicable CI amd64/arm64 image builds and SQLite native-addon smoke checks separately; do not infer them from local frontend checks.
- [ ] 6.2 After explicit data/model/budget authorization, execute a small two-model one-repeat baseline on the frozen reviewed dataset; deliver per-stage quality/safety/support/latency/token/cost counts with unknowns and limitations, confirm zero prohibited mutations, and link sanitized approved evidence to #6. Keep #15 prompt tuning as a separate approved change using development cases only.
