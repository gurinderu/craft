---
name: audit
description: >-
  Audit a whole project in any language — every git-tracked file of the checkout as it stands, not a diff — through the `craft:audit` workflow and the craft binary (`craft audit start | submit | status`): each file to its profile (Rust, Nix, SQL, general), batches of whole files under a byte budget, the lenses that judge code as it stands, every Medium-and-above finding verified, one report with a verdict. No sampling: what the budget did not buy or what failed is counted unread (unread.txt), the verdict INCOMPLETE, and run= reads just that. Posts nothing to a PR or issues; findings go to addressing-findings. Use for code no diff review ever read — a release, a repository taken over, a part of a project (path=). Triggers: audit the repo, full audit, audit the whole project, audit this codebase, audit src/, аудит проекта, аудит репозитория. Not for a diff or a PR (the review workflow); Miri, cargo-audit, semver or unused-crate checks of a Rust crate stay with rust-audit for now.
---

# audit — the whole project, as it stands

A review reads a diff; the audit reads the code. It asks the craft binary to list the
repository's git-tracked files (or those under the paths you give), hands each to the language
profile the review would (Rust, Nix, SQL, or the general lenses for any other language), cuts
each profile's files into batches of whole files, and runs each lens that judges code as it
stands over each batch. Every finding at Medium and above is verified before it counts; Low and
Info are held apart, unverified. Severity is held by the finding's harm alone — there is no
"outside the diff" here: every finding is about the code as it is.

## When to use

- The whole project, or a part of it, was never read by a review — a repository you take over,
  code before a release, a module nobody has looked at in a long time.
- Any language: one audit covers every profile the project's files fall under, in one run.
- **Not** for a change: a branch or a PR goes to the `craft:review` workflow, which reads the
  diff and builds on earlier rounds.
- **Not yet** for the Rust-only dimensions — Miri, cargo-audit/deny/geiger, semver, unused crates,
  the build matrix, inter-crate contracts: those stay with the `craft:rust-audit` workflow until
  the audit carries them. Run both when you need both.

## Launch

The main session launches the `craft:audit` workflow (a subagent has no Workflow tool). Its
arguments, all optional:

| Argument | What it does |
|---|---|
| `path` | One path from the repository root, or a list (`path=["src","lib"]`): only the tracked files under them. Literal, no glob, no `..`. A path that holds no tracked file is refused, so a typo never reads as a clean audit. Absent: the whole project. |
| `batchBytes` | The bytes of whole files one lens agent reads at most (default 150000); a larger file is read alone. |
| `lensAgents` | The lens agents one pass buys at most, in order. Absent: one of each lens over each batch. The rest is counted unread, never sampled away. |
| `repo` | The absolute path of the checkout to audit; default the session's. |
| `run` | The absolute path of a run directory, alone: goes on with that audit (see below). |
| `craftBin`, `craftRoot` | A local craft build and plugin root, for working on craft itself. |

An argument it does not take, a start argument beside `run`, or a budget that is not a positive
whole number is refused before anything runs. On a large project, set `lensAgents` to what you
are willing to spend on one pass: the audit reads what it bought, names the rest, and the next
pass reads it.

## Reading the result

The workflow returns an `## Audit` block — the verdict, the absolute path of `report.md`, and the
counts: `unread` (files no answered lens read), `unjudged` (findings whose verifier died) and
`unverifiedLow` (Low and Info findings held apart). Read the report from its file; never ask the
workflow to copy it. Beside it, in the run directory:

- `report.md` — the findings by severity, the `## Verdict` block, and per profile the lenses the
  audit did not run.
- `unread.txt` — the files left unread, one a line, present only when there are any.
- `unverified.md` — the Low and Info findings no verifier checked.

The verdict is Block on a confirmed Critical or High, Warning on a confirmed Medium, Approve
otherwise — and **INCOMPLETE** in place of Approve (or beside a red verdict) while any file is
unread or any finding unjudged. An INCOMPLETE audit is not a clean one: say so, and go on with it.

## Going on with a run

Launch `craft:audit` with `run=<the run directory>` and nothing else. It does what the run needs:

- a run stopped on the account's usage limit, or interrupted, goes on where it stood;
- a finished pass that left files unread or findings unjudged opens a new pass over just those;
- a finished pass whose record did not land files it again.

Each finished pass files one run record of the whole audit at that point.

## The findings

The audit posts nothing — no PR comment, no issue. To work its findings, load
`craft:addressing-findings` and hand it `report.md` as the triage's `report`. There is no PR, so
leave `pr` and `prBase` out: no audit finding belongs to a PR, and whether each accepted one becomes
an issue or a fix in a branch of its own is decided there, with you.

Once the workflow run has ended (completed, failed or stopped — not while you may still resume
it), fold its real cost into the records it filed:
`sh "<this skill's base directory>/../../integrations/shared/craft-cli.sh" runs enrich-cost --run-id <wf_…>`,
with the run id the Workflow completion names. Best-effort: if it fails, say so in one line and go
on. If the workflow fails with `at workflow.js:<line>:<column>`, that place is in the bundled
engine: `node "<this skill's base directory>/../../integrations/shared/engine-source-map.mjs" audit workflow.js:<line>:<column>`
gives it in the plugin's source.
