# craft for opencode

This subtree makes the craft Rust skills, review agents, and audit/triage workflows usable from
[opencode](https://opencode.ai). The Claude Code surface is unchanged — this is a thin, contained
adapter layer.

## Install

From the repo root, symlink the adapters into an opencode tree:

```bash
integrations/opencode/install.sh            # project-scoped: ./.opencode  (default)
integrations/opencode/install.sh --global   # ~/.config/opencode
```

Then restart opencode (or reopen the project) so it rescans `skills/`, `agents/`, `commands/`,
and `plugins/`.

### OpenCode 1.x and 2.x

One plugin serves both lines: its default export carries a 1.x entry (`server`) and a 2.x entry
(`setup`), and each runtime reads its own. Both were seen loading it — opencode 1.19.5 and 2.2.7.

### Plugin dependencies

opencode loads the plugin from `plugins/craft-rust.ts`, a link to `plugin/index.ts` (1.x loads only
files from `plugins/`, not directories). opencode 2.x does not install a plugin
directory's dependencies, so `install.sh` runs `npm ci --omit=dev` in `integrations/opencode/plugin`
whenever the installed tree is missing or older than `package-lock.json`; without npm, run it there
yourself before starting opencode.

## Upgrading

After `git pull` (or checking out a new tag), rerun `install.sh` with the same scope, then restart
opencode. The links point into this checkout, but a pull does not change what is linked:

- it relinks the plugin as one file, `plugins/craft-rust.ts` — opencode 1.x never loads the older
  directory link, so without the rerun the plugin silently stops loading there;
- it installs the plugin's locked dependencies again (`npm ci --omit=dev`) — opencode 2.x does not;
- it links agents and commands added since the last install (`review-task`, `/review`) — they are
  linked file by file, so a new one is missing until the rerun — and removes its links whose target
  is gone or no longer installed (`codex-review`, the old plugin directory link).

`/review` refuses to start when the `review-task` agent is missing and says to rerun `install.sh`.

## Use

- **Skills** — auto-discovered; opencode's `skill` tool lists all of craft's skills and routes by description.
  `install.sh` leaves out `develop` and `codex-review`, which drive the review through Claude Code's
  Workflow tool and `codex exec`; in OpenCode the review is `/review`.
- **Agents** — `rust-reviewer`, `rust-architecture-reviewer`, `rust-security-scanner`, `rust-miri`
  and `review-task` are hidden subagents (they don't clutter `@`-autocomplete); the workflows dispatch
  them. `review-task` exists only for `/review`'s tasks.
- **Workflows** — `/rust-audit [base-ref]`, `/triage-findings <locator>` and `/review [key=value ...]`.
  Each workflow's child sessions nest under the session that called it.

## Review

`/review` runs craft's review through the `review` tool. The `craft` binary decides every step —
the gate, the scouts, the lenses round after round, verification, the verdict — and the tool runs
each step's tasks as child sessions, writes each task's final JSON message to the answer file the
binary named, and hands the batch back until the binary is done. The answer is the binary's
`## Verdict` block. This route is new: it is covered by tests against a fake binary and fake
sessions, and has not yet been seen in a real OpenCode session.

- Every task is read-only: one that names `rust-reviewer` runs on the hidden `rust-reviewer` agent,
  every other on the hidden `review-task` agent (both have write and edit off), with the matching
  Claude Code agent's prompt (or the reviewed repository's own `.claude/agents/<name>.md`) before the
  task. A task still runs read-only commands (git, grep, the build's own checks) through bash.
- Each task's child session nests under the session that called `/review`.
- Models: each task runs on the calling session's model — the one that session recorded: on 1.x its
  newest message's, on 2.x the model set on the session; when it recorded none, OpenCode's default —
  unless `opencodeModels=` maps the binary's tiers —
  one `provider/model` for all, or `opus=provider/model,haiku=provider/model` (env
  `CRAFT_OPENCODE_MODELS`). `concurrency=<n>` caps the child sessions at once (default 4, env
  `CRAFT_OPENCODE_CONCURRENCY`).
- The review's own arguments are the Claude Code workflow's: `base=`, `pr=`, `repo=`, `depth=`,
  `run=<dir>` to resume a stopped run, `craftBin=` for a local build. The binary is the release of
  this plugin's version, fetched once.
- A task past its deadline is abandoned and its child session stopped (`session.abort` on 1.x,
  `session.interrupt` on 2.x); a failed one is handed out again by the binary; the first usage-limit
  error stops new tasks and ends the run INCOMPLETE with how to resume it.
- A child that answers nothing is tried once more, alone — the same mitigation `/rust-audit` and
  `/triage-findings` use for opencode's child-session bugs (#8528 / #6573).
- If this OpenCode has no `review-task` agent (an install from before it), the review refuses to
  start, INCOMPLETE, and says to rerun `install.sh`; it never runs a task on another, writable agent.
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
- **`/rust-audit`'s review dimension is single-pass.** The CLI-driven review is `/review` (above); in
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
