# Source layout

The daemon starts at `daemon.ts`, creates the runtime and SQLite store, and serves the HTTP API and built web UI. `http.ts` is an upstream HTTP client. `config.ts` handles process-level settings; integration settings are persisted through the settings store.

Install Node.js 22+ and run from the repository root:

```sh
npm ci
npm run web:install
npm test
npm run typecheck
npm --prefix web test
npm --prefix web run typecheck
npm run build
```

For a local backend + Vite development session, start these from the repository root in separate terminals. Use a disposable database for the daemon:

```sh
DB_PATH=data/development.db npx tsx src/daemon.ts
```

```sh
npm --prefix web run dev -- --host 127.0.0.1
```

Open <http://127.0.0.1:5173/>; Vite proxies `/api` and `/health` to the backend at port 7877. The explicit loopback host overrides Vite's default `0.0.0.0` binding. For a production-style local run, `npm run build` creates `web/dist`, which the daemon serves.

The default database is under `data/`. Use a disposable `DB_PATH` for experiments. The stdio MCP adapter proxies calls to the running daemon and does not open SQLite itself.

See [search boundaries and implementation pointers](search/README.md) and [MCP stdio](mcp/README.md).
