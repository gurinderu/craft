---
name: retro
description: >-
  Retro of your craft reviews in this repository: where the tokens and minutes go and what breaks, counted by the binary from the run store — `craft runs retro` over this project's runs (a period, a branch), its runs by kind (a review's depth and lens scope) with minutes, agents and the usable cost, each lens's yield, what did not run, and the unverified findings that recur. Two outcomes, each shown before anything is written or sent: a proposal for your review profile (lenses held or off, the mutants budget, the project's properties), written through review-init on your word, and a draft issue about craft itself, sent only if you say so. Use when the session-start hook offers a retro, after a release's full review, when reviews feel slow or costly, or after several runs without a clean verdict. Triggers: craft retro, review retro, where do the review tokens go, why are my reviews so slow, which lenses find nothing. Not for one run's report (read its report.md).
---

# retro — what your reviews here cost and found

The numbers come from the run store (`~/.craft/runs`), counted by the `craft` binary; you read
them. A model's reading of numbers can be wrong, so everything you hand on carries the number,
the rows it came from and how it was counted, and any conclusion beside it is named as a
hypothesis. Nothing is written to the profile and nothing leaves the machine without the
person's word.

## 1. The range

By default: this repository's runs of the last 14 days. The person may name a period (a stamp
prefix such as `2026-11-01` for `--since` and `--until`), a branch (`--branch`) or a craft
version (`--version`). Say the range in one line before you read.

## 2. Get the binary and read

```sh
CRAFT_BIN="$(sh "<this skill's base directory>/../../integrations/shared/craft-cli.sh" --ensure --print-path)" || exit $?
"$CRAFT_BIN" runs recurring --unverified --project "$(git rev-parse --show-toplevel)"
"$CRAFT_BIN" runs retro --project '<its project, as printed>' --since <YYYY-MM-DD> --json
"$CRAFT_BIN" init --propose --cwd "$(git rev-parse --show-toplevel)"
```

`runs recurring` resolves the repository to the key the run store files its runs under — a
linked worktree's runs under its main checkout — and prints it as `project`; `runs retro`
matches `--project` as written, so pass it that key exactly, never a path of your own. On native
Windows without `sh`, obtain the binary with `node "<this skill's base directory>/../../integrations/shared/craft-bin.mjs" ensure`.
An exported `CRAFT_BIN` selects a local build. None of the three writes anything.

`runs retro --json` prints one line per row, its `section` naming it:

- `summary` — the runs read (`runs`), how many had partial coverage, were set apart unfinished,
  or were folded into a newer record of the same run, and the filters it kept.
- `kind` — per kind of run (the workflow, a review's depth and lens scope): `runs`,
  `minutesPerRun` and `agentsPerRun` over the runs that recorded them (`timed`, `counted`),
  `priced` runs with a usable cost, their `cost` and `costPerRun` in tokens, and `unpriced` by
  why. `missing` on every run means the host records no cost (outside Claude Code): say so and
  read minutes and agents instead.
- `workflow` — verdicts, findings by severity, the verified share; `engine` — which host and
  craft version ran them; `notRun` — what did not run, and coverage gaps, by how often.
- `lens` — per lens: `runs`, `dead` (it did not run), `findings` and their `bySeverity`,
  `refuted` of the `candidates` verified and `refuteRate`, `unverified`; `lensRound` — what each
  lens round raised and what verification confirmed of it; `roundYieldApart` — what was
  confirmed of the gate's seeds and of no lens round.

`runs recurring --unverified` prints one JSON object: findings confirmed on more than one branch,
and apart under `unverified`, unverified ones that recur, each group with its `file`, `titles`,
`severities` and `runs`. It reads the store's newest runs (`runsRead`, its `note`), not the range
above: say which window its groups come from. `init --propose` prints what the profile holds and what it offers:
`lenses` (each lens's yield on this project and an offer to hold it to the first round or turn
it off), `mutants` and `project`, as the review-init skill reads them.

Fewer than five runs in the range: say how many, and that so few say little; offer a wider
range and stop unless the person wants the reading anyway.

## 3. Read the tables

Name the observations as a numbered list, each with its number, its rows and how it was counted:

- **Cost and time by kind** — which kinds take the minutes, agents and tokens, and how a full
  pass compares with a light one, a whole-diff scope with a delta.
- **Lenses** — a lens with runs and no confirmed finding, or whose candidates are mostly refuted,
  or that is often `dead`. Take the offers `init --propose` prints for it; do not derive your own.
- **What did not run** — the `notRun` lines and unfinished runs, and how many runs ended without
  a clean verdict (Block, INCOMPLETE, partial coverage).
- **Recurring findings** — unverified groups that recur across runs: worth verifying once, or a
  decision recorded with `craft:memory` so the next review sets them aside.

Then sort each observation by who can act on it: the reviewer's profile, or craft itself — a
lens dead on many runs, a step that fails, a cost no profile setting reaches.

## 4. The profile

Only what the profile can say: a lens held to the first round or turned off, the mutants off or
their budget, the project's properties. Ask the reviewer in words, one numbered list, each
proposal with the numbers behind it. On their word, write through the review-init skill: from its
proposal (its step 2) go straight to its step 4 with the confirmed changes, every held entry
passed back as the proposal prints it — a write replaces each section whole. When the proposal
marks a section it could not read (`unread`, `heldUnread`) or a held CI entry `unusable`, stop and
tell the reviewer first: such a write replaces what the file holds there. Nothing confirmed —
nothing written.

## 5. About craft

What the profile cannot fix goes to craft's maintainer as a draft issue, shown whole before
anything is sent: a title; the observation with its numbers and how they were counted; the craft
version and host from the `engine` rows; the hypothesis, named as one. Leave out anything that
names the person's code or machine: the repository's and branches' names, paths (the home
directory's too), file names, finding titles, the names of the repository's own agents or
lenses — keep only craft's own lens ids — and the text of `notRun` lines, which quotes paths and
errors: say what failed in your own words. They add any of it only if they choose to. Send it only on their word, as they say: `gh issue create --repo
gurinderu/craft --title <title> --body-file <the draft's file>`, the file in the session's
scratch and removed after. Nothing about craft — say so in one line.

## 6. Report

The range and the runs read; the observations; what was written to the profile, or that nothing
was; the draft issue — sent with its link, or kept by the person, or none. Then mark the retro
done, whatever came of it:

```sh
"$CRAFT_BIN" runs retro-done --project "$(git rev-parse --show-toplevel)"
```

It files a `retro` record of this repository, which no reader counts as a run; the session-start
hook counts this repository's runs anew from it before it offers the next retro.
