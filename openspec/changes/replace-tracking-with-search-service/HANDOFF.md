# Fresh-agent handoff

> Historical handoff from `17a1943`, superseded by the branch reconciliation in
> `progress.md`. Current checklist: 17/17 complete, not 7/17. Operator docs,
> focused coverage, filters/history and main-conflict resolution are now
> checkpointed; consult the progress record and current PR checks before acting
> on the historical remaining-work list below. CI acceptance is now recorded;
> do not rerun the exhausted live evaluation or infer production rollout approval.

## Authorization and intent

The user approved implementation of this change, including the latest refinements in `review.md`, then requested a verified commit and a fresh-agent handoff to reduce context/token cost. Continue autonomously after they send this handoff to you. Do not start another proposal or redesign. Favor the beautifully simple ideal: neutral read-only LLM search; separate explicit Prowlarr download-client-selected submission; thin Arr automation using upstream truth; audit/retries/finite grace, not a second media manager. No legacy migration/compatibility work: the user is happy to start with a fresh DB.

Repository branch: `jammy-walrus`. Remote: `origin` (aberiggs/media-scout). Draft PR: https://github.com/aberiggs/media-scout/pull/26. Owning issue #24; selection cases #15. Normal verified topic-branch commits/pushes are approved. No merge, deployment, image publishing, production writes or real download submissions.

## What is implemented

- `src/search/{contracts,store,service,selection,submission,arr,automation}.ts`: full-result bounded multi-turn search, practical soft language/popularity guidance, opaque references, safe candidate metadata, explicit client routing, durable idempotency, target/physical leases and finite appearance grace, Arr observations and episode-first retries.
- `src/search/{runtime,settings,mcp}.ts` and rewritten composition/HTTP/MCP entry points: v2 settings, shared async runtime, current-config validation, neutral manual search plus server-bound Arr-item search, Activity and Automation projections.
- Old runner/state/review/queue-association engine and engine-only tests removed. Retained transport/client/parser/airtime tests and replacement regression/lifecycle/API tests. This intentional removal explains the lower total test count; do not restore the legacy engine to raise it.
- Search/Activity/Automation/Settings UI replaced. Parent tests fixed saved-detail navigation, numeric client IDs, stable confirmation keys after failure, and allowing read-only Arr-item search during dry-run.
- Runtime review fixes: abandoned-search ownership recovery; real private-material/history cleanup; finite settings bounds; explicit `expired` submission response; dry-run/per-release audit events; coherent source snapshots. Last regression fixed durable receipt fallback in Activity when a crash prevents an event, including older-event/newer-receipt ordering.

## Verified at this handoff

Parent ran all of these successfully immediately before checkpoint:

```sh
npm run typecheck
npm test                            # 27 files, 354 tests
npm --prefix web run typecheck
npm --prefix web test                # 4 tests, centralized App.test.tsx
npm run build
git diff --check
openspec validate replace-tracking-with-search-service --strict
```

OpenSpec remains **7/17 checked**. More code is implemented than the checked task count: remaining tasks deliberately stay open until their documentation/rendered/container/final-review criteria are actually satisfied. Use CLI-returned task paths; do not mark tests unrun or docs unfinished as complete.

## Remaining work (do this, not another broad rewrite)

1. Finish operator documentation and current architecture guidance. `AGENTS.md` has the approved safety-policy amendment but its architecture bullets still name deleted modules. `docs/operations.md`, `operator-recovery.md`, `operations-dashboard.md`, README and other setup references still contain legacy descriptions. Replace them with delivered v2 behavior; `.env.example` still uses the old DB path. Preserve historical OpenSpec artifacts unchanged. The user explicitly declined migration/legacy compatibility effort.
2. Finish rendered desktop/mobile/keyboard/accessibility review. `scripts/preview-search.ts` is a loopback-only synthetic fixture; start with shell **background=true, timeout=0**. Last preview was terminated by its 120-second tool timeout, not an app defect; no preview is expected to remain running. A desktop synthetic Search screenshot exists under `.openchamber/screenshots/` (untracked, deliberately not committed). Verify modal focus/escape/restoration, client choice, Activity navigation, Settings save, Automation grouping and narrow-screen overflow. `web/index.html` still says “Settings · Media Scout”; correct document title. Check expired-result guidance and loading/error states. A browser snapshot flagged the textarea accessible name; the DOM uses an associated label, so confirm before assuming a defect.
3. Complete remaining assigned scenario coverage honestly. Replacement tests live in `web/src/App.test.tsx`, not the proposed `Search.test.tsx`; reconcile that task check command to the actual equivalent suite without dropping scenarios. Add explicit runtime HTTP/MCP concurrency coverage if absent. Existing domain lifecycle tests use persisted SQLite and synthetic services, not production.
4. Run local amd64/arm64 container builds and isolated SQLite smoke checks, or record exact environmental blockers. Docker and buildx are available; no matrix build was started yet. Dockerfile explicitly binds inside containers to `0.0.0.0`, while local bootstrap defaults loopback and a fresh `data/media-scout-search.db`. Do not publish images or install privileged host emulation casually. PR CI also runs both architectures; inspect actual remote results after pushing.
5. Final bounded independent review of the cutover/UI, fix real findings, rerun affected/full checks, update progress/task evidence, push verified checkpoints, update PR #26 and check CI. Keep the PR draft until the remaining acceptance work is actually ready. Do not merge or deploy.

## Live evaluation: COMPLETE, budget exhausted

The user explicitly authorized read-only credential retrieval and bounded practical live Prowlarr/model dry-runs. Those have already been run: **6 requests, 21 model decisions, 14 searches, zero grabs**. Four matched; two exposed an overrestrictive parser/validator interaction. It was fixed with synthetic red/green tests; captured final output then validated offline. Do not claim another successful live run or verified torrent contents. No further live requests without new authorization: the one tuning repeat and aggregate budget are exhausted.

Private credentials and raw release evidence are outside the repo under `/tmp/opencode/media-scout-live/` with restricted permissions. Never print/commit them or send raw exports to reviewers. Reports contain only safe aggregates. Remote discovery used `root@zimablade` (same host as configured SSH alias `zima`); the actual deployment path is `/media/IronWolf1/compose/media-scout/data/media-agent.db` (lowercase compose), table `app_settings.document_json`. Only saved connection settings were queried read-only. Do not re-fetch just to rediscover them; no production cycles or writes are allowed.

## Review history and bounded follow-through

Independent reviews were performed for storage, search, submission/Arr policy and runtime cutover. Findings were reproduced and fixed; after the runtime follow-up, the parent fixed the last receipt-without-event regression directly and reran all checks. Do not restart those old review loops or launch retry cascades. A final scoped review should evaluate the current remaining cutover/UI work, not demand the abandoned permanent-hold design back.

Latest published checkpoints before this handoff: `e7adbba` (foundation), `08305f0` (domain/search/Arr). The current handoff checkpoint adds the runtime/UI cutover and verified follow-up fixes. No worktree creation, force push, merge, deployment or production download occurred.
