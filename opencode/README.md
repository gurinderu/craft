# craft for opencode

This subtree makes the craft Rust skills, review agents, and audit/triage workflows usable from
[opencode](https://opencode.ai). The Claude Code surface is unchanged — this is a thin, contained
adapter layer.

## Install

From the repo root, symlink the adapters into an opencode tree:

```bash
opencode/install.sh            # project-scoped: ./.opencode  (default)
opencode/install.sh --global   # ~/.config/opencode
```

Then restart opencode (or reopen the project) so it rescans `skills/`, `agents/`, `commands/`,
and `plugins/`.

### Plugin dependencies

opencode auto-loads the plugin from `plugins/craft-rust` and Bun installs its `package.json`
dependencies on startup. If your opencode version doesn't auto-install them, add
`@opencode-ai/plugin` and `@opencode-ai/sdk` to your opencode tree's `package.json` and restart.

## Use

- **Skills** — auto-discovered; opencode's `skill` tool lists all of craft's skills and routes by description.
- **Agents** — `rust-reviewer`, `rust-architecture-reviewer`, `rust-security-scanner`, `rust-miri`
  are hidden subagents (they don't clutter `@`-autocomplete); the workflows dispatch them.
- **Workflows** — `/rust-audit [base-ref]` and `/triage-findings <locator>`.

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

The plugin registers the two workflow tools and one narrow hook: craft's hook at the moment of work.
Its `event` hook only remembers which sessions are subagents' and notes compactions; its
`chat.message` hook only appends a short synthetic text part to a message asking for review work
(findings, PR comments, a review), in a repo that declares its own agents or work rules, once per
session — silent everywhere else, off with `CRAFT_ROLE_HOOK=0` or a `craft-role-hook: off` line in
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
- **No elastic `rust-review` engine.** The Claude Code `rust-review` workflow (scout-scaled lens
  fan-out, loop-until-dry, adversarial + self-verification) has no opencode port. In `/rust-audit`
  the **review** dimension is a single-pass `rust-reviewer` agent — there is no per-crate review
  fan-out and no inter-crate-contract dimension. The other audit dimensions (architecture,
  security, miri, crate-decomposition, semver, build-matrix, deps, unused-crates, tests-cov) do run.
- **Observability is a deterministic subset.** `/rust-audit` and `/triage-findings` write a run
  record to the shared `~/.craft/runs/` store (`runtime: "opencode"`), straight from the plugin —
  no logger agent. Because opencode agents return free text (not schema-validated JSON), the record
  captures `ts`/`project`/`commit`/`dirty`, which dimensions ran vs `notRun`, and a `verdict` parsed
  from the synthesis text — but NOT `findings.bySeverity` or `outputTokens` (`findings` is `null`).
  The hidden review agents do not self-log, so a standalone hidden-agent invocation is not recorded.
- **triage `conflict` semantics differ.** In `opencode/plugin/triage-findings.ts` the per-finding
  validation may itself return a `conflict` verdict (validate and plan logic are merged into one
  call); the Claude Code `triage-findings.js` reserves `conflict` for the separate Plan phase.
