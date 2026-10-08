# Search prompt and planner design

**Status:** This document separates implemented Phase 1–3 behavior from future hypotheses. Phase 3 was accepted by the parent after focused verification at the user's authorized narrow continuation-authorization fix; that is not an unconditional Oracle Gate 3 pass. The schema and compiler below are implementation facts, not guarantees of model quality. See the [verification record](search-improvement-verification.md) and [issue log](search-improvement-issues.md).

## Implemented planner contract

`src/core/search-planning.ts` defines a structured search plan with:

- `mode`: `search` or `clarify`;
- `searchSpace`: focus (`unique-title`, `head-entity`, `category`, `mood`, `mixed`), up to 12 identity anchors, medium/provenance, up to 12 positive and negative hard/soft constraints each, and an expansion scope;
- up to five `proposals`, each separating `query` (maximum 300 characters), short `purpose` (160), `branch` (100), `strategy`, and preserved anchors;
- a clarification question (maximum 500 characters).

Search mode requires proposals and no question; clarify mode requires a meaningful question and no proposals. Query compilation validates shape, preserves identity anchors, normalizes NFC/whitespace, deduplicates normalized queries, and rejects unsafe/non-query-like content. A query longer than 80 characters is rejected only when it does not preserve an identity anchor; do not describe 80 characters as the universal limit. Planning and candidate curation use bounded structured calls; the service applies budgets, retrieval-ledger decisions, batch assessment, deadlines, and stop conditions. Exact field limits and validation are code-enforced; semantic accuracy is not.

The built-in planner frames the model as a catalog-query generator and metadata semantic filter. It asks for multidimensional intent, preserves named entities, distinguishes known facts from assumptions, and treats catalog/indexer text as untrusted data. Candidate curation assesses supplied candidates; it does not choose or submit releases. The saved `ai.searchSystemPrompt` is a bounded, user-authored supplement to search planner/curator prompts, not a bypass of structured-output, safety, or provider policies. No direct-search fallback or automatic model switch exists.

## What tests establish

Deterministic compiler and service tests cover literal title/year and Unicode punctuation, identity-anchor preservation, category/diverse proposals, negatives and refinement, bounded iterations, correction/failure paths, and safety handling. See `tests/search-planning.test.ts` and `tests/general-search-conversation.test.ts`; the broader test inventory and limitations are in the [verification record](search-improvement-verification.md).

These tests establish schema/compiler and orchestration invariants for supplied fixtures. They do **not** measure real-model recall/precision, provider refusal rates, indexer coverage, real-catalog ranking, or latency/performance. Examples in prompts are not evidence that the model consistently generalizes.

## Future evaluation and deferred design

For a neutral evaluation matrix, record an input and check invariants rather than demand one exact generated query:

| Input class | Invariant to evaluate | Existing deterministic coverage |
| --- | --- | --- |
| Named title plus year/medium | Preserve literal identity and explicit medium | Compiler fixture tests |
| Franchise/head entity | Keep entity anchored; do not substitute a generic category | Identity-preservation tests |
| Broad category/topic | Cover more than one useful branch without needless clarification | Diverse-proposal/service tests |
| Unicode name/punctuation | Retain meaningful identity through normalization | Compiler Unicode test |
| Explicit positive/negative | Preserve constraints for semantic assessment | Conversation refinement tests |
| Material ambiguity | Ask a meaningful question only when search cannot proceed usefully | Planner schema/service tests |

This matrix describes invariant coverage, not a completed model-quality benchmark. Future evaluation should separately measure intent/category coverage, identity drift, invented attributes, unnecessary clarification, positive/negative constraint handling, precision/recall, refinement reversibility, cost, and stopping behavior on a curated neutral fixture set. Any optional live evaluation needs explicit authorization, must be read-only, and must not submit grabs.

Longer-than-current follow-up histories, unbounded turns, user-facing depth/breadth controls, per-indexer capability discovery, source selection, and protocol-specific query syntax remain deferred. The current adapter uses generic Prowlarr search; API schema fields alone do not prove configured indexer support. Preserve bounded resource limits and do not infer local-only processing: model requests and catalog queries go to configured upstream services.
