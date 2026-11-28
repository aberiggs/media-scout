# Develop Media Scout

## Run locally and preview

From the repository root with Node.js 22+, install dependencies once:

```sh
npm ci
npm run web:install
```

Choose one startup path below. Don't run two daemons against the same database.

**Built UI and API on one port:**

```sh
npm run build && HTTP_HOST=127.0.0.1 HTTP_PORT=4787 \
  DB_PATH=data/development.db node --import tsx src/daemon.ts
```

Open <http://127.0.0.1:4787/>. The daemon serves `web/dist`. Use an unused
port and a disposable `DB_PATH`; relative paths are resolved from the working
directory. Without `DB_PATH`, the daemon opens `data/media-scout-search.db`.

**Vite development loop:** Start the daemon and Vite in separate terminals:

```sh
HTTP_HOST=127.0.0.1 HTTP_PORT=7877 DB_PATH=data/development.db node --import tsx src/daemon.ts
```

```sh
npm --prefix web run dev -- --host 127.0.0.1
```

Open <http://127.0.0.1:5173/>. Vite proxies `/api` and `/health` to
`127.0.0.1:7877`; keep that backend port for this workflow. The explicit
frontend host overrides Vite's default LAN binding.

### Live trial with the user's setup

For a UI-only check, use a disposable DB or a synthetic fixture. For a live
trial of the user's setup, use a **full SQLite snapshot** of the active
production database, including settings and history. Use SQLite's online backup
API against a read-only source; don't copy a database file while it is being
written. Keep the snapshot in a private directory outside Git. Never point the
preview at the active production file.

For a **manual search only** trial, don't use the daemon commands above on the
snapshot as-is: the normal daemon can schedule automation and resume queued
work. Run `buildApp` without `startDaemon`'s scheduler, interrupt copied pending
jobs on the snapshot before starting the runtime, and block acquisition and
download execution. Preserve the saved integration and dry-run settings. Only
expose the preview through a secured LAN entry point that protects credentials
and private history and blocks unauthorized actions. The regular Scout HTTP
API has no authentication; changing `HTTP_HOST` alone is not sufficient.

Hand off the direct LAN URL, revision, and snapshot identity. Check the served
origin, Search readiness, and existing Activity without dumping settings or
credentials. If the user will run the sample, leave the paid model/indexer
request for them and say which live behavior remains unverified.

## Checks and source layout

Choose checks that cover the change. CI runs the full backend and frontend
suites; reuse relevant passing checks for the exact PR head.

```sh
npm test
npm run typecheck
npm --prefix web test
npm --prefix web run typecheck
```

`daemon.ts` starts the runtime and SQLite store and serves the HTTP API and
built UI. `config.ts` handles process-level settings; integration settings are
stored in SQLite. `http.ts` is the upstream HTTP client. The stdio MCP adapter
proxies calls to the running daemon and does not open SQLite itself.

See [search boundaries and implementation pointers](search/README.md) and [MCP stdio](mcp/README.md).
