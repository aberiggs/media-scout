# MCP stdio

`server.ts` is the MCP stdio entry point; MCP tools are registered in `src/search/mcp.ts` and proxy to the already-running daemon over its HTTP API. From the repository root, start it with:

```sh
npx tsx src/mcp/server.ts
```

An MCP host must launch the process and manage its stdio. Configure `HTTP_HOST` and `HTTP_PORT` to the daemon's listener; wildcard binds (`0.0.0.0` or `::`) are contacted through loopback. The stdio process owns no database, runtime, or listener. It exposes the same status/history/search and read-only Arr operations as the HTTP domain, including queueing searches on the daemon. If the daemon is unavailable, calls fail safely with `daemon-mcp-unavailable`. Submission remains disabled while release execution is deferred; no acquisition action is exposed.

`HTTP_HOST` and `HTTP_PORT` select the daemon origin; `DB_PATH` is not opened or modified by the stdio process.
