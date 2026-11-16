# MCP stdio

`server.ts` is the MCP process entry point; MCP tools are registered in `src/search/mcp.ts`. From the repository root, start it with:

```sh
npx tsx src/mcp/server.ts
```

An MCP host must launch the process and manage its stdio. The server has no user authentication; approve side-effecting submission and automation-poll tools only for trusted users.

The host's working directory and environment determine configuration, including `DB_PATH`. Use a disposable database for development, or configure the same database path as the daemon when sharing its state.
