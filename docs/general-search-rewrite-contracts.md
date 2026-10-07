# General-search rewrite contracts (phase 1)

This document is the shared additive contract for the parallel web/backend work. It specifies interfaces only; it does not imply that any new route, setting, streaming, persistence, or operation behavior is implemented. Existing `GeneralSearchRequest`, `GeneralSearchResponse`, `GeneralGrabRequest` and `GeneralGrabResponse` keep their current shapes and meanings.

## Conversation search

`POST /api/search/conversation` accepts `GeneralSearchConversationRequest` and returns `GeneralSearchConversationResponse` as JSON. `POST /api/search/conversation/stream` accepts the same JSON request and emits UTF-8 NDJSON: one JSON `GeneralSearchProgressEvent` per line. `sequence` starts at zero and increases by one for each emitted event; exactly one terminal `complete` or `error` is emitted. Both routes run the same search pipeline and produce the same completed response. Progress exposes no private chain-of-thought.

Request shape:

```ts
{
  originalQuery: string;
  turns: readonly { role: 'user' | 'assistant'; content: string }[];
  action: 'search' | 'follow-up' | 'find-more' | 'more-like-these' | 'other-terms';
  previousSearchId?: string;
  confirmationToken?: string;
  selectedInspirationIds?: readonly string[];
  budgets?: Partial<GeneralSearchBudgets>;
}
```

`originalQuery` remains the root context. `turns` is an immutable ordered context with one initial user turn and at most five user follow-up turns (and corresponding assistant turns as available); clients must not mutate earlier turns. A subsequent action references the prior sanitized snapshot using `previousSearchId` and its `confirmationToken`; the server resolves prior executed queries/results from that snapshot, not a stored transcript. Selected inspiration IDs are optional and must be IDs from that snapshot. New results accumulate into a new snapshot while every retained release keeps its original `expiresAt`; follow-ups do not renew release validity.

`budgets` is an optional per-request override using `queryCount`, `candidateCap`, `aiCalls`, `batchSize`, `displayLimit`, and `hideZeroSeeders`. Numeric query/candidate/provider-attempt/batch values may reduce their configured ceilings but cannot increase them; `displayLimit` is a pagination/display control and may be adjusted independently up to 1000. `hideZeroSeeders` may be explicitly overridden per request, including `false`.

`GeneralConversationRelease` retains the existing public release fields and adds optional `relevance` (`match`/`possible-match`) and `viability` metadata. Only sanitized fields may appear. Credential-bearing/unsafe upstream references are excluded and nonselectable; they must never be returned, persisted, or used as selectable release IDs. By default zero-seeder torrents are hidden. The `hideZeroSeeders` setting may explicitly disable that filter; unknown seeder counts are not equivalent to zero.

## Budgets and settings

Add the canonical optional/defaulted flat `generalSearch` section to settings; old settings documents without it remain valid and existing consumers retain their prior behavior. Its contract is `GeneralSearchSettings { maxQueries?, maxCandidates?, maxAiCalls?, batchSize?, displayLimit?, hideZeroSeeders? }`. Defaults are 6/200/12/20/40/true. Backend resolves omitted values to defaults and rejects values beyond these bounds:

| Setting | Default | Hard maximum |
| --- | ---: | ---: |
| `maxQueries` | 6 | 20 |
| `maxCandidates` | 200 | 1000 |
| `maxAiCalls` | 12 | 100 |
| `batchSize` | 20 | 100 |
| `displayLimit` | 40 | 1000 |

All numeric settings are positive integers. Candidate cap is the maximum unique candidate/release set for one snapshot. These are independent ceilings: query count is not AI-call allowance or prompt batch size. `maxAiCalls` counts actual provider attempts, including initial/correction calls and provider 5xx retries, not just logical LLM requests. `displayLimit` controls pages/results shown, not the search candidate ceiling. `hideZeroSeeders` defaults to `true`; request override is explicit and supports `false`.

## Durable operation API

Creation: `POST /api/search/:id/operations`, request `GeneralSearchOperationCreateRequest`; response is `GeneralSearchOperationStatus`. The client generates a UUID `operationId` before the request. `releaseIds` is the entire unique frozen manifest, never a partial selection; `confirmed` must be literal `true`. Creating an operation freezes/validates selection but performs no upstream mutation.

Progression: `POST /api/general-operations/:id/step` with `{ expectedOrdinal: number }`, returning the updated public status. `GET /api/general-operations/:id` returns status without mutation. `POST /api/general-operations/:id/stop` stops future steps and returns `{ operation: status }`. Ordinals are zero-based. A duplicate, stale, or out-of-order ordinal must not advance `nextOrdinal` or cause another upstream submission. A lost step response is reconciled using GET, not by retrying a mutation.

Public operation status contains the complete frozen manifest and one status/code per release, in manifest order. Status values are `pending`, `submitting`, `submitted`, `previously-submitted`, `dry-run`, `failed`, `uncertain`, and `not-attempted`. Status includes `mode`, `destination`, `expiresAt`, `nextOrdinal`, `stopped`, and `complete`. It must not include secrets, private upstream URLs, raw provider values, credential-bearing references, or internal routing digests. The operation is serial; uncertain outcomes are never automatically retried.

## MCP additions

Add new MCP tools without changing `ma_search` or `ma_pick`: a conversation-search tool with the same request/response contract as JSON conversation search; operation creation with the same frozen-manifest validation as HTTP; read-only operation status; one expected-ordinal step; and stop. MCP responses expose the same sanitized public contracts. No transcript persistence is introduced by these tools.

## Ownership and scope

Backend owns validation/defaulting, immutable sanitized snapshots, snapshot expiry, search/curation pipeline, streaming event sequencing, settings migration/defaulting, operation durability/idempotency/safety, HTTP routes, and additive MCP tools. Web owns in-memory immutable conversation turns, consumption of JSON/NDJSON contracts, rendering truthful progress and selectable sanitized results, and explicit full-manifest confirmation. Phase 1 defines these contracts only; implementation is subsequent work. Legacy endpoints and MCP tools remain compatible.
