# Release-set execution and confirmation — #56 / #58

> Historical delivery plan. The parity follow-up requires a fresh database and
> removes old plan and receipt compatibility. Current release-set receipts still
> protect against duplicate sends and survive restart.

Base: PR #61 at e94b11c; branch feat/56-58-release-set-execution.
Draft PR targets feat/52-55-agent-release-set, not main.

## Approved revised boundary

Search is independent of Arr automation. New agent plans select observed
candidates and describe best-effort semantic coverage, gaps, overlap/extras and
meaningful uncertainty. No mandatory release-to-episode/Arr-ID assignment in
instructions or validation. Keep candidate handles, owning-search membership,
physical identity and explicit conflicting identity checks. Reasonable extra
content is preferable to unnecessary under-selection. Empty uncertainty is valid.
Old plans, Arr bindings and legacy receipts remain readable, not reinterpreted.

Manual search never downloads automatically. Optional search-time client choice
is retained for whole-set confirmation. Confirmation commits the stored plan
identity/version, explicit client/category configuration and saved dry-run state.
Backend bindings, not client URLs/model mutations, determine actual releases.

Execution does not consult Arr need or reserve episodes. Those requirements from
the original draft #56 are superseded by the owner's revised layer boundary.
#57 owns missing-item observations, acquisition cooldown and automation; it remains
disabled here. No quality-upgrade logic or automation recovery is implemented.

## Execution contract

- Explicit preparation/confirmation binds current client and safety configuration.
  Changed source/client/relevant settings require a fresh confirmation.
- Reject expired private candidates; public historical evidence grants no execution
  authority. No silent candidate substitution or automatic research on history reads.
- Persist immutable release/source/physical bindings and per-child outcomes.
- Atomically reserve distinct physical identities and parent ownership to prevent
  concurrent duplicate sends. Renew ownership; fail closed on lease loss.
- Sequential children: durable sending before POST; durable outcome before next POST.
  Definite rejection or uncertainty stops the unsent tail as not-attempted.
- No rollback, alternatives, automatic retry/resume or uncertain-send replay.
  Parent idempotency replay returns its durable receipt, not another download.
- Restarted sending is uncertain; unsent children are not-attempted. Physical holds
  are bounded, never indefinite quarantine. Preserve legacy recovery policy/data.
- Dry-run makes zero grabs. Submitted means accepted submission, not import/download.
- Diagnostics/receipts are bounded and sanitized; locators and secrets stay private.

## Delivery

1. Backend revised agent contract, durable journal and confirmation/execution API,
   regression tests through controlled real HTTP mutation boundary.
2. Designer-led whole-plan confirmation/history UI; preserve drafts/navigation,
   duplicate-click protection, filters/pagination and legacy inspection.
3. Render desktop/mobile populated, partial, uncertain, stale/error and legacy
   states; keyboard/focus and console checks; actual served LAN settings/actions
   against isolated test data and controlled fake mutation services.
4. Independent full-diff review, affected checks after fixes, commit/push and draft
   stacked PR. No native stack registration claim, merges, deployment or images.

## Acceptance evidence required

Useful overlapping packs without episode mapping; explicit client routing/body;
first success then rejection; accepted-but-timeout; restart in sending; lease loss;
concurrent submissions; same-key replay/conflict; zero-grab dry-run; expired
candidates; source/client/safety changes; durable receipt authority over events;
history reads without research; legacy overflow containment. Full backend/frontend
tests, typechecks/build, rendered Designer critique and independent review.

Live OpenRouter/Prowlarr research calls are authorized. Real grabs/downloads are
not. Preserve user-managed media-scout-pr61-preview.service, its database and
saved settings; use isolated verification instances rather than changing it.

## Delivery evidence

- New semantic v2 tool/schema has no release-to-target assignment field. Stored v1
  plans and legacy receipts remain inspection-only.
- Preparation snapshots source, candidates, explicit client/default/category maps
  and committed dry-run. Each send revalidates and journals its outcome. Durable
  replay, finite physical holds, restart recovery and private-binding stripping
  are covered through controlled HTTP and file-backed store tests.
- Live saved-model/Prowlarr read-only trials: Arrival, partial Avatar S1–S4 and
  Re:Zero season 2; real client discovery/preparation, no execution commits/grabs.
  Live discovery exposed omitted client-field values; the parser regression now
  accepts them while retaining only the allowlisted category field.
- Chromium desktop/mobile flows through LAN origin cover settings PUTs,
  preparation/confirmation, dry-run (zero POSTs), changed-settings rejection,
  accepted prefix/rejection, accepted timeout/unsent tail, double-click protection,
  lost response/reload/same-key recovery without extra POSTs, expired candidates,
  history/filter reopening, focus/Tab/Escape and long legacy JSON containment.
  Only deliberate conflict/network-failure console entries occurred; no page
  errors or unexpected console errors.
- Independent backend review has no blocking findings. Integrated review and
  final publication status are recorded in the draft PR rather than implied here.

Not claimed: real downloads/imports, actual qBittorrent category delivery, #57
automation/cooldown behavior, #54 external research configuration, #59 final
cross-stack/container/ARM64 acceptance, production deployment or native GitHub
stack registration.
