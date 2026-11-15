# Media Scout replacement — approval report

**Status: implementation approved.** Owning issue: [#24](https://github.com/aberiggs/media-scout/issues/24). Selection-quality cases remain in [#15](https://github.com/aberiggs/media-scout/issues/15).

## The product

Media Scout becomes an LLM-backed torrent/indexer search tool. Sonarr/Radarr automation is one client of that tool, not the foundation of its search contract. The application remains one deployable process; these are isolated modules, not separately deployed services.

```text
Search UI / external HTTP or MCP client ──┐
                                        ├─ Search service ── read-only Prowlarr tools
Arr automation ── fresh Arr observations ─┘       │
                                                └─ ranked suitable options / no match

Explicit manual confirmation OR enabled Arr rank-1 selection
                         │
                         └─ Submission service ── Prowlarr ── configured download client

SQLite: audit, settings, retries and finite side-effect protection; not library truth
```

## 1. Search contract

- Input: a natural-language prompt. Optional context adds titles/aliases, year/IDs, episode/season/absolute numbering, relevant descriptive metadata and preferences. No Arr connection is required.
- A multi-turn agent can inspect configured indexers, try queries, examine all returned candidates and refine its search. Internal typed tools and external HTTP/MCP share domain functions; the agent cannot download or run arbitrary tools.
- All 100–200 candidates reach the model with relevant safe metadata. No hidden top-100 list or seeder cutoff. Context overflow or incomplete results are explicit, not silently truncated.
- Output: ranked **alternative acquisition options**, reasons, language/quality/coverage evidence and uncertainty—or no suitable match. Episode/movie options contain one release. Explicit season searches can return a non-overlapping plan of up to three releases; alternatives are not all downloaded.
- Top-ranked means best suitable option, not a forced choice or a numerical confidence guarantee. Language preferences are descriptive, not hard v1 gates. Favor multi-sub and popular/widely compatible releases with high seed/grab counts as soft evidence, not a guarantee or mandatory cutoff. Explicit known wrong content/language remains unsuitable; unknown metadata alone is not a rejection reason.
- HTTP uses create/status endpoints under `/api/v2/searches`; MCP exposes corresponding v2 search/status tools. Searches are asynchronous, with a visible query trail and clear terminal outcomes.

## 2. Arr automation

- Poll fresh libraries, episode inventories and complete tracked queues. Sonarr determines monitored/missing/aired episodes; Radarr determines monitored/missing/available movies. Unknown reads defer affected work rather than impersonate empty queues.
- Use Arr's own IDs/associations. Episode 3 downloading does not block episode 4. Coarse season/series queue associations conservatively suppress that current scope; unidentified downloads do not become permanent holds.
- Send individual eligible episodes or movies to search with saved preferences and relevant safe Arr context. Initially, do not combine separate episode requests into pack searches. Explicit manual season requests still support packs.
- Select rank 1 only. Before grabbing, reread applicable Arr state and check current eligibility, queue, ownership, enablement and routing. If conditions changed, do not silently choose rank 2.
- Deleted imported files can become eligible again. A queue item disappearing does not create a permanent local review. Submission, downloading and import remain distinct facts.

## 3. Submission and proposed defaults

Search never submits. Manual users confirm an option and can easily choose among enabled download clients listed by configured Prowlarr; no arbitrary URL/client input is accepted. The default route remains the Arr TV/movie route. Enabled Arr automation submits its suitable rank-1 recommendation using that default.

| Setting / outcome | Proposed default |
| --- | --- |
| Search execution | 20 model decisions, 12 search calls, 10-minute deadline |
| Concurrency | One active search worker; one automated target per poll pass |
| Arr cadence | 5 minutes |
| Submitted/uncertain queue appearance | 30-minute persisted grace, then reconsider using fresh Arr data |
| No match / needs input / matched dry-run | 6-hour target cooldown; ordinary cooldown can be cleared explicitly |
| Operational errors | 5-minute exponential backoff, capped at 60 minutes |
| Source throttling | Retry-After wins, even beyond local backoff caps |
| Failed/unconfirmed known release | Exclude for that target for 24 hours, encouraging an alternative |
| Candidate submit capability | Expires 30 minutes after search completion |
| New activity history | 30 days or 10,000 searches |

Idempotency prevents replaying the same submission key, including after restart; changed payloads with the same key conflict. Atomic target/physical-release grace also prevents immediate duplicate submissions under different keys. POST timeouts are uncertain, not blindly retried. A partial season submission reports its actual per-release outcomes and stops at failure.

**Deliberate risk:** after finite grace, a new attempt may coexist with an unmatched download. An empty Arr queue is not proof that qBittorrent is empty. We accept that risk instead of keeping indefinite reservations and manual recovery machinery. No automatic action deletes or cancels downloads.

The one-target-per-pass default favors a small first implementation over backlog throughput; at five-minute cadence it can start at most 12 automated targets/hour, and long searches can reduce that. This is an explicit proposed default, not an architectural requirement to keep throughput low forever.

## 4. Persistence

Keep request/query/recommendation/submission audit, retry deadlines, source backoff, settings and short-lived owner-checked leases. Keep a timestamped observation cache for display, never submission authority. Private locators remain local and never enter model prompts or public activity. Retain compact idempotency receipts independently of history pruning.

No old intents, decisions, reviews or dedupe are copied or read. Existing old nonempty databases fail fast with clear fresh-database-path instructions; they are never deleted or modified automatically. No parallel legacy scheduler, migration, tombstones, compatibility retirement scaffolding or active Reset/release workflow survives. New search/submission state persists normally across restarts; runtime identifiers and connection settings remain easy to configure.

## 5. UI

- **Search:** prompt, optional context/preferences, query trail, ranked options, reasons/uncertainty, configured download-client choice and explicit submit confirmation.
- **Activity:** attributable attempts and per-release outcomes with filters.
- **Automation:** current Arr-derived missing/downloading/waiting state, episode detail, source freshness, next retry, pause/enable, explicit Poll now and Search this item.
- **Settings:** connections/routing, model/search limits, preferences and automation/retry policy.

Remove Queue/Reviews/Reset/reservation-release interfaces. Keep existing visual language and require keyboard/mobile/accessibility verification, not a new visual brand.

## 6. Migration and compatibility

Configure a fresh database path. Existing nonempty legacy databases are not migrated, altered or deleted; startup refuses them clearly. Normal restarts reuse the new DB and retain new state. Rollback selects the old database path and matching binary; external downloads are not undone by changing database paths. Deployment and actual submissions remain unauthorized.

## 7. Acceptance tests and delivery

Implementation has **17 tracked tasks**, each with focused tests/docs; all remain unchecked. Critical deterministic cases include:

- Full 100/200-result visibility, last-position winner, alternate-title/seasonal/absolute refinement, no suitable choice, explicit wrong season, language preferences/requirements and hostile candidate text.
- Imported→deleted→missing; E3 downloading while E4 is eligible; future/date-only/unknown airtime; movie availability; unknown/partial queue reads; unmatched grace expiry; repeated failure without permanent reviews.
- Fresh pre-submit changes; pause/routing changes; dry-run cooldown; same/different-key duplicate races; crash/restart; partial submissions; stale ownership; history pruning and redaction.
- Fresh/restart persistence, legacy database fail-fast without mutation, removed old runtime scaffolding, standalone search without Arr, HTTP/MCP parity and synthetic desktop/mobile/keyboard UI checks.

Full verification includes backend/frontend typechecks and tests, frontend build, strict OpenSpec validation, bounded live Prowlarr/model dry-run evaluation, independent review, and available amd64/arm64 container/SQLite checks. Evaluation uses synthetic/sanitized context, max 3 requests/6 searches/10 model decisions per request with at most one repeat and aggregate maxima 6/36/60; no grabs or production writes. Credentials stay private, real release titles stay in private local files, and reports contain safe aggregates only. Unavailable checks remain explicitly blocked, never claimed passed. Scripted-model tests do not establish measured live accuracy.

Approved development proceeds through verified topic-branch commits and a PR, not a production deployment. No overnight completion or model-accuracy guarantee is implied.

## Approval scope

Approval adopts this search-first architecture, finite-grace duplicate trade-off, replacement of old tracking/reviews, revised fresh-database boundary, manual server-listed client selection and bounded live dry-run evaluation. It authorizes corresponding project guidance updates during implementation. Real grabs, production writes, deployment and publishing remain outside this approval.

Detailed references: [proposal](proposal.md), [technical design](design.md), [implementation checklist](tasks.md), [search spec](specs/release-search/spec.md), [Arr spec](specs/arr-automation/spec.md), [operations spec](specs/search-operations/spec.md).
