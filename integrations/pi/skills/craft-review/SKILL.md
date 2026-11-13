---
name: craft-review
description: craft's review of a diff or PR in any language, run from a pi session — the `craft_review` tool; without it `sh <package root>/bin/craft review run --backend pi`, the package root four directories above this SKILL.md (`craft` is not on PATH; never run bare `craft`) — the mechanical gate, review lenses per profile, verification, one report and an Approve/Warning/Block verdict, each review agent its own `pi -p` process. Use when asked to review a branch, a diff or a PR before commit or merge, to re-review fix commits, or to resume a stopped review. Triggers - review this branch, review the diff, is this mergeable, re-review the fixes, resume the review.
---

# craft-review — craft's review from pi

The review is the `craft_review` tool this package's extension registers. Call it **once, in this
session**, with `args` set to the review's flags as one string (none for the defaults), and relay
its answer — the `## Verdict` block, the report's path and the `## Findings` list — then read the
report file it names for the details. Do not review the diff yourself beside it.

Without the tool (the extension not loaded), run the same review with the bash tool. The craft
package root is four directories above this file's directory (this file is
`<package root>/integrations/pi/skills/craft-review/SKILL.md`):

```sh
sh "<package root>/bin/craft" review run --backend pi [flags ...]
```

`bin/craft` runs the craft binary of this package version, downloading it from the package's
GitHub release into `~/.craft/bin/<version>/` the first time. If it fails with one `craft: …`
line (no download tool, no network, a platform with no released binary), relay that line.

The review exits 1 when its work was cut short (`INCOMPLETE`, `Warning (INCOMPLETE)`, …); that
is still its answer, with its `## Verdict` block: relay it, and its `## What the agents said` section when there is one — the errors the
review agents died on (a model the account does not support, for one, is fixed with `--models`). A run with nothing to review — `INCOMPLETE (empty diff)` or
`INCOMPLETE (no language profile)` — exits 0. It exits 2 when it refused its flags and ran
nothing; the `## Verdict` block says why.

This route is new: seen running end to end from a checkout, not yet as an installed pi package. If the review cannot run
here, or fails without a `## Verdict` block, say so plainly and review the diff yourself instead:
the checklist in `<package root>/skills/rust-review/SKILL.md` (Rust) or
`<package root>/skills/nix-review/SKILL.md` (Nix), otherwise read the diff for defects, and report
the findings by severity with file:line.

How it runs:
- It runs long (minutes to an hour on a large diff): give a bash call no timeout, or the longest
  one you can.
- It writes under `~/.craft`, may fetch the craft binary from GitHub, builds and runs the
  branch's code for the mechanical gate (`--no-gate` turns that off for a branch you do not
  trust), and starts `pi -p` processes that call the model with this pi installation's login.
  Those processes get no write or edit tool, but pi has no sandbox: their bash runs with your
  permissions.
- It prints `run=<directory>` as soon as the run starts. If the call is cut off or the run stops
  on the usage limit, resume it with `--run <that directory>` alone.
- If it says pi is not logged in, tell the human to log in to pi (`pi`, then `/login`) and
  resume with the `--run` it names.

Flags:
- `--cwd <repository>` (default: the current directory), `--base <ref>` (default: the
  merge-base with origin's default branch), `--depth light|full`, `--path <directory>`.
- Re-review of fix commits: `--base <the commit the review was made on> --fresh --full-every 0`.
- `--strict`, `--no-gate`, `--optional all|<lens,...>`, `--pr <number>`, `--comment`
  (post the defects on the PR; doubtful findings stay in the report for the human),
  `--extra-lenses <agent,...>|off`, `--prior-decisions <file>` (a JSON list of the launcher's
  decision, question and rule records).
- `--pr <number>` from a checkout that lacks the PR's head (the trunk, say): craft fetches the
  head and reviews it in its own detached worktree, one per head and never moved,
  `~/.craft/worktrees/<repo>/pr-<number>-<head>` (runs on that head at once share it), and the
  answer names it; your checkout is not touched. The gate builds and runs the PR's code: add
  `--no-gate` for a PR you do not trust. If it still refuses (it could not fetch the
  head or lay the worktree), make a detached worktree in a fresh directory of your own
  (`mktemp -d`) as the refusal says and run again with `--cwd <that worktree>` and no `--pr`,
  without asking the human — never reuse a worktree another session or craft made.
- `--run <directory>` resumes a stopped run; with `--comment` it publishes a finished run.
- The mechanical gate alone is another command: `sh "<package root>/bin/craft" review gate
  [--cwd …] [--base …]`.
- `CRAFT_BIN=<absolute path>` in the environment runs a local build of the binary.
- `--concurrency <n>` — review agents at once, 1 to 16 (default 4; also `CRAFT_PI_CONCURRENCY`);
  `--models <model>` or `--models opus=<model>,sonnet=<model>,haiku=<model>` — the pi model (as
  `pi --model` takes it) for each tier the review asks for (default: pi's own configured model;
  also `CRAFT_PI_MODELS`); `--thinking <level>` or `--thinking opus=<level>,sonnet=<level>,haiku=<level>`
  — pi's thinking level (off, minimal, low, medium, high, xhigh, max) for each tier (default: opus
  high, sonnet medium, haiku low; also `CRAFT_PI_THINKING`); a `--models` model that ends in its
  own `:<level>` keeps it; craft passes a level on every task, so pi's own configured thinking
  level is overridden unless `--thinking` or `CRAFT_PI_THINKING` is given.
