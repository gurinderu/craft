---
name: craft-review
description: craft's review of a diff or PR in any language, run from a pi session — one command that drives the craft CLI's review (the mechanical gate, review lenses per profile, verification, one report and an Approve/Warning/Block verdict), each review agent its own `pi -p` process. Use when asked to review a branch, a diff or a PR before commit or merge, to re-review fix commits, or to resume a stopped review. Triggers - review this branch, review the diff, is this mergeable, re-review the fixes, resume the review.
---

# craft-review — craft's review from pi

The review is one command. The craft package root is four directories above this file's
directory (this file is `<package root>/integrations/pi/skills/craft-review/SKILL.md`):

```sh
node "<package root>/lib/pi-review.mjs" [key=value ...]
```

Run it **once, in this session**, with the bash tool, and relay what it prints on stdout — the
`## Verdict` block, the report's path and the `## Findings` list — then read the report file it
names for the details. Do not review the diff yourself beside it.

This route is new and not yet observed running in a real pi session. If the command cannot run
here, or fails without a `## Verdict` block, say so plainly and review the diff yourself instead:
the checklist in `<package root>/skills/rust-review/SKILL.md` (Rust) or
`<package root>/skills/nix-review/SKILL.md` (Nix), otherwise read the diff for defects, and report
the findings by severity with file:line.

How to run it:
- It runs long (minutes to an hour on a large diff): give the bash call no timeout, or the
  longest one you can.
- It writes under `~/.craft`, may fetch the craft binary from GitHub, builds and runs the
  branch's code for the mechanical gate (`gate=false` turns that off for a branch you do not
  trust), and starts `pi -p` processes that call the model with this pi installation's login.
  Those processes get no write or edit tool, but pi has no sandbox: their bash runs with your
  permissions.
- It prints `run=<directory>` on stderr as soon as the run starts. If the call is cut off or the
  run stops on the usage limit, resume it with `run=<that directory>` alone.
- If it says pi is not logged in, tell the human to log in to pi (`pi`, then `/login`) and
  resume with the `run=` it names.

Arguments are the review's own, as `key=value` words (or one JSON object argument, the only way
to pass `priorDecisions` or a list of `extraLenses`):
- `repo=<absolute path>` (default: the current directory), `base=<ref>` (default: the
  merge-base with origin's default branch), `depth=light|full`, `path=<directory>`.
- Re-review of fix commits: `base=<the commit the review was made on> fresh=true fullEvery=0`.
- `strict=true`, `gate=false`, `optional=true|<lens,...>`, `pr=<number>`, `comment=true`
  (post the defects on the PR; doubtful findings stay in the report for the human).
- `run=<directory>` resumes a stopped run; with `comment=true` it publishes a finished run.
- `gateOnly=true` runs the mechanical gate alone.
- `craftBin=<absolute path>` runs a local build of the binary.

Its own arguments: `concurrency=<n>` — review agents at once (default 4; also
`CRAFT_PI_CONCURRENCY`); `piModels=<model>` or
`piModels=opus=<model>,sonnet=<model>,haiku=<model>` — the pi model (as `pi --model` takes it)
for each tier the review asks for (default: pi's own configured model; also `CRAFT_PI_MODELS`).
A refused argument prints `INCOMPLETE — …` and runs nothing.
