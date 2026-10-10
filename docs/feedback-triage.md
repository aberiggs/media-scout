# Feedback investigation — 2026-10-10

Source: the operator's `docs/sprocket-feedback.md`, plus the follow-up that pulling the latest server image did **not** reconcile the completed season's reviews. Inspected application revision: `32b05b37727c3a43ce15b8feb8240b7a5488a623`.

This is an investigation, not a bug-fix or live-evaluation pass. GitHub issues below are the authoritative backlog; this page is a navigation/evidence summary, not a second task tracker.

## Published issues

| Issue | Feedback grouped / confirmed source behavior |
| --- | --- |
| [#10 — Reviews still open after completion](https://github.com/aberiggs/media-scout/issues/10) | Completed season plus unusable reviews. PR #7 exists but the operator still sees the symptom after pulling latest. Cleanup is limited to unlinked, evidence-eligible `unparseable-title` rows; inspect the running revision and affected rows before attributing the remaining failure. |
| [#11 — Ongoing-season transitions](https://github.com/aberiggs/media-scout/issues/11) | New season / unaired episode concerns. Air-date eligibility and target reopening exist; verify the complete multi-poll lifecycle, residual targets, and holds with time-controlled regression cases. |
| [#12 — Retry timing and seasonal cadence](https://github.com/aberiggs/media-scout/issues/12) | Five-minute-to-twelve-hour report. Error backoff defaults to 5/60 minutes, but upstream Retry-After, ordinary cooldown, manual holds, and monitor cadence are separate. The actual production delay source is unverified. |
| [#13 — Explainable search history](https://github.com/aberiggs/media-scout/issues/13) | Missing not-found movie history. Failed Prowlarr calls are already recorded; planning failures, post-search decisions, swallowed telemetry errors, retention, filters, and deployment revision need investigation. |
| [#14 — Relevant indexer routing](https://github.com/aberiggs/media-scout/issues/14) | Indexer fan-out, latency, and noise. Automatic searches currently use the entire enabled/non-cooling allowlist, not media-aware routing. Preserve bounded broad-recall fallback. |
| [#15 — Anime numbering and naming strategy](https://github.com/aberiggs/media-scout/issues/15) | Absolute-vs-seasonal metadata and common release-name patterns combined. Both numbering forms are supported by coverage checks; “26” is not inherently wrong for S2E1. Test query recall without weakening coverage safety. |
| [#6 — Existing LLM benchmarks](https://github.com/aberiggs/media-scout/issues/6#issuecomment-6103167887) | Added scope for frozen sanitized cases, stage-specific metrics, hosted/local comparison, and an opt-in bounded real-model runner. Scripted offline tests do not establish actual model quality. No duplicate benchmark issue created. |

Each issue contains code locations, known behavior versus hypotheses, missing evidence, scope boundaries, and acceptance criteria. Related query-naming bullets are combined; retry policy, indexer routing, and lifecycle changes stay independently testable.

## Suggested sequence and evidence

1. Start with #10: the user reports it is still failing on the latest-image pull. Confirm the **running** container revision/digest, affected review reasons and evidence kinds, associated work status/identity, and positive library observations. A pulled tag alone does not establish the running revision, but deployment mismatch is not assumed to be the cause. Preserve the records; no blanket cleanup or DB reset.
2. Replay the airing-season sequence in #11 and identify the observed delay source in #12. Record only sanitized IDs, monitoring/file/air-date fields, work/review timestamps, queue coverage, and intent statuses. Do not publish raw databases, saved settings, release URLs, hashes, or secrets.
3. Improve attempt visibility in #13 so later search-policy work can be evaluated. Establish a small frozen real-model baseline under #6, then judge #15 query recall and #14 routing improvements against the same cases.

The running server, database, and upstream services were not accessed. Exact production root causes remain unproven; the existing fix and passing offline tests are not proof that the user's symptom is resolved.

## Setup and verification

- Added root `AGENTS.md`, [Ubuntu development guidance](development.md), and a root OpenSpec setup for future approved feature work. No legacy project-local OpenCode config/skills were present to migrate; global skills are reused without provider/model overrides.
- Installed locked backend/frontend dependencies locally. Backend typecheck and **650 tests across 42 files** passed; frontend typecheck and **36 tests** passed; production frontend build passed. Commands and dependency-audit caveats are recorded in [the baseline](development.md#verified-local-baseline--2026-10-10).
- Independent read-only review checked draft issue coverage, source claims, and setup safety. Corrected its listener-command finding to use direct frontend npm argument forwarding.
- No application source, dependency versions/lockfiles, production data, runtime settings, or the original feedback note were changed. No live model/indexer runs, grabs, deployments, or pushes were performed.
