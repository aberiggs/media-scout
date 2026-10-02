# Future features

High-level ideas being explored, not promises, committed scope, or detailed requirements:

- **UI log visibility:** make useful application logs visible in the UI.
- **Request queue and tracking:** show requests in a UI table, support manual review, and track their progress/outcomes.
- **General and personal discovery:** support queries unrelated to Sonarr/Radarr and let the LLM surface multiple results, including recommendations informed by a user's favorites.
- **Smarter indexer selection:** choose which indexers to search instead of broadcasting every search to all of them, with optional influence from user instructions.
- **Agentic media discovery and management:** explore an agentic workflow that discovers/manages media and adds metadata tagging sufficient for Jellyfin. It is undecided whether this belongs in Media Scout or a separate service so Scout can remain search-focused.
- **MCP search endpoint:** let other agentic applications invoke general-purpose smart searches. Build on the existing stdio MCP tools; the endpoint's transport and scope are still open.
