You are warming up the codebase-memory index for a review. Use ToolSearch to load the codebase-memory MCP tools.
1. Call index_status for the project `{{project}}` — the one project the review keeps for this repository, whichever checkout it reads.
2. If it does not exist, its root_path is not the repo root above, or it is stale relative to the current HEAD, run index_repository with repo_path set to the repo root, name `{{project}}` and mode=full (fast and moderate leave out every directory named bin, docs or scripts), and wait for it. Never index under another name.
3. Return indexed=true only if `{{project}}` is a usable index of the repo root when you are done. If the MCP server is unavailable, return indexed=false — never error.
