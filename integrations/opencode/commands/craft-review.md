---
description: craft's review of the current change — the craft binary runs it, each task its own `opencode run` on craft's read-only agents, the answer is its Verdict block.
---

Run craft's review by invoking the `review` tool.

If the user passed arguments, call the tool with `args` set to them exactly as written (the review's
flags, such as `--base main`, `--depth light`, `--pr 123`, `--run <dir>` to resume a run, or
`--models <provider/model>`):

`$ARGUMENTS`

Otherwise call `review` with no arguments. Return the tool's answer verbatim — its `## Verdict` block, or
what stopped the run and how to resume it. Do not edit any code yourself: the review reports, it does not fix.

With `--pr` from a checkout that lacks the PR's head, the review runs in craft's own worktree of it,
where OpenCode loads the PR's own project config (plugins, MCP servers, agents): the PR's code runs
even with `--no-gate`, so for a PR the user does not trust, say so and suggest another host instead.
