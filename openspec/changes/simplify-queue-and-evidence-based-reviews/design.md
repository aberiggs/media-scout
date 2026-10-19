# Design

## Context

See proposal.md for evidence and scope. `Watcher` already uses Radarr `isAvailable`; preserve its policy rather than guessing release dates. Official Radarr docs confirm that this flag incorporates its configured minimum-availability threshold. The problem includes durable review state outliving its cause, broad ambiguity becoming sticky work holds, movie empty-search manual outcomes and optimistic recovery projections.

## Goals / Non-Goals

**Goals:** root-cause regression coverage, causal review persistence, conservative queue reconciliation, straightforward reset and quieter operations UX.

**Non-Goals:** no new model-based judgment, no direct download-client management, no wholesale scheduler rewrite or competing history ledger. Keep the existing visual language and low-level history API compatibility where possible.

## Decisions

### Preserve metadata eligibility; unify only ordinary search outcomes

Movies remain ineligible while `isAvailable` is false, with no availability retry deadline. TV remains per-episode timing-gated. Change the released-movie no-admitted-candidate branch in Runner to persisted `release-unavailable` cooldown. Extend conservative legacy availability conversion to movies only with current known/fresh observations and no other blocking cause. Unlike blindly clearing every no-release review, this preserves concurrent queue/identity risk and operational throttling.

### Capture queue causes at reconciliation boundaries

Add optional versioned private queue-review evidence to the review row: bounded cause vocabulary, content identity, exact affected episode IDs (or movie scope), observation time. Emit evidence only for the actual queue condition, not a sticky prior hold. Persist once per unresolved incident under the work claim. Legacy rows remain evidence-unknown. Allowlisted summaries distinguish vanished download, uncertain job, identity change and old unknown-cause review without leaking raw messages/URLs/queue identifiers.

Positive import cleanup reads the actual library snapshot and captured evidence; it must prove every captured target has a file under the same provider identity with fresh non-regressing observations. For ambiguous broad scope, do not invent an exact episode from surviving coverage. Preserve linked unresolved-intent history unless its own captured coverage is fulfilled. Clearing a warning is not the same as releasing its independent reservation.

### Keep holds independent of review visibility

The current `reviewWasResolved` branch can discard vanished coverage when its review disappears. Remove that inference: only current projected imported coverage, active captured reservations or explicit guarded release can discharge a missing-download hold. Repeated observations do not duplicate open causes. Unknown/partial reads remain held and never prove imports. Status precedence must show safety attention separately from ordinary movie/episode waiting; no work-wide manual copy should claim a movie is a season.

Broad unidentified queue rows keep a transient safety hold for unreleased-only work but do not create a durable human task until eligible/captured work is at risk. Direct exact-episode queue rows whose targets are positively imported no longer hold future siblings. Neither rule treats a missing episode ID or unknown inventory as completion.

### Reset reuses the work action endpoint, not a new recovery ceremony

Extend existing `reset` semantics to clear unlinked review clutter even when ordinary Retry cannot apply. Keep operator-action opt-in, same-origin protection, cycle exclusion and atomic work/same-series claims. Preserve linked reviews and every intent/queue/dedupe/receipt/association record. Clear scheduling/attempt clocks and obsolete unlinked manual reasons, set reset-pending, hide until a later known observation. Do not clear active rate-limit deadlines; reject while throttled. Never discard coverage merely because review rows resolved. The next poll recalculates current holds and can legitimately restore a precise review if a real problem remains. Use one ordinary confirmation dialog, not token/challenge/client-inspection ceremony, because no reservation is being released.

### Group review projections before paging

Retain the existing review endpoint's row mode for compatibility and add opt-in grouped results for the UI, with one item per work key and a list of underlying causes/IDs. Group and query before pagination, count groups for the grouped response and UI review badge. Keep low-level raw review history available. Action eligibility for Reset comes from work state even when a particular reason disallows Retry. Associate means assessment of fresh queue evidence, not an optimistic promise; present it only under advanced details as a check. Actual release still requires a linked eligible intent.

### Progressive disclosure instead of a theme rewrite

Queue requests active scope only and offers nonterminal filters. Card summary: icon/title/season, primary status, concise cause, next retry/airtime when known, last checked. No normal-state Current observations badge. Put coverage/freshness/episode inventory in details. Reviews show all causes once per work item, Reset item and eligible Retry later actions, with guarded niche tools under Advanced recovery. Saved view refresh is labeled Refresh with a short saved-status explanation; neither refresh nor retry implies immediate search.

## Risks / Trade-offs

- [Lost historical causality] → legacy reviews do not auto-resolve on guessed targets; Reset explicitly rebuilds local tracking while independent protections survive.
- [Reset appears to fix a real download problem] → confirmation and result explain protected downloads may still need attention; reconciliation restores actual holds.
- [State migration and stale writers] → additive nullable evidence column, migration/reopen tests, no mixed-version writers; backup and matching-binary rollback guidance.
- [Grouped API compatibility] → opt-in grouping, retained underlying IDs, server-side pagination and tests for raw/grouped modes.
- [Safety obscures availability] → display both facts without claiming waiting alone demands review.

## Migration Plan

Ship additive evidence storage; do not rewrite production history during upgrade. Existing known-safe availability conversion runs on normal reconciliation, scoped imported review cleanup uses positive evidence, and operator reset handles evidence-poor legacy clutter. Document stopping writers and consistent backup before upgrading. Rollback requires the matching previous binary and pre-upgrade backup; no deployment is part of this task.
