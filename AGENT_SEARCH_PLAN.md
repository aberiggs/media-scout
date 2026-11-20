# Agent release-set search — #52 + #55

> **Current parity scope:** #54 (optional remote research MCPs) is deferred.
> Existing Prowlarr-backed search, manual confirmation, and Arr automation are the
> parity target. Earlier compatibility and rollout notes below describe the
> original cutover; the parity follow-up requires a fresh DB.

Approved scope: second PR based on #60 (`ef68938`), targeting
`feat/53-prowlarr-http-mcp`. Publish as a draft; owner will register the GitHub stack.

## Contract

One asynchronous domain operation for HTTP, public MCP and eventual automation.
One selected plan of zero or more observed physical releases, not alternatives.
Coverage is a union and overlap is allowed. Partial plans and explicit gaps are
valid. Zero selected releases is a validated no-match, distinct from interrupted,
failed or budget-exhausted research. Related/owned/queued/future context never
becomes acquisition authority. Private release locators stay backend-only.

The SDK owns the research/tool loop and semantic selection. Application code owns
candidate/target membership, identity conflict protection, privacy, ownership and
schema-validated finalization. No natural-language fallback or legacy-option
fabrication. Preserve old records/receipts without interpreting them as new plans.

## Delivery

1. Small search-only real SDK/MCP feasibility probe before replacing orchestration.
2. Durable normalized request and versioned release-set result; ledger validation.
3. SDK agent replacement, backend-minted MCP capability and unconditional cleanup.
4. Disable incompatible execution/automation actions; retire superseded planner.
5. Contract/API/store/lifecycle regression checks, real search-only service trials,
   independent read-only review, explicit verification and draft publication.

New defaults: 30-minute job, 100 SDK steps, 10-minute model request, 120-second
Prowlarr call; capability covers job/cleanup within 35 minutes. Existing saved lower
limits and all monitoring/safety/client/model preferences remain preserved.

## Deferred / acceptance boundaries

- #54: external research MCP settings and configured external-server integration.
- #56: durable per-release execution (no live download validation here).
- #57: whole-show automation adaptation; incompatible execution must be blocked.
- #58: plan-centric search/history UI; no speculative compatibility options.
- #59: final cross-stack E2E and remaining retirement.

Acceptance includes movie/episode/season/multi-season requests, useful overlapping
packs, partial/no-match, foreign/fabricated candidates/targets, duplicate physical
releases, immutable Arr authority, reload/history, cancellation/lease loss/shutdown,
provider failures and zero grabs. Distinguish fixture evidence from real model and
real Prowlarr evidence. Any unmet checks/design problems belong in PR Known issues.

## Delivery evidence

- Implemented one Agent SDK loop and typed finalization, durable plans/evidence,
  explicit fresh Arr resolution, daemon-backed public stdio MCP, lifecycle/privacy
  guards, and read-only transitional UI. Retired old planner/acquisition engines.
- Automated verification: 358 backend tests, 27 web tests, backend/frontend
  typechecks, production frontend build and diff whitespace checks.
- Real saved-model/Prowlarr research: movie, complete season, partial multi-season,
  collapsed anime numbering, sparse no-match and explicit hard language mismatch.
  Final public-MCP trial selected one observed S1-S3 pack, explicitly reported S4
  as uncovered, and read that result through filtered MCP history. No grabs.
- Firefox rendered desktop/mobile overlapping-plan, gap and error states; actual
  same-origin search creation and observation refresh; no acquisition controls or
  browser errors in checked flows. Designer rendered critique addressed.
- Review found and corrected authority, privacy, cancellation, identity-history,
  cooldown, nullable-numbering, partial-expiry and asynchronous-adapter defects.

Known boundaries remain #54, #56–#59 above. Final cross-stack acceptance, real
external research MCP configuration, download execution, live airing-state and
container/ARM64 acceptance are not claimed by this draft.
