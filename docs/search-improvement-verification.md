# General search redesign: verification record

**Status:** Phase 1 and Phase 2 passed their gates at `9c8ad2f` and `02d5235`. Phase 3 was accepted by the parent after focused verification at the user-authorized scope adjustment. This is not an unconditional Oracle Gate 3 pass: the third Gate 3 review's sole remaining finding was unauthenticated first-run Find more/Other terms actions. The user authorized that narrow fix and tests without another Oracle pass; parent inspection verified both button and dispatch guards, with JSON and NDJSON regression tests. The narrow finding is closed at that authorized scope. Visual review and live retrieval-quality evidence remain outstanding. This record does not replace or rewrite the historical [general-search rewrite verification](general-search-rewrite-verification.md).

## Implemented scope and evidence

| Area | Evidence | What this supports |
| --- | --- | --- |
| Intent schema and query compiler | `src/core/search-planning.ts`; `tests/search-planning.test.ts` (including “preserves literal title/year and meaningful Unicode punctuation” and identity-preservation tests) | Validated structured fields, bounded proposals, Unicode normalization, conservative deduplication, and identity constraints for deterministic fixtures. |
| Bounded conversation/retrieval | `src/core/general-search-conversation.ts`; `tests/general-search-conversation.test.ts` (67 tests in the reported Phase 3 run) | Budget/deadline handling, ledger/refinement, candidate assessment, snapshots, and partial/nonselectable behavior as exercised by fixtures. |
| Cancellation and progress ownership | Conversation, LLM, HTTP, Prowlarr adapter tests | Mocked active-call cancellation, abort propagation, retry prevention, overall deadline, and stable run/stage event metadata. Cancellation tests do not prove provider rollback. |
| HTTP/NDJSON/MCP safe errors | `tests/general-search-rewrite-api.test.ts`, `tests/mcp-server.test.ts` | Typed safe error codes, safe diagnostics/partial event payloads, and suppression of private upstream error text in tested cases. |
| Search-first interface and continuation authorization | `web/src/GeneralSearch.tsx`; parent inspected lines 148 and 261; `web/src/App.test.tsx` tests “omits both continuation credentials after an incomplete first response” (line 1096) and “blocks discovery actions after an incomplete first NDJSON response…” (line 1119); both control and dispatch guard first-run unauthenticated Find more/Other terms. | The user-authorized narrow Gate 3 remediation is implemented and covered in both JSON and NDJSON response paths. This closes that finding only; it is not an unconditional Oracle pass or visual audit. |
| Overall automated suite | Backend `npm test`: 47 files / 829 tests; `npm run typecheck`; web 64 tests, typecheck, and build; `git diff --check` (parent-reported final validation) | Reported checks passed. No additional validation was run in this documentation lane. |

## Important evidence limits

- Compiler and orchestration fixtures are deterministic; they do not measure real-model intent accuracy, retrieval precision/recall, indexer coverage, catalog completeness, or production latency/performance.
- Planner examples and schema validity are not proof that a provider will produce useful results or accept every request. Provider refusal resolution and every reported zero-result cause are not claimed solved.
- Upstream cancellation was tested with mocks. Aborting a client request is not proof that a remote provider/indexer rolled back work already accepted.
- No live provider/indexer search, live read-only catalog evaluation, or grab/submission was performed for this verification.
- Automated web checks and a successful build do not equal desktop/mobile browser visual review. Visual review was not performed in this documentation lane.
- Current bounded refinement remains bounded; unlimited turns, optional depth/breadth presets, capability-aware indexer selection, and protocol-specific retrieval are not established here. Per-request lower budget overrides are implemented; they are not deferred.

## Neutral evaluation matrix (invariants, not model scores)

| Prompt class | Expected invariant | Existing test evidence | Quality still unmeasured |
| --- | --- | --- | --- |
| Named work with year/medium | Preserve the literal identity and explicit context | `tests/search-planning.test.ts` title/year and Unicode tests | Real-model identity drift and recall |
| Named entity/franchise | Keep the entity distinct from a generic category or guessed installment | Search planner identity tests | Live catalog precision/recall |
| Broad category/topic | Produce bounded diverse proposals without needless clarification | Planner proposal and conversation tests | Coverage quality and irrelevant-result rate |
| Unicode/punctuation | Preserve meaningful spelling through normalization | “preserves literal title/year and meaningful Unicode punctuation” | Provider/indexer handling of the resulting query |
| Explicit exclusions/refinement | Keep constraints represented and reassess when intent changes | `tests/general-search-conversation.test.ts` refinement tests | Live semantic adherence and rejection reversibility quality |
| Material ambiguity | Clarify only with a meaningful question when required by the contract | Planner schema and conversation tests | Real-user clarification usefulness |

Do not record fabricated generated-query examples or turn these invariants into a claim of benchmark completion. A future quality benchmark needs a curated neutral catalog fixture set and separately scored intent, identity, constraints, precision, and recall. Any optional live evaluation requires explicit authorization and must be read-only.

## Roadmap reconciliation

The related [issue log](search-improvement-issues.md) distinguishes the implemented/tested behavior from remaining visual review and unmeasured quality. The [future-features list](future-features.md) was checked and left unchanged: UI log visibility, favorites-informed discovery, smarter indexer selection, agentic media management, remote MCP, poll timer/manual poll, and connection validation remain future work because this redesign does not establish their completion. Capability-aware selection and expanded/unlimited refinement are likewise deferred.
