# Future features

High-level ideas being explored, not promises, committed scope, or detailed requirements:

- **UI log visibility:** make useful application logs visible in the UI.
- **Favorites-informed discovery:** use a user's favorites or other personal context to surface tailored recommendations.
- **Smarter indexer selection:** go beyond existing indexer allowlisting to choose indexers per search instead of broadcasting to all configured indexers, with optional influence from user instructions.
- **Agentic media discovery and management:** explore an agentic workflow that discovers/manages media and adds metadata tagging sufficient for Jellyfin. It is undecided whether this belongs in Media Scout or a separate service so Scout can remain search-focused.
- **Remote MCP transport:** let other agentic applications connect over an MCP transport beyond the existing stdio server; the transport and scope remain open. The general-search HTTP API is not an MCP transport.
- **UI poll timer:** show a countdown or equivalent indication of when the next monitoring poll is scheduled; the polling interval already exists, but its next-run time is not shown in the UI.
- **Manual poll button:** let users trigger a monitoring poll from the UI without waiting for the next scheduled cycle, respecting existing dry-run and safety settings.
- **Connection validation:** let users test configured integrations from the UI and verify reachability and authentication. Clearly distinguish saved/added configuration from a successfully tested connection, with useful failure messages that do not expose credentials.
