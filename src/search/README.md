# Search subsystem

HTTP and MCP adapters share the search domain. Search queries Prowlarr and returns ranked alternatives; it does not download. Submission is a distinct explicit operation. Automation reads Sonarr/Radarr state and is optional. Dry-run is the default and prevents grab requests, not search/provider costs.

Implementation map:

- `service.ts`, `selection.ts`: bounded search orchestration and candidate validation.
- `contracts.ts`, `arr.ts`, `automation.ts`: shared contracts and Arr automation.
- `submission.ts`: explicit submission and idempotency boundary.
- `store.ts`, `settings.ts`: SQLite persistence.
- `runtime.ts`, `mcp.ts`: runtime wiring and MCP adapter.

Preserve these boundaries: failed or incomplete Arr reads are unknown, not empty. Submission uses idempotency to avoid duplicate POSTs; uncertain outcomes are not automatically replayed. A matched search or submitted grab does not prove download or import completion. Private download locators are kept out of public responses and model context.

HTTP routes are registered in `src/daemon.ts`; MCP tools are registered in `src/search/mcp.ts`. `src/mcp/server.ts` is the MCP process entry point. Prefer these implementations and shared contracts as the source of truth for current behavior.
