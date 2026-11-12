# craft for opencode

This subtree makes the craft Rust skills, review agents, and audit/triage workflows usable from
[opencode](https://opencode.ai). The Claude Code surface is unchanged — this is a thin, contained
adapter layer.

## Install

### OpenCode 2.x — one command

<!-- x-release-please-start-version -->
```bash
opencode plugin add git+https://github.com/gurinderu/craft#opencode-v0.51.0
```
<!-- x-release-please-end -->

`opencode plugin add` installs the release's package (the `opencode-plugin` branch, tagged
`opencode-v<version>` by each release) — it has no npm dependencies, so nothing else is installed — and writes the spec into the global
`~/.config/opencode/opencode.json` `plugins` list; the same spec as one line of a project's `plugins` works too.
The plugin brings craft's tools, its agents, the `/craft-review`, `/rust-audit` and `/triage-findings` commands,
the skills (all but `develop` and `codex-review`) and the review's footer line — 2.x reads no agents, commands
or skills folder inside a package, so the plugin registers them itself. `opencode plugin list --builtin` lists
it as `craft-rust` (a plain `opencode plugin list` does not). The spec names a fixed tag, so `opencode plugin update`
never moves it. To move to a new release, remove the old spec and add the new one — adding the new tag's spec alone
keeps the old one in the list too, and both load:

```bash
opencode plugin remove git+https://github.com/gurinderu/craft#opencode-v<old version>
opencode plugin add git+https://github.com/gurinderu/craft#opencode-v<new version>
```

The review command is `/craft-review`: 2.x has a built-in `/review` of its own.

### OpenCode 1.x — install.sh

Check out a release tag, then, from the project the adapters are for, symlink them into an opencode tree:

<!-- x-release-please-start-version -->
```bash
git clone --branch v0.51.0 https://github.com/gurinderu/craft ~/craft
~/craft/integrations/opencode/install.sh            # project-scoped: ./.opencode  (default)
~/craft/integrations/opencode/install.sh --global   # ~/.config/opencode
```
<!-- x-release-please-end -->

Install from a release tag, not `main`: `bin/craft` runs the `craft` binary of the release version, so a
checkout of `main` would run newer skills and content with an older binary. `install.sh` works on 2.x too (2.x
reads the linked folders itself, and the plugin then registers nothing of its own).

Then restart opencode (or reopen the project) so it rescans `skills/`, `agents/`, `commands/`,
and `plugins/`.

### OpenCode 1.x and 2.x

One plugin serves both lines: its default export carries a 1.x entry (`server`) and a 2.x entry
(`setup`), and each runtime reads its own. Both were seen loading it — opencode 1.19.5 and 2.2.7.

### Plugin dependencies

opencode loads the plugin from `plugins/craft-rust.ts`, a link to `plugin/index.ts` (1.x loads only
files from `plugins/`, not directories). opencode 2.x does not install a plugin
directory's dependencies, so `install.sh` runs `npm ci --omit=dev` in `integrations/opencode/plugin`
whenever the dependencies are missing or npm's record of them is older than `package-lock.json` (a tree
with dev packages is reinstalled with them; one another installer laid out is left alone); without npm,
run it there yourself before starting opencode. The 2.x package needs none of them: only the 1.x entry imports
`@opencode-ai/plugin` at run time, and it loads that module only when 1.x calls it.

## Upgrading

On 2.x with the package, run `opencode plugin remove <old spec>`, then `opencode plugin add <new spec>` (above) — adding the new spec alone keeps the old one too, and craft loads twice. With `install.sh`: after checking out the new release tag (`git fetch --tags && git checkout v<version>`), rerun `install.sh` with the same scope, then restart
opencode. The links point into this checkout, but a checkout does not change what is linked:

- it relinks the plugin as one file, `plugins/craft-rust.ts` — opencode 1.x never loads the older
  directory link, so without the rerun the plugin silently stops loading there;
- it links the footer's directory, `plugins/craft-review-footer` — without it 2.x shows no review
  progress line;
- it installs the plugin's locked dependencies again (`npm ci --omit=dev`) — opencode 2.x does not;
- it links agents and commands added since the last install (`review-task`, `/craft-review`) — they are
  linked file by file, so a new one is missing until the rerun — and removes its links whose target
  is gone or no longer installed (`codex-review`, the old plugin directory link).

`/craft-review` refuses to start when the `review-task` agent is missing and says to add the package (2.x) or rerun `install.sh`.

## Use

- **Skills** — auto-discovered; opencode's `skill` tool lists all of craft's skills and routes by description.
  `install.sh` leaves out `develop` and `codex-review`, which drive the review through Claude Code's
  Workflow tool and `codex exec`; in OpenCode the review is `/craft-review`.
- **Agents** — `rust-reviewer`, `rust-architecture-reviewer`, `rust-security-scanner` and `rust-miri`
  are hidden subagents (they don't clutter `@`-autocomplete); the workflows dispatch them.
  `review-task` exists only for `/craft-review`'s tasks: hidden too, but `mode: all`, because the binary
  starts it with `opencode run --agent review-task`, which opencode 1.19.5 refuses for a subagent
  (it falls back to the default agent); `hidden` keeps it out of the agent picker. It may read
  outside the reviewed repository (`external_directory: allow`): its task's prompt file is in the
  run directory under `~/.craft`, and 1.19.5's `run` stops on the permission question otherwise.
- **Workflows** — `/rust-audit [base-ref]`, `/triage-findings <locator>` and `/craft-review [flags ...]`.
  Each workflow's child sessions nest under the session that called it.

## Review

`/craft-review` runs craft's review through the `review` tool, which runs the `craft` binary's own driver:
`<checkout>/bin/craft review run --backend opencode --events json`. `bin/craft` runs the binary of this
plugin's version, downloaded from its GitHub release into `~/.craft/bin/<version>/` the first time
(`CRAFT_BIN=<path>` runs a local build). The binary decides every step — the gate, the scouts, the
lenses round after round, verification, the verdict — and runs each task as its own `opencode run`
process. On 1.x the tool's title follows the run's progress; the answer is the binary's `## Verdict`
block and findings, as markdown. On 1.x the tasks' sessions are not archived (1.19.5's `run` takes no
`--archived`), and a task of a subagent such as `rust-reviewer` runs on `review-task` with that
agent's prompt (1.x `run` puts a subagent on its default agent, which writes). The binary's 1.19.5
path was seen reaching the model as `review-task`; the tool itself is covered by tests against a fake
binary, not yet seen in a real OpenCode session.

On 2.x the review shows its progress as a line in the TUI's prompt footer of the session that runs it —
the same line 1.x shows as the tool's title — and on the end clears it and shows the verdict as a toast;
nothing of it reaches the model. The footer is a TUI plugin of its own: `install.sh` links the directory
`plugin/tui/` as `plugins/craft-review-footer` (2.x loads a TUI plugin only from a directory; 1.x ignores
directories there). Without that link, or on a 2.x that lacks the plugin RPC, the review runs as before
with no footer line.

On OpenCode 2.x `/rust-audit` and `/triage-findings` refuse up front, INCOMPLETE, and run nothing:
their child sessions never answered in testing (craft 0.50.0, OpenCode 2.2.7); use OpenCode 1.x,
Claude Code, Codex or pi for them. `/craft-review` is not refused: its tasks run as `opencode run`
processes, not child sessions. The refusal itself is tested against fake hosts only, not yet seen in
a real OpenCode 2.x.

- Every task is read-only: one that names `rust-reviewer` runs on the hidden `rust-reviewer` agent,
  every other on `review-task` (both have write and edit off), with the matching Claude Code agent's
  prompt (or the reviewed repository's own `.claude/agents/<name>.md`) before the task. A task still
  runs read-only commands (git, grep, the build's own checks) through bash.
- Models: every tier runs on the calling session's model — the one that session recorded: on 1.x its
  newest message's, on 2.x the model set on the session; when it recorded none, OpenCode's default —
  unless the flags name `--models`: one `provider/model` for all, or
  `opus=provider/model,haiku=provider/model` (env `CRAFT_OPENCODE_MODELS`). `--concurrency <n>` caps
  the tasks at once (default 4, env `CRAFT_OPENCODE_CONCURRENCY`).
- The flags are the binary's: `--base`, `--depth light|full`, `--pr`, `--comment`, `--path`,
  `--run <dir>` to resume a stopped run, `--no-gate`, ….
- A failed task is handed out again by the binary; the first usage-limit error stops new tasks and
  ends the run INCOMPLETE with how to resume it.
- If this OpenCode has no `review-task` agent (an install from before it), the review refuses to
  start, INCOMPLETE, and says to add the package (2.x) or rerun `install.sh`; it never runs a task on another, writable agent.
- If this OpenCode has no `rust-reviewer` agent, its tasks run on `review-task` with the
  rust-reviewer prompt, and the run is reported as degraded.

## Model strategy

opencode is provider-agnostic, so the agents **inherit your configured session model** (none pin
a model). Tune by task — strongest model + high effort where reasoning is heaviest:

| Component | Suggested tier | Effort |
|---|---|---|
| architecture audit | strongest (e.g. Opus-tier) | high/xhigh |
| diff review | mid (e.g. Sonnet-tier); strongest when bug-finding is critical | high |
| security scan | mid | medium |
| Miri | mid | medium |
| (workflow scouting/synthesis) | cheap/mid | low/medium |

## Containment

The plugin registers the workflow tools and one narrow hook: craft's hook at the moment of work.
It only remembers which sessions are subagents' and notes compactions, and adds a few short lines
to a message asking for review work (findings, PR comments, a review), in a repo that declares its
own agents or work rules, once per request kind (findings, review) per session. On 1.x the lines
arrive as a synthetic part after the message (`chat.message`). 2.x has no such hook, so they are
appended to the prompt's own text through the session `prompt` hook: **on 2.x the lines appear
inside the user's message text**, as if the user had written them, and stay in the history. Silent everywhere else, off with `CRAFT_ROLE_HOOK=0` or a `craft-role-hook: off` line in
`AGENTS.md` / `CLAUDE.md`. Each firing appends one line to `~/.craft/hooks.jsonl`. No permission or
tool-call interception. It talks only to the local opencode server, opens no ports, and makes no
outbound calls. Installed project-scoped by default. The hook loads craft's `lib/` from the checkout
the plugin directory is linked from; if that fails, the hook is silent and the tools still work.

## Parity caveats

- Skill sub-files aren't first-class bundled in opencode — the agent reads them by path on demand.
- `craft:` namespace prefixes in skill bodies are cosmetic here (skill name = bare dir); the model
  still resolves them.
- Workflow determinism rides on opencode's child-session API; the plugin retries sequentially and
  surfaces a clear error if a child session is stuck (opencode #8528 / #6573).
- **On 2.x the child-session reply is read but not yet seen.** The plugin admits the prompt, waits for
  the session to go idle and reads its last finished assistant message. Loading, tool registration and
  a tool run were seen on opencode 2.2.7; a child session answered by a real model was not.
- **`/rust-audit`'s review dimension is single-pass.** The CLI-driven review is `/craft-review` (above); in
  `/rust-audit` the **review** dimension is a single-pass `rust-reviewer` agent — there is no per-crate review
  fan-out and no inter-crate-contract dimension. The other audit dimensions (architecture,
  security, miri, crate-decomposition, semver, build-matrix, deps, unused-crates, tests-cov) do run.
- **Observability is a deterministic subset.** `/rust-audit` and `/triage-findings` write a run
  record to the shared `~/.craft/runs/` store (`runtime: "opencode"`), straight from the plugin —
  no logger agent. Because opencode agents return free text (not schema-validated JSON), the record
  captures `ts`/`project`/`commit`/`dirty`, which dimensions ran vs `notRun`, and a `verdict` parsed
  from the synthesis text — but NOT `findings.bySeverity` or `outputTokens` (`findings` is `null`).
  The hidden review agents do not self-log, so a standalone hidden-agent invocation is not recorded.
- **triage `conflict` semantics differ.** In `integrations/opencode/plugin/triage-findings.ts` the per-finding
  validation may itself return a `conflict` verdict (validate and plan logic are merged into one
  call); the Claude Code `triage-findings.js` reserves `conflict` for the separate Plan phase.
