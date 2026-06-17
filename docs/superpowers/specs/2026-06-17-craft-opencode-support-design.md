# Design — craft support for opencode

**Date:** 2026-06-17
**Status:** Approved design, ready for implementation plan
**Author:** Nick

## Problem

`craft` ships as a **Claude Code plugin**: 24 Rust/process **skills** (`skills/*/SKILL.md`),
4 review **agents** (`agents/*.md`), and 2 orchestration **workflows** (`workflows/*.js` on
Claude Code's `Workflow`/`agent()` runtime), packaged via `.claude-plugin/`. None of it loads
in **opencode** ([opencode.ai](https://opencode.ai)), an open-source, provider-agnostic AI
coding agent with a different — but overlapping — extension model.

This design makes craft usable from opencode at **full parity** (skills + agents + workflows),
adding a **contained adapter layer** under a new `opencode/` subtree without changing anything
on the Claude Code side.

## What opencode gives us (verified)

| craft artifact | opencode counterpart | Gap |
|---|---|---|
| Skills (`skills/<n>/SKILL.md`, Anthropic spec) | **Native** skill support; scans `.opencode/skills/`, `~/.config/opencode/skills/`, plus `.claude/skills/` fallbacks; SKILL.md takes `name`+`description`, ignores unknown fields; exposed via a `skill` tool, auto-routed by description | No first-class **sub-file bundling**; no `allowed-tools` (tool gating moves to `opencode.json` `permission`); skill name = bare dir (no `craft:` namespace) |
| Agents (`agents/<n>.md`) | Custom agents in `.opencode/agents/` (**plural**); frontmatter differs | `tools:` is a **map of booleans** (`{write:false}`) not an array; adds `mode` (`primary`/`subagent`/`all`), `model: provider/id`, `temperature`, `hidden`; primary dispatches subagents via the native **`task` tool** or `@mention` |
| Workflows (`workflows/*.js`) | **No `Workflow` runtime.** Orchestration primitives: the `task` tool (prompt-driven) or a **TS/Bun plugin** that drives child sessions via the SDK (`client.session.create({parentID})` + `client.session.prompt({agent})`) | Plugin route is the only deterministic option; child-session execution has open upstream bugs (#8528, #6573) |
| `.claude-plugin/` packaging + `superpowers` dependency | No bundle marketplace. Plugins = npm packages (`opencode.json` `"plugin"` array); skills/agents/commands = a **file tree** cloned/symlinked into `.opencode/` or `~/.config/opencode/`. No dependency mechanism for non-plugin artifacts | superpowers must be installed separately or degraded |

## Goals

- Full parity in opencode: the 24 skills, the 4 review agents, and both workflows
  (`rust-audit`, `triage-findings`) all usable.
- **Single source of truth** for skills — shared verbatim, zero duplication (craft's
  "no duplication" ethos).
- The opencode integration is **contained**: opt-in, inert on unrelated sessions, local-only,
  and invisible to the Claude Code loader.

## Non-goals

- No change to `skills/`, `agents/`, `workflows/`, or `.claude-plugin/`.
- Not vendoring superpowers — documented co-requisite + graceful degradation instead.
- Not publishing to any opencode registry in this pass (install is symlink + `opencode.json`).
- Not re-deriving any rubric: opencode agents/workflows reuse the existing skills.

## Locked decisions

| # | Decision |
|---|---|
| 1 | **Scope = full parity** — skills + agents + workflows. |
| 2 | **Sync model = shared files + thin adapters.** Skills shared single-source; only agents + workflows get host-specific adapter files under `opencode/`. |
| 3 | **Workflows = TS/Bun plugin** (deterministic, child-session orchestration) — not the prompt-driven `task`-tool command. Determinism chosen over simplicity. |
| 4 | **superpowers = documented co-requisite + graceful degradation.** README tells the user to symlink superpowers' skills too (same Anthropic spec); if absent, only generic-process deferrals go inert — the Rust knowledge is self-contained. |
| 5 | **Containment ("не торчит наружу")** is a first-class principle — see below. |
| 6 | **Model strategy applied to both hosts** — see § Model strategy. opencode agents **inherit** the session model (provider-agnostic); Claude Code agents **differentiate** (`rust-architecture-reviewer` → `opus`, others → `sonnet`); the `rust-audit` workflow runs the scout cheap (Haiku / low effort) and synthesis at medium effort. |

## Containment principle

opencode plugins load globally and their hooks fire on **every** session. craft's plugin must
not "stick out":

- **Opt-in only, zero global hooks.** The plugin registers **only** two tools (`rust-audit`,
  `triage-findings`) via the `tool` hook. It installs **none** of `event` / `chat.message` /
  `chat.params` / `tool.execute.before|after` / `permission.ask`. It is completely inert until
  one of its tools is explicitly invoked.
- **Hidden subagents.** The 4 review agents are `mode: subagent` + `hidden: true` → absent from
  `@`-autocomplete and the primary-agent picker.
- **Local-only.** The plugin talks solely to the local opencode server via the injected
  `client`. No ports opened, no outbound network, no telemetry.
- **Project-scoped by default.** `install.sh` defaults to `--project` (writes into `.opencode/`);
  `--global` (`~/.config/opencode/`) is an explicit opt-in. craft appears only where invited.
- **Invisible to Claude Code.** `opencode/` sits outside the dirs the Claude Code loader scans
  (`.claude-plugin/`, top-level `skills/`/`agents/`/`workflows/`), so it cannot leak into the
  existing plugin surface.

## Architecture

```
craft/
├── skills/  agents/  workflows/  .claude-plugin/   # UNCHANGED
└── opencode/                                        # NEW — contained adapter layer
    ├── agents/
    │   ├── rust-reviewer.md
    │   ├── rust-architecture-reviewer.md
    │   ├── rust-security-scanner.md
    │   └── rust-miri.md
    ├── plugin/
    │   ├── package.json            # deps: @opencode-ai/plugin, @opencode-ai/sdk (Bun installs on startup)
    │   ├── index.ts                # entry: registers ONLY the 2 tools; NO global hooks
    │   ├── orchestrator.ts         # shared child-session fan-out helper (+ sequential fallback)
    │   ├── rust-audit.ts           # scout → reviewers → synthesize
    │   └── triage-findings.ts      # gather → validate per finding → ordered plan
    ├── commands/
    │   ├── rust-audit.md           # /rust-audit → invokes the plugin tool (UX entry)
    │   └── triage-findings.md
    ├── install.sh                  # symlinks skills/agents/commands/plugin into the opencode tree
    └── README.md                   # install, usage, parity caveats, containment, superpowers
```

### Component 1 — Skills (shared, zero duplication)

- `install.sh` symlinks each `skills/<name>` directory into the target opencode skills dir
  (`.opencode/skills/<name>` or `~/.config/opencode/skills/<name>`). Per-skill symlinks (not a
  single parent symlink) so the target dir can hold other skills.
- Sub-files ride along inside the symlinked directory; SKILL.md references resolve when the
  agent `Read`s them by relative path (opencode has no bundling, but this degrades gracefully).
- No frontmatter edits needed: craft skill names are already valid (lowercase-hyphen, match the
  directory) and opencode ignores extra fields.

### Component 2 — Agents (thin translated adapters)

Four hand-written opencode agent files mirroring `agents/*.md`. Translation rule:

| Claude Code | opencode |
|---|---|
| `tools: ["Read","Grep","Glob","Bash"]` | `tools: { write: false, edit: false }` (read/grep/glob/bash allowed by default; mutation denied) |
| `model: sonnet` | **omit `model`** → inherits the opencode session model (provider-agnostic; no Anthropic ID hardcoded). Per-task tier guidance lives in the README — see § Model strategy. |
| — | `mode: subagent` |
| — | `hidden: true` |

Bodies are reused near-verbatim from the Claude Code agents (workflow steps + output format);
"load the rust-review skill" maps onto opencode's native `skill` tool call. This ~4-short-body
duplication **is** the thin adapter. (Optional future cleanup, out of scope here: hoist agent
instructions into the rubric skills so both hosts' agent files become pointers.)

### Component 3 — Workflows (TS/Bun plugin, deterministic)

The plugin's `index.ts` returns an object with a single `tool` hook registering two tools, and
**no other hooks**. Each tool drives the fan-out through child sessions:

**`rust-audit`** (mirrors `workflows/rust-audit.js`):
1. **Scout** — detect the diff base (`args.base` → `merge-base HEAD origin/main` → `main` →
   `HEAD~1`) and whether the workspace contains `unsafe` (via `$` shell).
2. **Fan out** — for each of `rust-reviewer`, `rust-architecture-reviewer`,
   `rust-security-scanner`, and (only if `unsafe` present) `rust-miri`: create a child session
   (`client.session.create({ body: { parentID, title } })`) and prompt it
   (`client.session.prompt({ path, body: { agent, parts } })`), collecting each verdict.
3. **Synthesize** — one severity-ranked report, same shape as the JS workflow's output.

**`triage-findings`** (mirrors `workflows/triage-findings.js`):
gather findings from the locator `args` → validate each finding in its own child session
(parallel) → barrier → render one ordered fix plan (writing-plans format) + triage ledger.
No edits.

**Resilience to upstream bugs.** `orchestrator.ts` wraps the child-session calls: it issues the
fan-out concurrently, and if a child session is created but never executes (the #8528/#6573
failure mode) within a timeout, it **falls back to sequential dispatch** (one child at a time)
and, if that also fails, surfaces a clear actionable error naming the opencode version. A
single-version bug must not silently brick the audit.

### Component 4 — Commands (UX entry points)

Thin `opencode/commands/{rust-audit,triage-findings}.md`. Each command's `template` body simply
instructs the agent to invoke the corresponding plugin tool, passing `$ARGUMENTS` through (e.g.
the diff base or the findings locator). This gives users `/rust-audit` ergonomics over the
plugin tools.

### Component 5 — install.sh

Idempotent shell installer:
- `--project` (default): target = `./.opencode`; `--global`: target = `~/.config/opencode`.
- Symlink `skills/*` → `<target>/skills/`, `opencode/agents/*` → `<target>/agents/`,
  `opencode/commands/*` → `<target>/commands/`, and `opencode/plugin/*` → `<target>/plugins/`
  (opencode **auto-loads** the `plugins/` directory and Bun runs the `.ts` directly — no build
  step; Bun installs the plugin's `package.json` deps on startup). The npm-package /
  `opencode.json` `"plugin"` array route is left for a future published release.
- Re-runnable: existing correct symlinks are left alone; stale ones repointed.
- Prints a post-install note: how to also symlink superpowers skills, and how to invoke.

## Model strategy

Match the model tier to the **cognitive demand of the stage**, and use the reasoning `effort`
knob (low → xhigh → max) as the fine control — often cheaper than jumping a tier. Tiers and
pricing (input/output per 1M tok): **Fable 5** $10/$50 · **Opus 4.8** $5/$25 · **Sonnet 4.6**
$3/$15 · **Haiku 4.5** $1/$5. Fable 5 is overkill for craft's rubric-driven tasks.

| Component | Demand | Target | Effort |
|---|---|---|---|
| `rust-architecture-reviewer` | Heaviest — whole dependency graph, layering/over-engineering judgement | **top tier** (Opus 4.8) | high/xhigh |
| `rust-reviewer` | Rubric + subtle-bug hunting on a diff | Sonnet 4.6 default; Opus when bug-finding is critical | high |
| `rust-security-scanner` | Run tools + consolidate | Sonnet 4.6 | medium |
| `rust-miri` | Interpret bounded UB output | Sonnet 4.6 (Opus on gnarly UB) | medium |
| workflow **scout** (diff base, grep unsafe) | Pure mechanics | **Haiku 4.5** | low |
| workflow **synthesis** (merge/dedup/rank verdicts) | Moderate | Sonnet 4.6 | medium |
| skills | — | inherit the active session model | — |

Two craft-specific notes baked into this strategy:

1. **Over-report, filter downstream.** Opus 4.8/4.7 follow "report only high-severity"
   *literally*, which depresses measured recall. craft's find-broad → triage architecture already
   fits: `rust-reviewer` reports everything with severity + confidence, and
   `triage-findings` / `addressing-findings` do the filtering. Reviewer briefs should say
   "coverage, not filtering" — especially on Opus.
2. **`effort` is orthogonal to tier** — raising effort on the same model is often the better
   lever than swapping tiers.

**Applied to both hosts:**

- **opencode** — the 4 agent adapters **omit `model`** and inherit the user's configured session
  model (provider-agnostic; respects containment — we don't impose Anthropic). The per-task tier
  table above ships in the README as guidance ("run the architecture audit on your strongest
  model / high effort"). The plugin does **not** override the model when prompting child sessions —
  each child uses its agent's own config.
- **Claude Code** (existing artifacts, applied in this change) — Anthropic is fixed here, so
  differentiate: `agents/rust-architecture-reviewer.md` pinned to `model: opus` (others stay
  `sonnet`); `workflows/rust-audit.js` runs the scout `agent()` on `model: 'haiku', effort: 'low'`
  and the synthesis `agent()` on `effort: 'medium'`. Agents dispatched by `agentType` inherit their
  own file's `model`, so no per-call model override is needed for the reviewers.

## Data flow

```
user: /rust-audit origin/main
  → opencode command rust-audit.md  (template invokes plugin tool, passes $ARGUMENTS)
    → plugin tool rust-audit(args)            [registered via `tool` hook, local-only]
      → scout: diff base + unsafe?            [$ shell]
      → fan out child sessions:               [client.session.create/prompt, agent=…]
          rust-reviewer · rust-architecture-reviewer · rust-security-scanner · (rust-miri?)
            each child loads its rubric skill via the `skill` tool
      → (on child-exec failure → sequential fallback)
      → synthesize one severity-ranked report → returned as the tool result
```

## Parity caveats (documented in README)

1. **Skill sub-files** aren't first-class-bundled — the agent `Read`s them by path. Fidelity is
   preserved; discovery is by reference, not by manifest.
2. **`craft:` / `superpowers:` namespace prefixes** in skill bodies are cosmetic in opencode
   (skill tool name = bare dir). The model still resolves "the rust-testing skill."
3. **Workflow determinism** depends on opencode's child-session API; the sequential fallback
   covers the known bugs but a hard upstream regression could degrade fan-out to sequential.
4. **superpowers** must be installed alongside for the generic-process deferrals to resolve;
   without it craft still works, minus those deferrals.

## Testing strategy

- **Skills** — after `install.sh --project`, assert opencode discovers all 24 (skill tool lists
  them); spot-check that a SKILL.md referencing a sub-file gets the sub-file `Read` on demand.
- **Agents** — assert the 4 appear as hidden subagents and are dispatchable via `task`/`@`; run
  `rust-reviewer` against a tiny fixture diff and confirm a verdict.
- **Plugin containment** — assert that with the plugin loaded, an unrelated session triggers
  none of its code (no global hooks); the tools appear but stay inert until invoked.
- **Workflows** — run `/rust-audit` on a fixture crate (one with `unsafe`, one without) and
  confirm the right agent set fans out and a synthesized report returns; simulate a stuck child
  session and confirm the sequential fallback engages.
- **install.sh** — idempotency (run twice, no diff); `--project` vs `--global` targets;
  `opencode.json` merge preserves pre-existing config.

## Out of scope / future

- Publishing the plugin to npm / any opencode registry (this pass: local path + symlink).
- Hoisting agent instructions into skills to remove the 4-body duplication.
- A prompt-driven `task`-tool fallback command (kept as a documented alternative if the plugin
  route proves too fragile on a given opencode version).
- Auto-generating opencode agent frontmatter from the Claude Code agents (the rejected
  "generator" sync model).
