# General search improvement proposal

**Status: discussion proposal only, except the separately requested saved prompt setting.** This document consolidates design and engineering recommendations for review; it is not approval to implement a broader redesign, an implementation commitment, or evidence that proposed behavior exists. The bounded, durable observations and issue statuses are tracked in [Search improvement issues](search-improvement-issues.md). The saved custom search prompt is implemented with backend and UI regression tests; this does not establish that provider refusals or retrieval-quality problems are solved.

## Product direction

Keep general search **search-first, results-dominant, with optional conversational refinement**. It should not become a transcript-centric chatbot. Users come to discover and review results; conversation is a lightweight means to disambiguate or refine. Do not persist transcripts as a new product feature without separate approval. Preserve explicit review before submission, destination routing checks, protocol matching, per-release expiry, and the existing uncertain-outcome protections.

The user experience should distinguish a successful empty search from failure, expose useful progress without turning internal reasoning into a transcript, and allow refinement without repeating stale or cosmetic queries. A user must always understand what has been searched, what is known about results, what remains in progress, and whether any action could submit a download.

## Proposed interaction

Use one auto-growing search textarea with a single focus border and aligned submit action. Omit manual resize handles; growth should follow content within sensible limits. Provide a clearly labeled **Search settings** gear. Separate ordinary user controls (for example, search behavior and the saved prompt) from advanced ceilings; do not make critical controls undiscoverable or expose every backend bound as an ordinary preference.

Place **New search** in the header. During a run, expose **Stop** and keep **New search** enabled. Starting a new search must establish new run ownership and must not accidentally submit, cancel, or reconcile a prior download operation. Keep submission reconciliation separate from search-run lifecycle. Old-run progress, errors, results, and `finally` cleanup must never overwrite a newer run.

Show compact current status, updated by stage and query/batch IDs, rather than appending every state snapshot. Offer expandable query chips/details with a short public purpose, not chain-of-thought. Respect responsive layout, keyboard operation, visible focus, and assistive-technology labels. A mobile or narrow view must not hide the primary search action, current run status, or safety-relevant submission state.

## Query and intent contract

Represent search space across focus (unique title, head-entity/franchise, category, mood, or mixed), identity anchors, medium and its provenance, explicit positive/negative hard/soft constraints, expansion scope, and material ambiguity. A franchise or named entity is not necessarily a unique title; preserve identity and assess ambiguity rather than assuming a unique match. Do not ask needless clarification merely because a request is broad; an episode request without a season may merit a question when it cannot otherwise be resolved. Detailed prompt/query architecture remains a follow-up pending research; see the [search prompt design blueprint](search-prompt-design.md).

Keep query data separate from any public rationale in the structured planner response. Require non-empty, valid queries for search mode and a meaningful question for clarification mode. As a tentative discovery constraint, generate approximately 1–5 terms, each at most 80 characters; tune against fixtures. Exact mode may need a more generous allowance to preserve literal identifiers. Normalize whitespace, deduplicate, and reject URLs, multiline prose, or malformed query values. Do not blindly truncate or autocorrect names, years, episode identifiers, or user terms. Permit bounded schema repair, then return a clear error; never bypass validation or switch to direct search.

Keep the saved `ai.searchSystemPrompt` user-authored, persisted, and bounded at 16,000 characters. It supplements the planner and curator prompts (including the legacy planner) only; it must not affect monitoring or unrelated AI tasks. Code-enforced structured-output, resource, and untrusted-metadata contracts remain authoritative. A custom instruction cannot guarantee that a model/provider will accept a catalog metadata search or override provider policy. Report a refusal safely rather than suggesting that prompt text or a different automatic pathway will bypass it.

Use typed, safe outcomes for provider refusal, HTTP timeout, invalid model output, and exhausted budget. Offer explicit user choices to retry, edit the request/prompt, or select among configured models if that capability exists. Never expose raw provider bodies, credentials, or secrets. There is no ordinary/direct-search fallback and no automatic model switch, ever.

## Bounded retrieval and refinement

Maintain a retrieval ledger with raw results, new results, duplicates, filtered results by reason, assessment counts, and source/query outcomes. Adapt terms using observed yield; do not repeat cosmetically different queries with no new value. Stop when there are sufficient matches, no novelty, two low-yield iterations, or the run reaches a deadline/resource bound. A 120-second run deadline and a target of 20 relevant results are provisional design parameters, not commitments; validate them with real workloads. Existing ceilings (6 queries, 200 candidates, 12 AI calls, batch size 20 by default) remain ceilings, not targets to exhaust. Reserve enough assessment budget for candidates already retrieved and count actual provider attempts, including repair/retry attempts.

Represent follow-up input as structured positives, exclusions, hard/soft constraints, and selected inspirations, with a version or equivalent provenance. Reassess previously seen candidates when constraints change. Relevance rejection should be reversible when a later instruction changes the criteria. Keep unsafe reference, protocol incompatibility, availability, relevance, and unassessed status distinct. Preserve stable candidate IDs and original expiry; refinement must never renew an existing release’s expiry.

If a run fails after valid candidates were assessed, retain those partial findings for review, but mark the run incomplete. Candidates without an authenticated completed snapshot remain nonselectable, including assessed partial findings; unassessed candidates must never be admitted as verified results. Propagate `AbortSignal` through LLM, HTTP, and Prowlarr calls. Use both client generation ownership and server `runID`/sequence ownership so a late completion from run A cannot affect run B. Cancellation is not proof that an upstream action was rolled back; submission state remains independently reconciled under existing safeguards.

Zero-result diagnosis must state only what evidence supports. Distinguish no enabled/available sources, source failures, zero raw results, candidates filtered by deterministic rules, candidates rejected by curation, budget exhaustion, and provider refusal. Do not claim that a title is absent from an indexer or inventory unless the system actually has evidence for that claim.

## Retrieval integration boundaries

The current Prowlarr adapter uses generic query/type search. The referenced API schema documents aggregate fields such as `query`, `type`, `indexerIds`, `categories`, `limit`, and `offset`; schema exposure is not a guarantee of deployed behavior or support by every source. Defer Torznab-specific season/episode/ID syntax and capability-aware query branching until the request path is tested against the actual adapter and representative indexers. Do not encode undocumented assumptions as guaranteed search behavior.

## Phases and acceptance criteria

### Phase 0 — evidence and approval

Reproduce and triage the open items in [the issue log](search-improvement-issues.md), gather sanitized traces, approve product behavior and safety boundaries, and agree on fixtures/metrics. **Accept when** the proposal’s scope, event contracts, outcome taxonomy, and non-negotiable no-fallback rule are explicitly reviewed. This phase does not authorize a broad implementation by itself.

### Phase 1 — query, prompt, and failure contracts

Specify intent-mode schemas, query validation/repair limits, typed failure outcomes, and prompt composition boundaries. Add deterministic tests before UI wiring. **Accept when** exact, discovery, ambiguity, provider refusal, malformed output, timeout, and budget outcomes are distinguishable; no invalid response bypasses validation; blank custom prompt leaves existing messages unchanged; and the setting remains confined to search planner/curator tasks. The separately requested saved-prompt UI and persistence are already implemented and test-verified; the other work in this phase remains proposed.

### Phase 2 — bounded iteration and refinement

Implement ledger-based adaptation, budget reservation, structured constraints, reversible relevance assessment, partial findings, and stop conditions. **Accept when** iteration is bounded under every path, previously assessed candidates are reevaluated when appropriate, expiry and stable identity are preserved, and partial findings cannot accidentally make unassessed releases selectable.

### Phase 3 — lifecycle and progress UX

The specific UI corrections in the issue log may proceed independently once the run/progress contracts are agreed; do not wait for every retrieval feature. Implement search-first layout, concise stage/query/batch progress, expandable query details, Stop/New search ownership, responsive/accessibility behavior, and robust NDJSON parsing. **Accept when** fragmented, unterminated, duplicated, stale, and out-of-order progress events are handled safely; run A cannot mutate run B’s visible state; cancellation works; and search lifecycle never conflates with submission reconciliation.

### Phase 4 — capability-aware retrieval and longer refinement

Only after validating the deployed Prowlarr path, explore source capabilities, pagination, and query syntax. Longer refinement beyond the existing five-follow-up limit is a separate design decision. **Accept when** capability behavior is demonstrated against representative sources, unsupported syntax is not assumed, and any expanded conversation state has explicit privacy, expiry, and resource rules.

## Verification strategy

Add deterministic planner, service, API, and UI tests for exact title/franchise requests; broad media, sports, game, and topic interests; multilingual requests; underspecified episode requests; model/provider refusal; zero raw results; all-filtered results; duplicates; changing constraints; reversible relevance rejection; cancellation; late run-A completion during run B; malformed/fragmented/unterminated NDJSON; budget exhaustion; valid partial findings; and submission safety regressions. Evaluate retrieval precision and recall separately on a curated catalog fixture set from orchestration correctness. Optional approved live checks must be read-only and must never issue grabs. No test should rely on provider prose or expose secrets.

## References and what they establish

- [Prowlarr search API reference](https://github.com/Prowlarr/Prowlarr/blob/develop/_autodocs/api-reference/search.md) and [Prowlarr types](https://github.com/Prowlarr/Prowlarr/blob/develop/_autodocs/types.md): useful references for exposed API shape and fields; they do not prove behavior or capability of each configured indexer.
- [Torznab/Newznab supported parameters](https://github.com/torznab/torznab-docs/blob/develop/docs/source/revisions/1.1-Newznab-supportedParams.rst): protocol-level parameter reference; not proof that the current generic Prowlarr path or every provider honors a given parameter.
- Nielsen Norman Group, [Search: No Results](https://www.nngroup.com/articles/search-no-results-serp/): UX guidance for useful empty-result states; supports evidence-based recovery and diagnosis, not claims about unseen catalog contents.
- Nielsen Norman Group, [Visibility of System Status](https://www.nngroup.com/articles/visibility-system-status/): general usability guidance for timely, understandable status feedback; it does not prescribe the proposed event schema.
- Nielsen Norman Group, [AI Chatbots: UX Guidelines](https://www.nngroup.com/articles/ai-chatbots-design-guidelines/): chatbot UX guidance relevant to clear limits and user control; it does not imply that this search product should become a chatbot.

These references inform design questions but do not validate implementation or replace local behavior tests. Arbitrary MCP agents, remote MCP, Jellyfin integration/media management, and transcript persistence remain out of scope for this proposal; do not infer that search details imply general log visibility or that AI search implies remote MCP.
