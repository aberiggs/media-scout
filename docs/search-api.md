# Search API and state boundary

The v2 search contract is independent of Arr identifiers. A request needs only a nonempty `prompt`; optional `context`, `preferences`, and `requirements` may refine it. Language/resolution preferences are descriptive guidance, not deterministic rejection gates. Search actions are limited to `list_indexers`, `search_releases`, and `finish`; search itself has no submission action.

Example request:

```json
{ "prompt": "Find the film", "preferences": { "audioLanguages": ["ja"], "resolutions": ["1080p"] } }
```

Example progress response:

```json
{ "searchId": "s_opaque", "status": "running" }
```

Terminal statuses are `matched`, `no-match`, `needs-input`, `budget-exhausted`, `failed`, and `interrupted` (plus `queued`/`running` progress states). Ranked options refer only to opaque observed `candidateId`s; they expose concise reasons and uncertainty, not URLs, magnets, GUIDs, or hashes. A submission requires `{ "searchId": "s_opaque", "optionId": "o_opaque", "idempotencyKey": "client-generated-key" }`. Reusing an identical key replays the durable receipt; changing its payload conflicts. Submission is an explicit action, never a search tool.

## Persistence and privacy

`SearchStore` is a narrow SQLite repository for search/result history, safe and private candidate material, tool/audit events, settings payloads, target/provider deadlines, owner-checked leases, submission receipts, finite target/release grace and exclusions, and source-timestamped observation cache. Private candidate locators stay local and expire; safe search history can outlive them. Pruning search history does not prune submission receipts or active grace. Cached observations are explicitly marked complete/incomplete and cannot authorize side effects; submission paths must use fresh observations.

The initial repository is intentionally a foundation, not the HTTP/MCP server or a complete submission service. It creates a new empty database or reopens its own schema. If an existing database contains tables without the search marker, open fails with instructions to select a fresh path. The legacy file is inspected read-only before writable initialization; it is neither migrated, deleted, nor modified. Before rollback, stop writers and restore the prior binary/database consistently. External download jobs are not undone by restoring or changing a database path; account for them before resuming the old engine.
