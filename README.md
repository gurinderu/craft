# craft

**AI code review for the change your coding agent just made.**

craft is an AI code review tool that runs inside Claude Code, OpenCode, Codex and pi. It checks code quality before
the pull request is opened: point it at a branch and it comes back with one report and a verdict — Approve, Warning
or Block.

- **Many narrow passes instead of one general one.** Each changed file goes to the lenses of its language — Rust,
  Nix, SQL, or general lenses for everything else — and each lens looks for one kind of defect: correctness,
  security, concurrency, error handling, tests, backward compatibility, broken invariants.
- **Findings are checked before you read them.** A finding that can decide the verdict is verified against the code
  by a separate pass: one that does not hold is listed apart as refuted, and one that was not checked is marked so.
  Each finding names the harm — who is hurt and how they recover — and its severity is capped by that harm.
- **Real tools come first.** For Rust and Nix, clippy, semgrep, `nix flake check`, statix and deadnix run before any
  lens does; a red check blocks.
- **It learns your project.** A finding you already decided on is set aside while the code it concerns stays
  unchanged; the systems your code talks to, once you name them, are read at the version you deploy; a second review
  of a branch reads only the fix commits.
- **It says what it did not review.** When part of a change could not be reviewed, the verdict says so instead of
  showing a green one.
- **It runs where you already work** — in your agent's own session, with your own login. There is no service to
  sign up for, and craft declares no plugin dependencies.

craft also carries the knowledge its review judges by as **skills** your agent loads while it writes code: Rust and
Nix in full — testing, errors, ownership, concurrency, unsafe, flakes, packaging and more.

## Install

Pick your host. The `craft` binary the review runs is downloaded on first use into `~/.craft/bin/<version>/` (with
`curl` or `wget`); what else a host needs is said under it.

### Claude Code

```
/plugin marketplace add gurinderu/craft
/plugin install craft@craft
```

### OpenCode

OpenCode 2.x:

<!-- x-release-please-start-version -->
```bash
opencode plugin add git+https://github.com/gurinderu/craft#opencode-v0.61.0
```
<!-- x-release-please-end -->

OpenCode 1.x installs with `integrations/opencode/install.sh` from a checkout of a release tag. Upgrading, the
model strategy and what differs from Claude Code: [integrations/opencode/README.md](https://github.com/gurinderu/craft/blob/main/integrations/opencode/README.md).

### Codex

<!-- x-release-please-start-version -->
```
codex plugin marketplace add gurinderu/craft --ref v0.61.0
codex plugin add craft@craft
```
<!-- x-release-please-end -->

Then open `/hooks` in the Codex TUI and trust craft's hooks: Codex runs a plugin's hooks only once you trust them.

To move to a new release, remove the marketplace first — Codex refuses to add `craft` again from another tag:

<!-- x-release-please-start-version -->
```
codex plugin marketplace remove craft
codex plugin marketplace add gurinderu/craft --ref v0.61.0
codex plugin add craft@craft
```
<!-- x-release-please-end -->

Why the tag is pinned, and the sandbox fix for Ubuntu 24.04:
[integrations/codex/README.md](https://github.com/gurinderu/craft/blob/main/integrations/codex/README.md).

### pi

<!-- x-release-please-start-version -->
```sh
pi install git:github.com/gurinderu/craft@v0.61.0
```
<!-- x-release-please-end -->

The pi package brings the review only, none of craft's other skills. Details:
[integrations/pi/README.md](https://github.com/gurinderu/craft/blob/main/integrations/pi/README.md).

## Use

Ask your agent for a craft review of your branch. This is what runs it on each host:

| Host | The review |
|---|---|
| Claude Code | the `craft:review` workflow — ask Claude to run it on your branch |
| OpenCode | `/craft-review` |
| Codex | the `craft:codex-review` skill |
| pi | `/skill:craft-review`, or just ask |

The skills need no command: the agent loads one when your work matches its description — `rust-testing` when you
write Rust tests, `nix-flakes` when you edit a flake. In Claude Code and Codex they appear as `craft:<name>`.

Once per repository, `craft:review-init` (`craft init`) can record the external systems your code talks to and
which check of your CI runs what. The review then reads those systems' source at the version you deploy. It is
optional.

After a while of reviews, `craft:retro` reads your runs in that repository — where the minutes and tokens went,
which lenses found nothing, what did not run — and proposes changes to that profile, written only on your word,
and a draft issue about craft itself, sent only if you choose.

### What works where

| | Claude Code | OpenCode | Codex | pi |
|---|---|---|---|---|
| Skills | all | all but `develop`, `codex-review` and `audit` | all | `craft-review` only |
| Diff review | yes | yes | yes — new, not yet observed in a real session | yes — observed from a checkout, not yet as an installed package |
| `rust-audit` and `triage-findings` workflows | yes | 1.x only; on 2.x they refuse to run | no | no |
| `audit` workflow (the whole project) | yes — new, not yet observed in a real session | no | no | no |
| The `craft:develop` cycle up to a PR | yes | no | no | no |

Linux and macOS. On Windows the binary is built for x86_64, but craft has not been run there.

### Triage with the binary

`craft triage run` turns a review report, PR review threads, or both into a fix plan using Codex,
pi or OpenCode's agents:

```sh
craft triage run --backend codex --report review.md
craft triage run --backend pi --pr 123 --cwd /path/to/repo
```

Use `--backend opencode` for OpenCode. `--models` and `--concurrency` configure the host just as
for `craft review run`; `--help` lists the other options. Progress goes to stderr; stdout names
the plan file and summarizes the outcome. The calling session reads `plan.json` and handles the
fixes and issues. The command itself gathers and checks findings, then writes the plan and its
run record. Relative report paths start at the calling directory, even when `--cwd` or `--repo`
points at another repository.

Continue a stopped run with `craft triage run --backend codex --run /path/to/run`. A continuation
keeps the recorded repository and sources; new `--report`, `--pr`, `--base`, `--pr-base`,
`--prior-ledger` and `--prior-decisions` arguments are refused. An unfinished or stopped run exits
nonzero. Host tool permissions stay the same as for review; unavailable project memory is
reported as degraded. This command is separate from the workflow tools in the table above;
installed-host behavior has not yet been observed.

## Before the first review

The review's mechanical gate **builds and runs the reviewed branch's code on your machine**: clippy runs its build
scripts and proc macros (inside the repository's flake dev shell when it defines one, whose `shellHook` runs too),
and `nix flake check` runs its checks. On a Rust change whose gate's checks passed (a seed tool that did not
answer leaves its track unknown and does not stop them), and where `cargo mutants` is installed,
the review also **runs the branch's test suite**: cargo-mutants runs the tests once per mutant of the changed lines,
beside the lens rounds, for up to 10 minutes. A suite with side effects (a database, the network) or a heavy one runs
then too. The reviewer's profile turns this off or bounds it: ask the `craft:review-init` skill to turn the mutants
off or give them a budget, and it writes the `[mutants]` section of `~/.craft/projects/<id>/review.toml` while
keeping the rest. Do not run `craft init --write --mutants off` alone: a write rebuilds the whole profile from the
flags it is given, so it would drop your integration points, CI map and lenses. For a branch you do not trust, pass `gate=false`
(`--no-gate` on the command line): it turns off both.

On pi and OpenCode that is not enough. pi has no sandbox: a review task's shell runs with your permissions, so
review an untrusted branch with `--no-gate` and inside a container or VM. On OpenCode 1.x a `--pr` review loads the
PR's own OpenCode configuration and plugins, so its code runs even with `--no-gate`: review it on another host. See
[integrations/pi/README.md](https://github.com/gurinderu/craft/blob/main/integrations/pi/README.md) and
[integrations/opencode/README.md](https://github.com/gurinderu/craft/blob/main/integrations/opencode/README.md).

## What is inside

- **The review** — `review`, the diff review; beside it `audit`, the audit of a whole project in any language — every
  tracked file as it stands, not a diff —, `rust-audit`, a whole-crate audit before a release, and
  `triage-findings`, which turns review findings and PR comments into one ordered fix plan.
- **Skills** — Rust (testing, errors, ownership, concurrency, traits, performance, unsafe, architecture, security
  and the domains: web, CLI, fintech, cloud-native, embedded, ML), Nix (flakes, packaging, dev shells, NixOS), the
  review rubrics and rules, backward compatibility, controller races, project memory.
- **Hooks** — in a repository that declares its own agent roles or review rules, craft tells the session how those
  run with craft's tools; these are silent elsewhere and off with `CRAFT_ROLE_HOOK=0`. One more hook speaks in any
  repository and has no switch: after `gh pr create` in Claude Code it warns when the new PR has no finished full
  craft review. And in any repository where your reviews have piled up — 20 runs, the last 3 without a clean
  verdict, a release's full review, or two weeks since the last retro — the session start offers `craft:retro`, at
  most once a day; it never runs it for you, and `CRAFT_RETRO_HOOK=0` turns the offer off.

The full catalogue, what each hook says and when, how the workflows run and how the repository is laid out:
[MAP.md](https://github.com/gurinderu/craft/blob/main/MAP.md). The run records the workflows write: [docs/observability.md](https://github.com/gurinderu/craft/blob/main/docs/observability.md). Working on
craft itself: [AGENTS.md](https://github.com/gurinderu/craft/blob/main/AGENTS.md).

## License

MIT — see [LICENSE](https://github.com/gurinderu/craft/blob/main/LICENSE).
