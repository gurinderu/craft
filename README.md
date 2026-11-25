# craft

Engineering skills, review agents and a diff review for coding agents: Claude Code, OpenCode, Codex and pi.

craft gives your agent two things. **Skills** that carry Rust and Nix knowledge in full — testing, errors,
ownership, concurrency, unsafe, flakes, packaging and more — and load on their own when the task matches. And a
**review** of a diff in any language: each changed file goes to the lenses of its language, every finding is checked
against the code, and you get one report with a verdict.

craft is self-contained: it declares no plugin dependencies.

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
opencode plugin add git+https://github.com/gurinderu/craft#opencode-v0.60.0
```
<!-- x-release-please-end -->

OpenCode 1.x installs with `integrations/opencode/install.sh` from a checkout of a release tag. Upgrading, the
model strategy and what differs from Claude Code: [integrations/opencode/README.md](https://github.com/gurinderu/craft/blob/main/integrations/opencode/README.md).

### Codex

<!-- x-release-please-start-version -->
```
codex plugin marketplace add gurinderu/craft --ref v0.60.0
codex plugin add craft@craft
```
<!-- x-release-please-end -->

Then open `/hooks` in the Codex TUI and trust craft's hooks: Codex runs a plugin's hooks only once you trust them.

To move to a new release, remove the marketplace first — Codex refuses to add `craft` again from another tag:

<!-- x-release-please-start-version -->
```
codex plugin marketplace remove craft
codex plugin marketplace add gurinderu/craft --ref v0.60.0
codex plugin add craft@craft
```
<!-- x-release-please-end -->

Why the tag is pinned, and the sandbox fix for Ubuntu 24.04:
[integrations/codex/README.md](https://github.com/gurinderu/craft/blob/main/integrations/codex/README.md).

### pi

<!-- x-release-please-start-version -->
```sh
pi install git:github.com/gurinderu/craft@v0.60.0
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

The skills need no command: the agent loads one when the task matches its description — `rust-testing` when you
write Rust tests, `nix-flakes` when you edit a flake. In Claude Code and Codex they appear as `craft:<name>`.

Once per repository, `craft:review-init` (`craft init`) can record the external systems your code talks to and
which check of your CI runs what. The review then reads those systems' source at the version you deploy. It is
optional.

### What works where

| | Claude Code | OpenCode | Codex | pi |
|---|---|---|---|---|
| Skills | all | all but `develop` and `codex-review` | all | `craft-review` only |
| Diff review | yes | yes | yes — new, not yet observed in a real session | yes — observed from a checkout, not yet as an installed package |
| `rust-audit` and `triage-findings` workflows | yes | 1.x only; on 2.x they refuse to run | no | no |
| The `craft:develop` cycle up to a PR | yes | no | no | no |

Linux and macOS. On Windows the binary is built for x86_64, but craft has not been run there.

## Before the first review

The review's mechanical gate **builds and runs the reviewed branch's code on your machine**: clippy runs its build
scripts and proc macros (inside the repository's flake dev shell when it defines one, whose `shellHook` runs too),
and `nix flake check` runs its checks. For a branch you do not trust, pass `gate=false` (`--no-gate` on the command
line).

On pi and OpenCode that is not enough. pi has no sandbox: a review task's shell runs with your permissions, so
review an untrusted branch with `--no-gate` and inside a container or VM. On OpenCode 1.x a `--pr` review loads the
PR's own OpenCode configuration and plugins, so its code runs even with `--no-gate`: review it on another host. See
[integrations/pi/README.md](https://github.com/gurinderu/craft/blob/main/integrations/pi/README.md) and
[integrations/opencode/README.md](https://github.com/gurinderu/craft/blob/main/integrations/opencode/README.md).

## What is inside

- **Skills** — Rust (testing, errors, ownership, concurrency, traits, performance, unsafe, architecture, security
  and the domains: web, CLI, fintech, cloud-native, embedded, ML), Nix (flakes, packaging, dev shells, NixOS), the
  review rubrics and rules, backward compatibility, controller races, project memory.
- **Review agents** — a Rust and a Nix reviewer, a security scanner, a Miri runner, an architecture auditor.
- **Workflows** — `review` (the diff review), `rust-audit` (a whole-crate audit before a release) and
  `triage-findings` (review findings and PR comments into one ordered fix plan).
- **Hooks** — in a repository that declares its own agent roles or review rules, craft tells the session how those
  run with craft's tools; these are silent elsewhere and off with `CRAFT_ROLE_HOOK=0`. One more hook speaks in any
  repository and has no switch: after `gh pr create` in Claude Code it warns when the new PR has no finished full
  craft review.

The full catalogue, what each hook says and when, how the workflows run and how the repository is laid out:
[MAP.md](https://github.com/gurinderu/craft/blob/main/MAP.md). The run records the workflows write: [docs/observability.md](https://github.com/gurinderu/craft/blob/main/docs/observability.md). Working on
craft itself: [AGENTS.md](https://github.com/gurinderu/craft/blob/main/AGENTS.md).
