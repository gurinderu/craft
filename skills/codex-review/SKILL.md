---
name: codex-review
description: >-
  Codex only: craft's review of a diff or PR in any language, run from a Codex session — one command, the craft CLI's `craft review run --backend codex` (the mechanical gate, review lenses per profile, verification, one report and an Approve/Warning/Block verdict), each review agent its own `codex exec` process. Use in Codex when asked to review a branch, a diff or a PR before commit or merge, to re-review fix commits, or to resume a stopped review. Triggers: review this branch, review the diff, is this mergeable, re-review the fixes, resume the review. Not in Claude Code: there the review is the craft:review workflow (Workflow tool), never this skill. Not in OpenCode: there the review is the /review command (the `review` tool), never this skill and never `codex exec`.
---

# codex-review — craft's review from Codex

**In Claude Code, stop here**: launch the `craft:review` workflow with the Workflow tool instead;
this skill is the Codex route to the same review.

In Codex, the review is one command. Its plugin root is two directories above this file's
directory (this file is `<plugin root>/skills/codex-review/SKILL.md`):

```sh
sh "<plugin root>/bin/craft" review run --backend codex [flags ...]
```

`bin/craft` runs the craft binary of this plugin version, downloading it from the plugin's GitHub
release into `~/.craft/bin/<version>/` the first time. If it fails with one `craft: …` line (no
download tool, no network, a platform with no released binary), relay that line.

Run it **once, in this session**, never in a subagent, and relay what it prints on stdout — the
`## Verdict` block, the report's path and the `## Findings` list — then read the report file it
names for the details. Do not review the diff yourself beside it.

It exits 1 when the review's work was cut short (`INCOMPLETE`, `Warning (INCOMPLETE)`, …); that
is still its answer, with its `## Verdict` block: relay it, and its `## What the agents said` section when there is one — the errors the
review agents died on (a model the account does not support, for one, is fixed with `--models`). A run with nothing to review — `INCOMPLETE (empty diff)` or
`INCOMPLETE (no language profile)` — exits 0. It exits 2 when it refused its arguments and ran
nothing; the `## Verdict` block says why.

This route is new and not yet observed running in a real Codex session. If the command cannot
run here, or fails without a `## Verdict` block, say so plainly and review the diff yourself
instead: the checklist of `craft:rust-review` (Rust) or `craft:nix-review` (Nix), otherwise read
the diff for defects, and report the findings by severity with file:line.

How to run it:
- It runs long (minutes to an hour on a large diff): give the shell call the longest timeout
  your tool allows.
- It needs to run **outside the sandbox** (ask for escalated permissions): it writes under
  `~/.craft`, may fetch the craft binary from GitHub, builds and runs the branch's code for the
  mechanical gate (`--no-gate` turns that off for a branch you do not trust), and starts
  `codex exec` processes that call the model with this session's login.
- It prints `run=<directory>` on stderr as soon as the run starts. If the call is cut off or the
  run stops on the usage limit, resume it with `--run <that directory>` alone (beside
  `--backend codex`).
- If it says Codex is not logged in, tell the human to run `codex login`, then resume.

Flags:
- `--cwd <repository>` (default: the current directory), `--base <ref>` (default: the
  merge-base with origin's default branch), `--depth light|full`, `--path <directory>`.
- Re-review of fix commits: `--base <the commit the review was made on> --fresh --full-every 0`.
- `--strict`, `--no-gate`, `--optional all|<lens,...>`, `--pr <number>`, `--comment`
  (post the defects on the PR; doubtful findings stay in the report for the human),
  `--extra-lenses <agent,...>|off`, `--prior-decisions <file>` (a JSON list of the launcher's
  decision, question and rule records).
- `--run <directory>` resumes a stopped run; with `--comment` it publishes a finished run.
- The mechanical gate alone is another command: `sh "<plugin root>/bin/craft" review gate
  [--cwd …] [--base …]`.
- `CRAFT_BIN=<absolute path>` in the environment runs a local build of the binary.
- `--concurrency <n>` — review agents at once, 1 to 16 (default 4; also
  `CRAFT_CODEX_CONCURRENCY`); `--models <model>` or `--models opus=<model>,sonnet=<model>,haiku=<model>`
  — the Codex model for each tier the review asks for (default: Codex's own configured model;
  also `CRAFT_CODEX_MODELS`).
