# craft for opencode

This subtree makes the craft Rust skills, review agents, and audit/triage workflows usable from
[opencode](https://opencode.ai). The Claude Code surface is unchanged — this is a thin, contained
adapter layer.

## Install

### OpenCode 2.x — one command

<!-- x-release-please-start-version -->
```bash
opencode plugin add git+https://github.com/gurinderu/craft#opencode-v0.61.0
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
git clone --branch v0.61.0 https://github.com/gurinderu/craft ~/craft
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
  `review-task` exists only for `/craft-review`'s tasks: hidden too, but `mode: all`, because the binary's own
  terminal path starts it with `opencode run --agent review-task`, which opencode 1.19.5 refuses for a
  subagent (it falls back to the default agent); `hidden` keeps it out of the agent picker. It may read
  outside the reviewed repository (`external_directory: allow`, as `rust-reviewer` may too, for a `--pr`
  review's worktree): its task's prompt file is in the
  run directory under `~/.craft`, and 1.19.5's `run` stops on the permission question otherwise.
- **Workflows** — `/rust-audit [base-ref]`, `/triage-findings <locator>` and `/craft-review [flags ...]`.
  Each workflow's child sessions nest under the session that called it.

## Review

`/craft-review` runs craft's review through the `review` tool, which runs the `craft` binary's own driver:
`<checkout>/bin/craft review run --backend opencode --events json`. `bin/craft` runs the binary of this
plugin's version, downloaded from its GitHub release into `~/.craft/bin/<version>/` the first time
(`CRAFT_BIN=<path>` runs a local build). The binary decides every step — the gate, the scouts, the
lenses round after round, verification, the verdict. On both lines it hands each task back to the plugin
(`--delegate`), which runs it as a child session of the calling session, so the tasks are that
session's children (on 1.x not yet seen opened from it in a live TUI). On 1.x the tool's title is set to the run's progress, which the 1.19.6 TUI does not redraw while the tool runs; the answer is the binary's `## Verdict`
block and findings, as markdown. The binary's own 1.19.5 path (`opencode run`, from a terminal) was seen
reaching the model as `review-task`; the tool itself and its child sessions on either line are
covered by tests against a fake binary and fake host, not yet seen in a real OpenCode session.

On both lines each child session is bounded by its task's deadline (15 minutes for a scout, 90 for a lens, 30
for the rest): past it the binary abandons the task and the plugin interrupts its session. At most
`--concurrency` children run at once (else `CRAFT_OPENCODE_CONCURRENCY`, else 4), and a child that gave
nothing back, or broke before its run ended, is stopped and tried once more alone: no other child of the
review runs beside the retry, which is given up with its task's deadline. If the plugin stops answering
the binary — its input ends, or a task cannot be handed to it — the run stops INCOMPLETE with how to
resume it. Only a child whose run succeeded gives a reply: one that failed is reported by
the error OpenCode gives (its type and message, such as 2.x's `provider.no-route` or 1.x's `APIError`), one
interrupted (2.x) by that outcome, in the run's log and, when every task of a round fails, in the answer; a usage limit in it
stops the run INCOMPLETE with how to resume it. The plugin hands the binary the agents OpenCode lists:
when they cannot be listed or `review-task` is not among them, the review refuses before anything runs;
a task whose own agent is missing runs on `review-task`, and the report says the run was degraded.
A child session is made where its parent is (OpenCode gives a child no directory of its own), so
each task's prompt names the repository it reviews by its absolute path — with `--pr`, craft's own
worktree of the PR — and asks the agent to use absolute paths under it. That is an instruction to the
model, not an enforced directory.

On 2.x the review shows its progress as a line in the TUI's prompt footer of the session that runs it —
the same line 1.x shows as the tool's title — and on the end clears it and shows the verdict as a toast;
nothing of it reaches the model. The footer is a TUI plugin of its own: `install.sh` links the directory
`plugin/tui/` as `plugins/craft-review-footer` (2.x loads a TUI plugin only from a directory; 1.x ignores
directories there). Without that link, or on a 2.x that lacks the plugin RPC, the review runs as before
with no footer line.

On OpenCode 2.x `/rust-audit` and `/triage-findings` refuse up front, INCOMPLETE, and run nothing:
their child sessions never answered in testing (craft 0.50.0, OpenCode 2.2.7); use OpenCode 1.x,
Claude Code, Codex or pi for them. `/craft-review` is not refused: its child sessions are read by
the reply reader fixed since (it reads past the session's `idle` entry and takes only a succeeded
run's reply), which the audit and the triage would share, but neither has been run on it yet. The refusal itself is tested against fake
hosts only, not yet seen in a real OpenCode 2.x.

- Every task is read-only: one that names `rust-reviewer` runs on the hidden `rust-reviewer` agent,
  every other on `review-task` (both have write and edit off), with the matching Claude Code agent's
  prompt (or the reviewed repository's own `.claude/agents/<name>.md`) before the task. A task still
  runs read-only commands (git, grep, the build's own checks) through bash.
- `review-task` is kept light on both lines, each by the hooks its host has. On 2.x the plugin's
  `context`, `compaction` and `generate` hooks — a step's request, the compaction's, one the host asks the
  session outside its steps — edit that agent's model requests in place, leaving out the repository's
  instructions however they reach the context (its rule files, one loaded on the way by a read, a change's
  notice) and every tool but glob, grep, read and shell (`light-agent.ts`); a compaction's summary passes
  as the summarizer wrote it. On 1.x the plugin's `experimental.chat.system.transform` hook edits the
  system text of that agent's requests in place (`light-agent-v1.ts`). The host calls it on every request
  of every session and names no agent, so a request is the agent's when its system text opens with the
  first sentence of the agent's file; there, in each string of the system text, everything from the first
  line that begins `Instructions from: ` to the string's end is cut, and the agent's prompt, the host's
  model line and the environment stay. That hook can change the system text only — it is shown no tool
  list and no tool result: on 1.19.5 a subdirectory's rule file still reaches the agent inside the result
  of a `read` under it. The agent's file denies the calls of the tools it names, craft's own `review`,
  `rust-audit` and `triage-findings` among them — its `"*_*"` reaches a name with an underscore only, so
  they are named — and on 2.x the hooks remove every offer but the four, and the texts, which a deny does
  not; on 1.19.5 the agent's requests carry five tools: bash, glob, grep, read and todowrite.
- Models: every tier runs on the calling session's model — the one that session recorded: on 1.x its
  newest message's, on 2.x the model set on the session; when it recorded none, OpenCode's default —
  unless the flags name `--models`: one `provider/model` for all, or
  `opus=provider/model,haiku=provider/model` (env `CRAFT_OPENCODE_MODELS`). `--concurrency <n>` caps
  the tasks at once (default 4, env `CRAFT_OPENCODE_CONCURRENCY`).
- The flags are the binary's: `--base`, `--depth light|full`, `--fresh`, `--delta` (a re-review of fix
  commits, which never approves), `--pr`, `--comment`, `--path`,
  `--run <dir>` to resume a stopped run, `--no-gate`, …. `--delta` needs a base after the merge-base:
  with the merge-base or an older commit — or no `--base` and no earlier round of the branch — the
  binary refuses it before anything runs, since that round would review the whole branch.
- `--pr <n>` from a checkout that lacks the PR's head (the trunk, say) reviews it in craft's own
  detached worktree, `~/.craft/worktrees/<repo>/pr-<n>-<head>`, one per head, shared by runs at once
  and never moved; your checkout is not touched. From the `review` tool the tasks are child sessions
  of your session, in your checkout's OpenCode, and read the worktree by its absolute path. When the
  binary runs its own `opencode run` (`craft review run --backend opencode` from a terminal), every
  task — and the agent check before them — runs there, so OpenCode loads the PR head's own
  `opencode.json`, `.opencode/` plugins, MCP servers and agent overrides: the PR's code runs even with
  `--no-gate`. Review a PR you do not trust on another host, with `--no-gate`. Project-installed craft
  agents are not in that worktree: install them globally (`install.sh --global`) or, on 2.x, add the package.
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

The plugin registers the workflow tools and narrow hooks: craft's hook at the moment of work, and — for
the `review-task` agent only — the hooks that edit its model requests in place: on 2.x `context`,
`compaction` and `generate` (`light-agent.ts`), on 1.x `experimental.chat.system.transform`
(`light-agent-v1.ts`); no other agent's request is touched.
The work hook only remembers which sessions are subagents' and notes compactions, and adds a few short lines
to a message asking for review work (findings, PR comments, a review), in a repo that declares its
own agents or work rules, once per request kind (findings, review) per session. On 1.x the lines
arrive as a synthetic part after the message (`chat.message`). 2.x has no such hook, so they are
appended to the prompt's own text through the session `prompt` hook: **on 2.x the lines appear
inside the user's message text**, as if the user had written them, and stay in the history. Silent everywhere else, off with `CRAFT_ROLE_HOOK=0` or a `craft-role-hook: off` line in
`AGENTS.md` / `CLAUDE.md`. Each firing appends one line to `~/.craft/hooks.jsonl`. No permission or
tool-call interception. It talks only to the local opencode server and opens no ports. Its decision
is the `craft` binary of the plugin's version (`craft hook opencode-message`), run from
`~/.craft/bin/<version>/`; when that is not there yet and the repo declares roles or rules (the switch
on), the hook starts its download in the background, at most once an hour (`bin/craft --ensure
--background`, from the GitHub release, its SHA-256 checked) — its one outbound call; a failed
download is said once, as a line in the message part asking the model to tell you (a plugin has no
line of its own in OpenCode), with its log `~/.craft/bin/<version>.log`. Installed project-scoped by default. If the binary fails, the hook
is silent and the tools still work.

## Parity caveats

- Skill sub-files aren't first-class bundled in opencode — the agent reads them by path on demand.
- `craft:` namespace prefixes in skill bodies are cosmetic here (skill name = bare dir); the model
  still resolves them.
- Workflow determinism rides on opencode's child-session API; the plugin retries sequentially and
  surfaces a clear error if a child session is stuck (opencode #8528 / #6573).
- **On 2.x the child-session reply is read as a probe saw it, not yet in a review.** The plugin admits
  the prompt and reads the session's context until it ends with an `idle` entry; the reply is the last
  assistant message before it when its outcome is `succeeded`, and any other outcome is the child's
  error. That shape
  was seen on opencode 2.2.7 by a probe; a craft review's child sessions have not been seen yet.
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
