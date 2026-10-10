# Media Scout: project guidance

## Scope and workflow

- Read the linked GitHub issue and relevant operator docs before changing behavior. GitHub issues are the backlog; `docs/future-features.md` is exploratory, not approved scope.
- Investigation/proposal requests do not authorize app fixes. Separate source-confirmed behavior from hypotheses requiring runtime evidence.
- Use `openspec/` for scoped feature proposals and approved implementation tasks, linked to their GitHub issue. Do not copy the whole backlog into active changes. Proposal creation is planning-only; wait for an apply request before implementation.
- Keep small bug fixes lightweight: reproduce with a focused regression test, fix the root cause, then run the applicable broader checks.
- Preserve unrelated changes and stage explicit paths. Before making any commit, check the current branch and switch to a dedicated topic branch if it is `main`; never commit directly to `main` or push directly to `main`.
- For approved implementation/setup work, automatically commit and push each coherent, reviewed, verified relevant checkpoint to its topic branch. Open or update a pull request targeting `main`; all changes enter `main` through PRs. Do not automatically merge PRs, publish images, deploy, or create worktrees. An explicit request not to commit/push overrides checkpoint automation; investigation/proposal-only requests still do not authorize app implementation.
- Keep unrelated/user changes, secrets, runtime data, and failing/unverified work out of checkpoints. If checks, authentication, or branch protection block publication, report the exact blocker and leave the work intact.

## Architecture

- TypeScript ESM backend; `src/compose.ts` wires clients and core services with dependency-injection seams.
- `src/core/watcher.ts` observes Sonarr/Radarr; `runner.ts` coordinates reconciliation, planning, searches, picking, and submission.
- SQLite persistence/migrations live in `src/core/state.ts`; work eligibility and dashboard projections live in `work-queue.ts` and `operations.ts`.
- `planner.ts`, `picker.ts`, and `queue-association.ts` own the LLM steps. `src/clients/` owns upstream API access.
- `src/daemon.ts` exposes the HTTP API/scheduler; `src/mcp/server.ts` and `src/operator-cli.ts` share core behavior. The React/Vite UI is in `web/`.
- Preserve owner-checked claims, submission reservations, queue association safety, unknown-vs-empty observation semantics, and conservative recovery checks. A search result or download submission is not proof of import.
- Keep existing `media-agent` runtime identifiers unless a task explicitly includes compatibility migration.

## Setup and checks

Use Node.js 22+ (CI uses 22), npm, and committed lockfiles. See `docs/development.md` for Ubuntu setup and the baseline.

```sh
npm ci
npm run web:install
npm run typecheck
npm test
npm --prefix web run typecheck
npm --prefix web test
npm run build
```

Run focused backend tests with `npm test -- tests/<file>.test.ts`. CI also builds amd64/arm64 containers and smoke-tests the SQLite native addon for non-documentation changes; do not claim those checks passed from a frontend build alone.

For OpenSpec work, record actual check commands/results and blockers in the active change's `progress.md`. Task completion requires behavior and assigned checks, not just artifact validation.

## Safety

- Read `docs/operations.md` and `docs/operator-recovery.md` before runtime/integration work. Default to an isolated database, monitoring disabled, and dry-run enabled.
- Dry-run can still call LLMs and indexers. Ordinary tests must stay offline/deterministic; live evaluation must be explicit, bounded, and unable to grab downloads or change production state.
- Never commit or publish `.env`, API keys, SQLite databases/backups/WAL files, private release URLs, hashes, or raw production exports. Redact issue evidence and evaluation fixtures; obtain permission before sending private data to a model provider.
- Do not start the daemon against production data, trigger cycles, change upstream services, or run dependency auto-fixes as part of a routine verification pass.
- State storage can contain credentials, and the settings API exposes saved keys. Keep development listeners on trusted/local interfaces; do not expose the app publicly.
