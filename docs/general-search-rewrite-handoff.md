# Fresh-agent handoff: conversational general-search rewrite

> **Implementation and validation status — 2026-10-06:** The additive conversational discovery lane, HTTP/NDJSON and MCP contracts, web conversation/explicit-selection flow, and durable general-search operations are implemented and have passed backend, UI, browser, typecheck, build, controlled-operation, and whole-system Oracle checks. See the [verification record](general-search-rewrite-verification.md) for exact evidence and residual limits. Delivery is tracked in [draft PR #9](https://github.com/aberiggs/media-scout/pull/9); live download-client routing/grab validation is not claimed.

## Current state

### Pre-rewrite foundation baseline (historical)

The original handoff was written against an initial foundation: one-to-three planned Prowlarr queries and a legacy confirmation path capped at ten releases. That description is retained only as a historical baseline; it is no longer the current implementation. Read `docs/general-search.md`, `docs/operations.md`, [the verification record](general-search-rewrite-verification.md), and current implementation/tests before making changes.

Existing relevant code:

- `src/core/general-search.ts`: current search/grab service and safety checks.
- `src/core/general-search-conversation.ts`: bounded iterative conversational discovery service.
- `src/types/general-search.ts`: current HTTP/MCP payload contracts.
- `src/clients/prowlarr.ts`, `src/types/prowlarr.ts`: upstream API parsing and provider-routing digest.
- `src/core/state.ts`: settings, snapshots, and durable submission receipts.
- `src/daemon.ts`: HTTP routes and monitor scheduler.
- `src/mcp/server.ts`: stdio MCP tools.
- `src/compose.ts`: immutable composed runtime clients/settings.
- `web/src/GeneralSearch.tsx`, `web/src/App.tsx`, `web/src/App.test.tsx`: current UI and tests.
- `docs/general-search-rewrite-verification.md`: implementation summary, evidence, pending gates, and residual limitations.
- `docker/Dockerfile`: the web build consumes shared types from `src/types`; preserve its copy-before-build ordering.

Preserve existing general-search HTTP/MCP behavior where possible and keep `ma_search` / `ma_pick` backward-compatible. Do not change Sonarr/Radarr monitoring behavior as a side effect.

## Original coordination and contract requirements

The following records the original project requirements for historical context. Implementation evidence and any remaining release work are in the [verification record](general-search-rewrite-verification.md).

This is a substantial product/architecture change. Before coding, inspect the repository and write a concise design plan covering UX flow, API/event/data contracts, durable operation model, safety transitions, migration/compatibility, and tests. If that plan materially changes the direction or weakens a requirement below, pause and obtain the user's decision rather than silently substituting an approach.

Delegate UI implementation and visual review to `@designer`; delegate bounded backend contracts/implementation to `@fixer`; ask `@oracle` for a risk-focused review of staged-selection, streaming, and durable-operation safety. Agree on shared contracts first and divide file ownership to avoid overlapping edits. Keep the work focused; don't start unrelated roadmap items.

## Original product and UX requirements (historical acceptance checklist)

1. Make the discovery experience chat-first: one composer, distinct immutable user/assistant turns, and the original request retained as context across at most five bounded follow-up turns. A follow-up must not overwrite prior turns or share mutable form state with them.
2. Handle broad, useful requests directly; don't force needless exact-title/creator clarification loops. Clarify only when genuinely needed.
3. Create a polished, accessible dark UI: coherent spacing, rounded surfaces, clear focus and autofill states, keyboard support, responsive layouts, and a real accessible modal (focus management, escape/close handling, and inert background). Avoid nested marketing-card clutter. Treat visual quality as a required deliverable, not incidental polish.
4. Keep the model grounded: after each search, provide the LLM with actual sanitized result metadata and require a bounded classification such as **Match**, **Possible match**, or **Clearly unrelated**. Keep clear/possible matches, visibly communicate uncertainty, and filter clearly unrelated candidates. Never invent release facts or rely on unsupported content knowledge. Curation may only present candidates; it must never grab.
5. Apply deterministic viability filters before LLM curation. By default hide torrents reporting zero seeders; offer an explicit setting/override and distinguish unknown counts from zero. Surface stale/dead signals. Exclude explicitly unsafe/incompatible blockers. Use protocol-appropriate logic for Usenet; don't impose torrent seeder ranking on Usenet. Relevance is not a mandatory seeder sort.
6. Support bounded iterative query refinement from actual results. Separate maximum query count, candidate cap, AI/budget cap, prompt-batch size, display limit, and download-selection size. Do not send one giant prompt. Deduplicate queries/releases and batch metadata for curation. Provide “find more”, “more like these”, and “try other terms” actions that preserve prior suggestions and avoid repeating prior work/results.
7. Show truthful progress events: planning, proposed query terms, searching, results, curation. Streaming may be SSE or another justified design while retaining existing JSON endpoints for compatibility. Never fake percentage timers or expose private chain-of-thought. No generic job/worker framework unless the approved plan shows it is necessary.
8. Keep conversation state in page memory by default. Do not persist conversations unless the user explicitly approves that change.

## Original selection and durable submission safety requirements

The current 10-item cap is insufficient for manifest-sized selections. Allow all returned selectable release IDs, bounded by a documented/configurable candidate cap. Approval must freeze the entire selected manifest before the first POST; there must be no silent partial-selection substitution.

Use a durable, serial, bounded-step operation with a status/reconciliation API (including a suitable MCP path) or another equally safe architecture approved in the design. Requirements:

- Persist manifest identity, selected IDs, progress/receipts, source identity, destination routing identity, and safety snapshot before submission begins.
- Preserve idempotency and concurrency safety across duplicate requests, process restarts, and processes sharing the database. Credential rotation must not erase same-source receipt protection.
- Never automatically retry an uncertain or unknown outcome. A lost step response must be reconciled through read-only status, not a mutating retry.
- Stop future steps on failure, rate limit, expiry, changed permissions/dry-run, source/runtime mismatch, or destination/routing changes. Recheck at every await boundary and before every POST. Navigation may stop future steps but cannot undo a POST already issued.
- Require explicit human review of destination, mode, and the complete selection; confirm the frozen manifest. Never let the LLM select/submit or turn a streamed result into an implicit approval.
- Keep “submitted” distinct from completed download/import. Retain durable receipt handling and no automatic retries for ambiguous outcomes.

## Original privacy, compatibility, and deployment constraints

- Never return, prompt with, log, or persist API secrets, raw provider field values, private upstream URLs, or credential-bearing release data. Existing safe public snapshots/receipts must remain secret-free.
- Preserve canonical routing verification: provider implementation/config contract, canonical provider fields, and category routing belong in the private digest. Omitted/null optional Prowlarr field values are equivalent; meaningful false/zero/empty-string values remain distinct.
- Use immutable cloned runtime settings that match the clients constructed from them. Reject stale source/AI endpoint/key/model identity before upstream/paid work; a subsequent AI change alone must not invalidate a grab that needs no LLM. Recheck live safety permissions, dry-run state, expiry, source, and routing between awaits/at each POST.
- Preserve `ma_search` and `ma_pick`; add new MCP tools/contracts rather than silently changing their meaning. Keep current HTTP JSON paths working while adding progress/stream endpoints.
- The API has no authentication; document trusted-network/loopback exposure. Keep Compose binding loopback-only by default.
- Prowlarr's actual download-client schema/category behavior needs controlled live/API validation; do not claim parser or routing correctness from mocks alone. Don't change Arr operations.

## Original test and review expectations

These checklist items record the rewrite's original acceptance criteria; current results and remaining limitations are in the [verification record](general-search-rewrite-verification.md).

Add focused tests before declaring completion. Cover at least:

- immutable turn/context behavior and follow-up bounds; broad request handling and genuine clarification;
- curation keeps plausible matches, rejects unrelated/malicious metadata, and does not invent fields;
- deterministic zero/unknown/stale viability filters and protocol-appropriate behavior;
- dedupe, bounded budgets, query caps, batching, event ordering, find-more behavior, and no duplicate suggestions;
- all returned IDs including selections above ten; freeze-before-first-POST; multi-step success and partial failure/rate-limit behavior;
- lost-response read-only reconciliation, restart/cross-process idempotency, expiry/permission/dry-run/source/routing changes between steps, and no auto retry;
- provider/credential redaction, runtime source drift, saved-settings refresh, routing digest equivalence, existing HTTP/MCP contracts, and unchanged Arr behavior.

Run backend tests, UI tests, typechecking, web production build, `git diff --check`, and a current-tree Docker Compose build. Browser-verify at desktop 1440x900 and mobile 390x844 with screenshots for empty chat, clarification, results, selection, confirmation modal, expired/unknown state, keyboard focus, and autofill in dark mode. Verify behavior without executing live grabs. Ask `@oracle` for final safety signoff; include evidence and residual limitations in the handoff/PR.

Suggested checks (adapt only if package scripts differ):

```sh
npm test
npm run typecheck
npm --prefix web test -- --run
npm run web:build
git diff --check
docker compose up -d --build
```

## Roadmap

Read `docs/future-features.md` per `AGENTS.md`. Reconcile only ideas demonstrably completed or partly completed by code/tests; retain uncertain items. Do not imply that this rewrite completes unrelated roadmap work.
