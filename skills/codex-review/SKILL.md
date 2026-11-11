---
name: codex-review
description: >-
  Codex only: craft's review of a diff or PR in any language, run from a Codex session — one command that drives the craft CLI's review (the mechanical gate, review lenses per profile, verification, one report and an Approve/Warning/Block verdict), each review agent its own `codex exec` process. Use in Codex when asked to review a branch, a diff or a PR before commit or merge, to re-review fix commits, or to resume a stopped review. Triggers: review this branch, review the diff, is this mergeable, re-review the fixes, resume the review. Not in Claude Code: there the review is the craft:review workflow (Workflow tool), never this skill.
---

# codex-review — craft's review from Codex

**In Claude Code, stop here**: launch the `craft:review` workflow with the Workflow tool instead;
this skill is the Codex route to the same review.

In Codex, the review is one command. Its plugin root is two directories above this file's
directory (this file is `<plugin root>/skills/codex-review/SKILL.md`):

```sh
node "<plugin root>/lib/codex-review.mjs" [key=value ...]
```

Run it **once, in this session**, never in a subagent, and relay what it prints on stdout — the
`## Verdict` block, the report's path and the `## Findings` list — then read the report file it
names for the details. Do not review the diff yourself beside it.

This route is new and not yet observed running in a real Codex session. If the command cannot
run here, or fails without a `## Verdict` block, say so plainly and review the diff yourself
instead: the checklist of `craft:rust-review` (Rust) or `craft:nix-review` (Nix), otherwise read
the diff for defects, and report the findings by severity with file:line.

How to run it:
- It runs long (minutes to an hour on a large diff): give the shell call the longest timeout
  your tool allows.
- It needs to run **outside the sandbox** (ask for escalated permissions): it writes under
  `~/.craft`, may fetch the craft binary from GitHub, builds and runs the branch's code for the
  mechanical gate (`gate=false` turns that off for a branch you do not trust), and starts
  `codex exec` processes that call the model with this session's login.
- It prints `run=<directory>` on stderr as soon as the run starts. If the call is cut off or the
  run stops on the usage limit, resume it with `run=<that directory>` alone.

Arguments are the `craft:review` workflow's own, as `key=value` words (or one JSON object
argument, the only way to pass `priorDecisions` or a list of `extraLenses`):
- `repo=<absolute path>` (default: the current directory), `base=<ref>` (default: the
  merge-base with origin's default branch), `depth=light|full`, `path=<directory>`.
- Re-review of fix commits: `base=<the commit the review was made on> fresh=true fullEvery=0`.
- `strict=true`, `gate=false`, `optional=true|<lens,...>`, `pr=<number>`, `comment=true`
  (post the defects on the PR; doubtful findings stay in the report for the human).
- `run=<directory>` resumes a stopped run; with `comment=true` it publishes a finished run.
- `gateOnly=true` runs the mechanical gate alone.
- `craftBin=<absolute path>` runs a local build of the binary.

Its own arguments: `concurrency=<n>` — review agents at once (default 4); `codexModels=<model>`
or `codexModels=opus=<model>,sonnet=<model>,haiku=<model>` — the Codex model for each tier the
review asks for (default: this session's model; also `CRAFT_CODEX_MODELS`). A refused argument
prints `INCOMPLETE — …` and runs nothing.
