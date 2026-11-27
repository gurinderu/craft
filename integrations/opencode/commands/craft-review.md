---
description: craft's review of the current change — the craft binary runs it, each task a child session of this session on craft's read-only agents, the answer is its Verdict block.
---

Run craft's review by invoking the `review` tool.

If the user passed arguments, call the tool with `args` set to them exactly as written (the review's
flags, such as `--base main`, `--depth light`, `--pr 123`, `--run <dir>` to resume a run, or
`--models <provider/model>`; a re-review of fix commits is `--base <the commit the review was made on>
--fresh --delta --full-every 0 --depth light --extra-lenses off`, whose clean verdict reads Warning, never Approve; `--delta` needs a base
after the merge-base: with the merge-base or an older commit — or no `--base` and no earlier round of the
branch — the binary refuses it before anything runs, since that round would review the whole branch):

`$ARGUMENTS`

Otherwise call `review` with no arguments. If the tool says the profile is missing, ask the user whether to
set it up or continue without it. On setup, load `review-init` and run its steps against the repository
path named by the tool, not the session's current directory; complete it with the user, then call `review`
again with the original arguments. On continuing without setup, call `review` with `--without-profile`
and the original arguments. Never select for the user. If the profile check fails, report the error.
Return the tool's answer verbatim — its `## Verdict` block, or
what stopped the run and how to resume it. Do not edit any code yourself: the review reports, it does not fix.
Never submit a GitHub review verdict (`gh pr review --approve` or `--request-changes`), approve or
merge: the verdict goes to the user only, and findings reach the PR only through `--comment` when the user asked for it.

With `--pr` from a checkout that lacks the PR's head, craft prepares its own worktree of it. The tool's
child sessions stay in the caller's OpenCode directory and are instructed to read that worktree by
absolute path. The terminal path (`craft review run --backend opencode` without `--delegate`) starts
OpenCode in the worktree, loading the PR's own plugins, MCP servers and agents even with `--no-gate`.
For a PR the user does not trust, suggest another host with `--no-gate`; task prompts do not enforce
filesystem isolation.
