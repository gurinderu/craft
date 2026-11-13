---
description: craft's review of the current change — the craft binary runs it, each task its own `opencode run` on craft's read-only agents, the answer is its Verdict block.
---

Run craft's review by invoking the `review` tool.

If the user passed arguments, call the tool with `args` set to them exactly as written (the review's
flags, such as `--base main`, `--depth light`, `--pr 123`, `--run <dir>` to resume a run, or
`--models <provider/model>`; a re-review of fix commits is `--base <the commit the review was made on>
--fresh --delta --full-every 0`, whose clean verdict reads Warning, never Approve):

`$ARGUMENTS`

Otherwise call `review` with no arguments. Return the tool's answer verbatim — its `## Verdict` block, or
what stopped the run and how to resume it. Do not edit any code yourself: the review reports, it does not fix.
Never submit a GitHub review verdict (`gh pr review --approve` or `--request-changes`), approve or
merge: the verdict goes to the user only, and findings reach the PR only through `--comment` when the user asked for it.

With `--pr` from a checkout that lacks the PR's head, the review runs in craft's own worktree of it,
where OpenCode loads the PR's own project config (plugins, MCP servers, agents): the PR's code runs
even with `--no-gate`, so for a PR the user does not trust, say so and suggest another host instead.
