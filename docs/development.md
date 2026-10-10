# Development on Ubuntu

## Bootstrap

Use Node.js 22+ and npm; CI runs Node 22. Install dependencies separately for the backend and frontend using their lockfiles:

```sh
npm ci
npm run web:install
```

Do not copy `node_modules` from macOS: `better-sqlite3` and esbuild have platform-specific artifacts. If SQLite installation needs a source build, install Python 3 and the Ubuntu `build-essential` toolchain, then retry the locked install. Review npm install-script warnings deliberately; do not blindly enable all scripts or change dependency versions to get an install through.

Run the same software checks as CI:

```sh
npm run typecheck
npm test
npm --prefix web run typecheck
npm --prefix web test
npm run build
```

For a focused backend suite: `npm test -- tests/runner.test.ts`. No API keys or running *arr services are needed for the ordinary tests. Container build/SQLite smoke checks are additional CI checks, not covered by these commands.

See [setup](setup.md#local-web-development) for running the backend and Vite. Use a disposable development database; never copy production settings into a committed fixture. Monitoring starts disabled and dry-run starts enabled, but dry-run searches still consume API calls. Vite's development command binds to all interfaces, so use it only on a trusted network or pass `--host 127.0.0.1` via `npm --prefix web run dev -- --host 127.0.0.1`.

## Agent and planning setup

`AGENTS.md` provides repository-specific architecture, checks, and safety rules for OpenCode V2. There were no project-local `.opencode` skills/configuration in this checkout to migrate. Existing global engineering/OpenSpec skills are reused rather than copied or replaced; no project provider credentials, model overrides, or plugins are required.

GitHub issues remain the backlog. OpenSpec is initialized at this repository's root for future scoped proposals and approved implementation tasks. Link each change to its issue; do not treat an issue or a proposal as authorization to implement. Small fixes need not create an OpenSpec change. Inspect setup with:

```sh
openspec list --json
openspec context --json
```

Use the installed `openspec-propose` workflow for proposals and `openspec-apply-change` only after implementation approval. Record software verification in an active change's `progress.md`; OpenSpec validation alone does not test the app.

## Verified local baseline — 2026-10-10

Checkout: `32b05b37727c3a43ce15b8feb8240b7a5488a623`, Ubuntu/Linux, Node `v24.21.0`, npm `11.19.0`.

| Command | Outcome |
| --- | --- |
| `npm ci` | Passed; 221 packages installed |
| `npm run web:install` | Passed; 210 packages installed |
| `npm run typecheck` | Passed |
| `npm test` | Passed: 42 files, 650 tests |
| `npm --prefix web run typecheck` | Passed |
| `npm --prefix web test` | Passed: 36 tests |
| `npm run build` | Passed; production frontend bundle built |
| `openspec list --json` / `openspec context --json` | Resolved this repository root; no active changes |
| `timeout --signal=TERM 3s npm --prefix web run dev -- --host 127.0.0.1` | Vite confirmed loopback binding on port 5174 (5173 was occupied); temporary process stopped by expected timeout |
| `git diff --check` | Passed |

Both installs reported install-script approval warnings, but the subsequent test/build checks passed, including SQLite-backed tests. npm audit reported **4 backend** advisories (1 moderate, 1 high, 2 critical) and **7 frontend** advisories (2 moderate, 5 high). These are dependency audit findings, not evidence of production exploitability; they were not changed in this investigation. Suggested fixes include major Vitest/Tailwind upgrades and need a separately scoped dependency review, not `npm audit fix --force`.

No daemon, live API evaluations, production database reads, Docker image builds, deployment, or push were performed. Production feedback remains to be reproduced with sanitized evidence.
