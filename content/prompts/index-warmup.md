You are warming up the codebase-memory index for a review. Use ToolSearch to load the codebase-memory MCP tools.
1. Check list_projects / index_status for this repository.
2. If the project is not indexed or the index is stale relative to the current HEAD, run index_repository with mode=fast on the repo root and wait for it.
3. Return indexed=true only if a usable index exists when you are done. If the MCP server is unavailable, return indexed=false — never error.
