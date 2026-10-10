# Issue #10: completed season with open reviews

Investigation of [issue #10](https://github.com/aberiggs/media-scout/issues/10),
2026-10-10. Source baseline: `c0c37f6` (branched from `origin/main`).
This is an investigation/characterization checkpoint, **not an application fix or
production cleanup**. The production symptom remains unresolved.

## Finding

The affected season has **21 open, unlinked `unparseable-title` reviews**, all
permanently tagged `legacy-ineligible`. Its durable work is `fulfilled`, with an
empty saved TV target inventory. A fresh, read-only Sonarr observation reports
the same service/external identity and **14/14 season episodes with `hasFile`**.

PR #7 is deployed and is working for newer captured-evidence reviews: the same
database contains **49 resolved `unparseable-title` reviews** for another season.
Those rows captured a target episode and resolved together on 2026-10-07.
The remaining 21 rows are a different, explicitly excluded legacy case, not
evidence that the running container lacks PR #7 or that its intended cleanup
fails. Waiting for another poll, refreshing the page, or pulling the same image
does not change the durable `legacy-ineligible` marker.

## Deployment and observation evidence

Read via SSH; no container pull, restart, recreation, or deployment was performed.

| Evidence | Observed value |
| --- | --- |
| Running OCI revision | `32b05b37727c3a43ce15b8feb8240b7a5488a623` (PR #7 merge) |
| Running image ID | `sha256:563170154a7160ff649f8208b55bf6c69d62590c745108374b79194739b49a93` |
| Running repository digest | `ghcr.io/aberiggs/media-scout@sha256:46fb64ee21579ab0c48c9899812ee5bdbc3182dd80dcfe97fb1f3e0d934eb11d` |
| Locally tagged `latest` | Same image ID, revision, and digest as running container |
| Container created / started (UTC) | 2026-10-07 01:21:54 / 01:21:59; running, healthy |
| Review creation interval (UTC) | 2026-10-02 06:37:58–06:38:06 |
| Saved work/library observation (UTC) | 2026-10-10 23:13:10 |
| Bounded live Sonarr reads completed (UTC) | 2026-10-10 23:17:28 |
| Affected series | Identity matches saved work; monitored; anime; season 1 |
| Positive library evidence | Nonempty season inventory: 14 episodes, all 14 have files |
| Sonarr queue | Complete page, 0 total rows; **not used as import proof** |
| Affected review subjects | No intent or queue links on any of the 21 rows |
| Affected intent | One captured intent, already fulfilled; no release recorded |
| All saved intents | Two, both fulfilled |
| Affected work claims in snapshot | None |
| Saved production safety settings | Monitoring enabled; dry-run off; operator actions enabled |

The image facts establish that the running container matches the server's local
tag. They do not establish the current remote registry `latest` digest or prove
the time of an operator's pull. The important revision does contain PR #7.

## Root-cause trace and historical limits

1. `State.initializeLegacyReviews` (`src/core/state.ts:479–505`) initializes only
   unlinked, open title reviews whose evidence is NULL. It tries to capture the
   durable work's service/external identity and saved missing episode IDs. TV
   evidence must contain a nonempty set of valid IDs (`state.ts:241–245`). If
   this cannot be established, the row is tagged `legacy-ineligible`.
2. `Runner.resolveImportedUnparseableReviews` (`runner.ts:1085–1127`) skips that
   tag explicitly. It never reconstructs historical review targets from a
   newly observed season, a fulfilled intent, or the season key alone.
3. Work fulfillment is independent: `reconcileWork`
   (`work-queue.ts:659–672`) can recover a terminal work row with no saved targets
   from a nonempty, known, fully filed inventory for the exact season.
4. Dashboard counts are independent as well (`operations.ts:26–107`). Default
   active work excludes terminal rows, but open-review counts still include
   them. `Operations.tsx:196–200` renders `fulfilled` as “Complete.”

The older `930b577` and `a1600e4` implementations of `terminalItem` cleared TV
targets when making work terminal. PR #5 (`f5709d2`) preserves those targets for
future reconciliations, but cannot restore already-lost targets. This provides
a source-confirmed historical mechanism for the observed empty inventory.
**The snapshot does not record when that inventory was cleared, when the
ineligible tags were written, or the exact historical target set.** No old
backup/log evidence was used to prove that sequence. Current behavior is
reproduced directly without requiring that historical inference.

## Isolated runtime validation

- Used Python SQLite's backup API from a read-only source connection to produce
  a consistent in-memory snapshot, transferred over SSH into private local
  storage outside Git. `PRAGMA integrity_check` returned `ok`. The running
  production database and its settings were not changed; no writers were stopped.
- Live requests were restricted to GETs for the affected Sonarr series, its
  episodes, and one complete queue page. Credentials were read privately inside
  the server process and sent only to the configured Sonarr service. No LLM,
  indexer, search, grab, or download-client request was made.
- On a separate copy, replaced imported settings with safe defaults before
  composing the service: monitoring disabled, dry-run enabled, operator actions
  disabled, no production integration credentials. Outbound `fetch` and LLM
  completion were made to throw.
- Replayed the existing title-review cleanup method twice using the bounded
  observed season evidence. This was **not a full production cycle**: the
  Radarr library was unknown, and no inference was made about other libraries.
  All 21 reviews remained open/ineligible. Exact rows in review, work, intent,
  dedupe, decision, association, and operator-audit tables were unchanged.
- Started `buildApp` on an ephemeral `127.0.0.1` port with that safe copy. Actual
  HTTP GETs returned health `ok`, dry-run true, 21 open reviews in both work
  counts and review totals, and the affected history row as fulfilled with zero
  displayed missing targets. The listener was closed after validation.
- Separately evaluated work eligibility with the operator gate bypassed for
  **read-only diagnosis**: Retry → `work-not-retryable`; Reset →
  `work-not-resettable`. No work action or production review resolution was executed.

The private snapshot remains outside the repository in
`/tmp/opencode/media-scout-issue-10/` (directory mode 0700; databases mode 0600).
It contains sensitive state and must not be published, used as a committed test
fixture, or started with its original production monitoring/settings intact.
Committed replay fixtures use synthetic titles, identities, IDs, and timestamps;
only the observed counts/topology are retained.

## Classification and reason-specific resolution boundaries

| Review category | Classification / safe route |
| --- | --- |
| Captured, unlinked `unparseable-title` | Safely auto-resolvable completed-generation history **only** with every immutable target positively filed under matching identity and valid observation ordering. PR #7 handles this. |
| Eligible legacy title evidence | Requires safely captured durable identity/targets and a nonempty fully filed current season. Partial/unknown reads or an identity hold preserve it. |
| **Observed 21 legacy-ineligible rows** | Legacy history requiring explicit human acknowledgement; current full-season files prove current completion, not the original review target generation. Do not retag from the current season key or retry fulfilled work. |
| Ordinary picker/search/client/failure review | Scheduling uncertainty on nonterminal work; guarded Retry/Reset may apply with fresh known reads and no claim/reservation/queue hold. Fulfilled work alone is not a reason-independent review-resolution rule. No such rows were present in this snapshot. |
| Linked queue/intent review | Unresolved download/association uncertainty; preserve captured holds and dedupe. Only the existing evidence-backed association/release lane applies where eligible. No such open rows were present here. |
| Orphan, identity-changed, malformed or stale evidence | Preserve review; do not infer historical identity/coverage or use an empty queue as completion. Explicit handling or additional evidence is needed. |
| New missing targets under the same season key | Separate generation. A previous resolution must not suppress its review or authorize cleanup of its targets. Existing generation-aware capture/dedupe tests cover this boundary. |

### Why no useful dashboard action exists

Production operator actions are already enabled. The work's terminal status
blocks Retry/Reset (`state.ts:661–665`); enabling actions again will not help.
Association is offered only for `queue-review`. Release requires an eligible,
explicitly linked unresolved intent (`operations.ts:88–103`); these rows have
neither. The HTTP dashboard deliberately has no generic dismiss control.

The API supplies status/action blockers, but does **not** project the review's
evidence kind or a reason-specific automatic-resolution explanation. The UI
therefore says the release title could not be interpreted and that Retry/Reset
are unavailable for this status; it cannot explain the legacy-ineligible marker
or point to an acknowledgement route. This is the concrete residual UX gap.

### Existing explicit handling route — not performed

For an individually inspected, unlinked title-history row, the existing MCP
`ma_review_action` request `{ "id": <reviewId>, "action": "resolve" }` records
only `resolved_at` (`src/mcp/server.ts:73–93`, `state.ts:549–554`). It does not
mark work imported, retry work, release an intent, erase a review, or clear
dedupe/receipts/claims. The resolve variant is distinct from the gated
administrative recovery variants and does not currently require
`allowOperatorActions`; a host must still obtain per-call human approval.

Before doing this on production, re-list the rows privately and verify the
selected row is one of the unlinked legacy title reviews, the intended season
identity still matches, and current files remain complete. Acknowledge selected
rows deliberately, not every review associated with fulfilled work. The
existing resolve route records a timestamp, **not a new reason/note audit
event**; retain operator rationale separately without publishing private data.
This investigation does not authorize or perform those mutations.

## Checks and remaining scope

New `tests/issue-10-review-replay.test.ts` contains five passing offline
characterization cases: NULL and already-tagged legacy evidence through repeated
full synthetic polls, captured evidence resolution/idempotence, HTTP count and
action projection, and per-row acknowledgement preserving durable tables.
Networking is disabled; paid/action methods throw and are asserted unused.
These tests lock down the observed safety behavior, not a newly implemented fix.

| Command / check | Result |
| --- | --- |
| `npm test -- tests/issue-10-review-replay.test.ts` | 5 passed |
| `npm test -- tests/runner.test.ts tests/state.test.ts tests/review-policy.test.ts tests/operations-api.test.ts tests/issue-10-review-replay.test.ts` | 5 files, 144 passed |
| `npm test` | 43 files, 655 passed |
| `npm run typecheck` | Passed |
| `npm --prefix web run typecheck` | Passed |
| `npm --prefix web test` | 36 passed; includes terminal action handling, unavailable actions, review scopes, and recovery confirmation |
| `npm run build` | Passed |
| Private copied-DB cleanup replay + loopback HTTP reads | Passed; preserved 21 reviews and historical state as described above |

Existing suites additionally cover partial/unknown reads, identity mismatch,
linked queue/intent safety, legacy orphans, owner claims, observation ordering,
malformed evidence, stable resolution timestamps, and new target-generation
dedupe. No new Radarr cleanup rule or additional movie-specific cleanup coverage
was added: movie behavior is not the observed failure.

Docker amd64/arm64 build and native-addon container smoke checks were not run
locally; frontend build is not evidence for them. No app source or runtime policy
was changed. Issue #10's implementation-level acceptance criteria (a reviewed
reason-specific UX/resolution change and its targeted UI tests) remain open.

**Recommended next scope:** propose an explanation for completed legacy review
history and a deliberately scoped, auditable human acknowledgement path. Keep
terminal Retry/Reset disabled; do not add blanket completion cleanup, silently
recover legacy targets from current IDs, or touch unresolved queue/intent holds.
Any automatic use of historical intent captures needs a separate design that
proves identity, generation, and linkage rather than assuming them from a key.
