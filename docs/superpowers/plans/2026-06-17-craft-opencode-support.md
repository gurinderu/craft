# craft opencode Support — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the craft Claude Code plugin usable from opencode at full parity (24 skills, 4 review agents, 2 workflows) via a contained `opencode/` adapter subtree, without changing the existing Claude Code surface.

**Architecture:** Skills are shared verbatim (opencode reads the Anthropic Agent Skills spec natively) by symlink. The 4 review agents become hand-written opencode agent files (frontmatter translation; bodies reuse the rubric skills). The 2 workflows become a single TS/Bun opencode plugin that deterministically fans out child sessions, with a sequential fallback for opencode's known child-session bugs. A symlink `install.sh` wires everything into `.opencode/` (project, default) or `~/.config/opencode/` (global). The plugin is contained: it registers only its two tools and installs **no** global hooks.

**Tech Stack:** Markdown (skills/agents/commands), TypeScript on Bun (`@opencode-ai/plugin`, `@opencode-ai/sdk`), POSIX shell (`install.sh`). Verification uses `python3` (YAML frontmatter), `shellcheck`, and `bun`/`tsc` where available, plus an in-opencode acceptance checklist.

## Global Constraints

- **Spec:** `docs/superpowers/specs/2026-06-17-craft-opencode-support-design.md` — every task implicitly inherits it.
- **No change** to `skills/`, `agents/`, `workflows/`, or `.claude-plugin/` (the model-strategy edits to `agents/rust-architecture-reviewer.md` and `workflows/rust-audit.js` are already committed; do not touch them again).
- **opencode directory names are PLURAL:** `skills/`, `agents/`, `commands/`, `plugins/`. The single most common porting footgun.
- **opencode SKILL.md frontmatter** recognizes only `name` (lowercase-hyphen, ≤64 chars, must equal the dir name), `description` (≤1024 chars), `license`, `compatibility`, `metadata`; unknown fields are ignored. craft skill names are already valid — no skill edits.
- **opencode agent frontmatter:** `tools` is a **map of booleans** (`{write: false}`), not an array. Add `mode: subagent` + `hidden: true`. **Omit `model`** (inherit the session model — provider-agnostic, per § Model strategy in the spec).
- **Containment ("не торчит наружу"):** the plugin registers ONLY the two tools via the `tool` hook; it installs NONE of `event` / `chat.message` / `chat.params` / `tool.execute.before|after` / `permission.ask`. Local-only (talks to the injected `client`; no ports, no outbound network, no telemetry). `install.sh` defaults to `--project`.
- **Work on the `opencode-support` branch** (already checked out). Commit after every task.
- **No Claude/Claude-Code attribution** in commit messages (project CLAUDE.md).
- Where a `@opencode-ai/*` API signature can't be confirmed in-environment, write it per the spec's documented shapes and let the `tsc` typecheck gate catch mismatches; adjust to the installed types. Flagged inline as "confirm against installed types."

---

### Task 1: opencode agent adapters

**Files:**
- Create: `opencode/agents/rust-reviewer.md`
- Create: `opencode/agents/rust-architecture-reviewer.md`
- Create: `opencode/agents/rust-security-scanner.md`
- Create: `opencode/agents/rust-miri.md`
- Create: `opencode/scripts/check-frontmatter.py` (validation helper, reused by later tasks)

**Interfaces:**
- Produces: four opencode agents named `rust-reviewer`, `rust-architecture-reviewer`, `rust-security-scanner`, `rust-miri` (the plugin in Tasks 3-5 prompts child sessions with these `agent` names). Each is `mode: subagent`, `hidden: true`, mutation tools denied, no `model`.

- [ ] **Step 1: Write the validation helper**

Create `opencode/scripts/check-frontmatter.py`:

```python
#!/usr/bin/env python3
"""Validate opencode agent/command/skill frontmatter. Usage: check-frontmatter.py <kind> <file>..."""
import sys, re

def parse_frontmatter(path):
    text = open(path, encoding="utf-8").read()
    m = re.match(r"^---\n(.*?)\n---\n", text, re.DOTALL)
    if not m:
        raise SystemExit(f"{path}: no YAML frontmatter")
    try:
        import yaml
        return yaml.safe_load(m.group(1)) or {}
    except ModuleNotFoundError:
        # Minimal fallback: flat key: value + one level of two-space-indented map.
        data, cur = {}, None
        for line in m.group(1).splitlines():
            if not line.strip() or line.lstrip().startswith("#"):
                continue
            if re.match(r"^\s{2,}\S", line):
                k, _, v = line.strip().partition(":")
                if cur is not None:
                    data.setdefault(cur, {})[k.strip()] = v.strip()
            else:
                k, _, v = line.partition(":")
                v = v.strip()
                if v == "":
                    cur = k.strip(); data[cur] = {}
                else:
                    cur = None; data[k.strip()] = v
        return data

def fail(p, msg): raise SystemExit(f"{p}: {msg}")

def check_agent(p, fm):
    if "description" not in fm: fail(p, "missing description")
    if fm.get("mode") != "subagent": fail(p, "mode must be subagent")
    if fm.get("hidden") not in (True, "true"): fail(p, "hidden must be true")
    if "model" in fm: fail(p, "must NOT pin model (inherit session model)")
    tools = fm.get("tools")
    if not isinstance(tools, dict): fail(p, "tools must be a map, not a list")
    for k in ("write", "edit"):
        if tools.get(k) not in (False, "false"): fail(p, f"tools.{k} must be false")

def check_command(p, fm):
    if "description" not in fm: fail(p, "missing description")
    if "agent" in fm and not isinstance(fm["agent"], str): fail(p, "agent must be a string")

def check_skill(p, fm):
    name = fm.get("name")
    if not name or not re.fullmatch(r"[a-z0-9]+(-[a-z0-9]+)*", str(name)): fail(p, "bad/missing name")
    if "description" not in fm: fail(p, "missing description")

CHECKS = {"agent": check_agent, "command": check_command, "skill": check_skill}

def main():
    kind, files = sys.argv[1], sys.argv[2:]
    for p in files:
        CHECKS[kind](p, parse_frontmatter(p))
        print(f"OK  {p}")

if __name__ == "__main__":
    main()
```

- [ ] **Step 2: Write `opencode/agents/rust-reviewer.md`**

Frontmatter is new; the body is the existing Claude Code reviewer body (it already says "load the rust-review skill", which maps onto opencode's native `skill` tool). Full file:

```markdown
---
description: Expert Rust code reviewer. Runs the cargo quality gate, reviews the diff (changed .rs files) against the rust-review severity rubric, and returns an Approve/Warning/Block verdict. Use to review a Rust change before commit or merge. For whole-project structural audits (not a diff), use rust-architecture-reviewer instead.
mode: subagent
hidden: true
tools:
  write: false
  edit: false
---

You are a senior Rust reviewer. You judge changes; you do not rewrite them. You apply the
`rust-review` skill's rubric — load it (call the `skill` tool with name `rust-review`) for the
full severity checklist and verdict criteria.

## Workflow

1. **Mechanical gate.** Run, in order, and stop at the first failure:
   ```bash
   cargo fmt --check
   cargo clippy --all-targets -- -D warnings
   cargo test            # or: cargo nextest run && cargo test --doc
   if command -v cargo-audit >/dev/null; then cargo audit || echo advisories-found; else echo "cargo-audit not installed"; fi
   if command -v cargo-deny  >/dev/null; then cargo deny check || echo advisories-found; else echo "cargo-deny not installed"; fi
   ```
   If fmt/clippy/test fail → verdict is **Block**: report the failure and stop.

2. **Get the diff.** `git diff --merge-base main -- '*.rs'` for a PR, or `git diff HEAD -- '*.rs'`
   for uncommitted work. Review only the changed `.rs` files (read surrounding context as needed).

3. **Apply the rubric.** Load the `rust-review` skill and walk the diff through its
   CRITICAL → HIGH → MEDIUM tiers. For test-coverage findings, the `rust-testing` skill
   describes how the missing tests should look. Report every finding with its severity and a
   confidence note — coverage, not filtering; a downstream triage step decides what to act on.

4. **Verdict.** End with exactly one of **Approve** ✅ / **Warning** ⚠️ / **Block** ⛔.

## Output format

```
## Gate
fmt ✓ · clippy ✓ · test ✓ · audit ✓

## Findings
⛔ CRITICAL · src/db.rs:42 · SQL built by string interpolation · injection risk · use sqlx bind params
⚠️ MEDIUM   · src/cache.rs:88 · format! in hot loop · per-iteration alloc · reuse a buffer / collect

## Verdict
Block — 1 CRITICAL must be fixed before merge.
```

Every finding cites `severity · file:line · what · why · fix`. No location → not a finding.
Be precise and terse; the value is in catching real issues, not in volume.
```

- [ ] **Step 3: Write `opencode/agents/rust-architecture-reviewer.md`**

```markdown
---
description: Expert Rust architecture auditor. Builds the project's whole dependency graph (crates and modules) and judges its structure against the rust-architecture-review rubric, returning a Healthy/Concerns/At-risk health rating with severity-tiered findings. Judges the whole graph, not a diff — flags both layer leaks and over-engineering. Use to audit a Rust project's structure or assess structural debt. For diff-scoped PR review, use rust-reviewer instead.
mode: subagent
hidden: true
tools:
  write: false
  edit: false
---

You are a senior Rust architecture auditor. You judge the whole project's structure; you do not
rewrite it. Load the `rust-architecture-review` skill (call the `skill` tool with name
`rust-architecture-review`) for the full rubric and the Healthy/Concerns/At-risk criteria.

## Workflow

1. **Build the graph.** Map the crate/module dependency graph (read `Cargo.toml`(s) and the
   module tree; use `cargo metadata` if available).
2. **Judge in both directions.** Walk the rubric: too little structure (dependency cycles,
   inverted dependencies, layer leaks, god modules, anemic domain) AND too much (ghost
   abstractions, over-layering, generic soup).
3. **Rate.** End with exactly one of **Healthy** / **Concerns** / **At-risk**, with
   severity-tiered findings (each `severity · crate/module · what · why · direction`).

> This audit is reasoning-heavy — take the time to hold the whole graph before judging.
```

- [ ] **Step 4: Write `opencode/agents/rust-security-scanner.md`**

```markdown
---
description: Runs the Rust security toolchain (cargo-audit, cargo-deny, cargo-geiger, semgrep), consolidates the findings against the rust-security rubric, and returns a severity-ranked report with an Approve/Warning/Block verdict. Use to security-scan a Rust project or before a release.
mode: subagent
hidden: true
tools:
  write: false
  edit: false
---

You run the Rust security toolchain and consolidate its output; you do not change code. Load the
`rust-security` skill (call the `skill` tool with name `rust-security`) for the rubric.

## Workflow

1. **Run whatever is installed**, skipping (and noting) any tool that is absent:
   ```bash
   command -v cargo-audit  >/dev/null && cargo audit            || echo "cargo-audit absent"
   command -v cargo-deny   >/dev/null && cargo deny check       || echo "cargo-deny absent"
   command -v cargo-geiger >/dev/null && cargo geiger           || echo "cargo-geiger absent"
   command -v semgrep      >/dev/null && semgrep --config auto . || echo "semgrep absent"
   ```
2. **Consolidate** into a severity-ranked report against the rubric.
3. **Verdict.** End with exactly one of **Approve** ✅ / **Warning** ⚠️ / **Block** ⛔. Note which
   tools were absent so a clean run isn't mistaken for full coverage.
```

- [ ] **Step 5: Write `opencode/agents/rust-miri.md`**

```markdown
---
description: Runs the unsafe code under Miri to detect undefined behavior (out-of-bounds, use-after-free, alignment violations, data races, leaks) and reports what it finds against the rust-unsafe rubric. Use for crates containing unsafe code, after writing/changing unsafe, or before releasing a crate with unsafe.
mode: subagent
hidden: true
tools:
  write: false
  edit: false
---

You run the unsafe code under Miri and interpret the result; you do not change code. Load the
`rust-unsafe` skill (call the `skill` tool with name `rust-unsafe`) for the rubric.

## Workflow

1. **Run Miri:**
   ```bash
   cargo +nightly miri test
   ```
   If the nightly toolchain or Miri component is missing, report that and stop (verdict: cannot run).
2. **Interpret** any UB Miri reports (out-of-bounds, use-after-free, alignment, data race, leak)
   against the rubric — explain the violated invariant and the direction of the fix.
3. **Verdict.** End with exactly one of **Clean** / **UB-found**.
```

- [ ] **Step 6: Validate the four agent files**

Run:
```bash
chmod +x opencode/scripts/check-frontmatter.py
python3 opencode/scripts/check-frontmatter.py agent opencode/agents/*.md
```
Expected: four `OK  opencode/agents/...md` lines, exit 0. (Failure prints the first offending file + reason.)

- [ ] **Step 7: Confirm containment fields by grep**

Run:
```bash
grep -L 'hidden: true' opencode/agents/*.md; grep -l '^model:' opencode/agents/*.md; echo "rc=$?"
```
Expected: no output from the first `grep -L` (all files have `hidden: true`); no file listed by `grep -l '^model:'` (none pin a model). Any filename printed is a failure.

- [ ] **Step 8: Commit**

```bash
git add opencode/agents opencode/scripts/check-frontmatter.py
git commit -m "feat(opencode): add the four review agent adapters"
```

---

### Task 2: install.sh symlink installer

**Files:**
- Create: `opencode/install.sh`

**Interfaces:**
- Consumes: `opencode/agents/*.md` (Task 1), and (created in later tasks, but referenced here) `opencode/commands/*.md`, `opencode/plugin/`, and the repo-root `skills/`. The script tolerates not-yet-existing `commands`/`plugin` so it can be tested now and stays correct later.
- Produces: symlinks under the target opencode tree: `<target>/skills/<name>` → repo `skills/<name>`, `<target>/agents/<f>` → `opencode/agents/<f>`, `<target>/commands/<f>` → `opencode/commands/<f>`, and `<target>/plugins/craft-rust` → `opencode/plugin`.

- [ ] **Step 1: Write `opencode/install.sh`**

```bash
#!/usr/bin/env bash
# Install craft's opencode adapters by symlinking them into an opencode tree.
# Usage: opencode/install.sh [--project | --global]   (default: --project)
set -euo pipefail

# Repo root = parent of this script's dir (opencode/), so the script works from anywhere.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

SCOPE="project"
for arg in "$@"; do
  case "$arg" in
    --project) SCOPE="project" ;;
    --global)  SCOPE="global" ;;
    -h|--help) echo "usage: $0 [--project|--global]"; exit 0 ;;
    *) echo "unknown arg: $arg" >&2; exit 2 ;;
  esac
done

if [ "$SCOPE" = "global" ]; then
  TARGET="${XDG_CONFIG_HOME:-$HOME/.config}/opencode"
else
  TARGET="$PWD/.opencode"
fi

# Idempotent symlink: repoint if wrong, leave alone if already correct, never clobber a real file.
link() {  # link <source> <destination>
  local src="$1" dst="$2"
  mkdir -p "$(dirname "$dst")"
  if [ -L "$dst" ]; then
    [ "$(readlink "$dst")" = "$src" ] && { echo "  = $dst"; return; }
    rm "$dst"
  elif [ -e "$dst" ]; then
    echo "  ! $dst exists and is not our symlink — skipping" >&2; return
  fi
  ln -s "$src" "$dst"; echo "  + $dst -> $src"
}

echo "Installing craft opencode adapters into: $TARGET  (scope: $SCOPE)"

# Skills — one symlink per skill dir (target dir may hold other skills).
for d in "$REPO_ROOT"/skills/*/; do
  [ -f "$d/SKILL.md" ] || continue
  link "${d%/}" "$TARGET/skills/$(basename "$d")"
done

# Agents + commands — one symlink per markdown file.
for f in "$SCRIPT_DIR"/agents/*.md;   do [ -e "$f" ] && link "$f" "$TARGET/agents/$(basename "$f")"; done
for f in "$SCRIPT_DIR"/commands/*.md; do [ -e "$f" ] && link "$f" "$TARGET/commands/$(basename "$f")"; done

# Plugin — symlink the whole directory as ONE plugin (opencode auto-loads it from plugins/).
[ -d "$SCRIPT_DIR/plugin" ] && link "$SCRIPT_DIR/plugin" "$TARGET/plugins/craft-rust"

cat <<EOF

Done.
  • Restart opencode (or reopen the project) so it rescans skills/agents/commands/plugins.
  • superpowers co-requisite: craft skills reference superpowers:* skills. Install those the same
    way (symlink their skill dirs into "$TARGET/skills/") for full parity; without them craft still
    works, only the generic-process deferrals go inert.
  • If opencode does not auto-install the plugin's deps, add @opencode-ai/plugin and
    @opencode-ai/sdk to "$TARGET/package.json" and restart. See opencode/README.md.
EOF
```

- [ ] **Step 2: Lint the script (if shellcheck is available)**

Run:
```bash
chmod +x opencode/install.sh
command -v shellcheck >/dev/null && shellcheck opencode/install.sh || echo "shellcheck absent — skipping lint"
```
Expected: no shellcheck findings (or the "absent" notice). Fix any finding before continuing.

- [ ] **Step 3: Run it into a throwaway target and assert symlinks (project scope)**

Run:
```bash
tmp="$(mktemp -d)"; ( cd "$tmp" && bash "$OLDPWD/opencode/install.sh" --project )
ls -l "$tmp/.opencode/agents" | grep -q rust-reviewer.md && echo "agents OK"
test -L "$tmp/.opencode/skills/rust-review" && echo "skills OK"
test -L "$tmp/.opencode/plugins/craft-rust" && echo "plugin OK"
```
Expected: `agents OK`, `skills OK`, `plugin OK`. (Note: `OLDPWD` is the repo root because the subshell `cd`s into `$tmp`; if your shell doesn't set it, replace `$OLDPWD` with the absolute repo path.)

- [ ] **Step 4: Re-run for idempotency**

Run:
```bash
( cd "$tmp" && bash "$OLDPWD/opencode/install.sh" --project ) | grep -q '= ' && echo "idempotent (existing links left in place)"
rm -rf "$tmp"
```
Expected: `idempotent (existing links left in place)` — the second run prints `=` lines, not `+`, and exits 0.

- [ ] **Step 5: Commit**

```bash
git add opencode/install.sh
git commit -m "feat(opencode): add symlink installer (--project default, --global opt-in)"
```

---

### Task 3: plugin scaffold + containment contract

**Files:**
- Create: `opencode/plugin/package.json`
- Create: `opencode/plugin/.gitignore`
- Create: `opencode/plugin/index.ts`

**Interfaces:**
- Consumes: `runRustAudit(ctx, args)` and `runTriageFindings(ctx, args)` (defined in Tasks 5-6).
- Produces: a default-exported opencode `Plugin` that registers exactly two tools — `rust-audit` and `triage-findings` — via the `tool` hook, and NO other hooks. Also exports the `PluginCtx` type `{ client, $, directory, worktree }` consumed by Tasks 4-6.

- [ ] **Step 1: Write `opencode/plugin/package.json`**

```json
{
  "name": "craft-rust-opencode",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "description": "craft's Rust audit/triage workflows as a contained opencode plugin.",
  "dependencies": {
    "@opencode-ai/plugin": "*",
    "@opencode-ai/sdk": "*"
  },
  "devDependencies": {
    "typescript": "^5"
  }
}
```

- [ ] **Step 2: Write `opencode/plugin/.gitignore`**

```gitignore
node_modules/
bun.lockb
*.tsbuildinfo
```

- [ ] **Step 3: Write `opencode/plugin/index.ts`**

```typescript
// craft-rust opencode plugin — CONTAINED:
//   • registers ONLY the two craft workflow tools (via the `tool` hook)
//   • installs NONE of: event / chat.message / chat.params / tool.execute.* / permission.ask
//   • talks only to the injected local `client`; opens no ports, no outbound network, no telemetry
//   • the 4 review subagents stay hidden (their own frontmatter: hidden: true)
//
// Signatures follow the opencode docs; if the installed @opencode-ai/* types differ, `tsc` will
// flag it — adjust to the installed types (the shapes here are the documented ones).
import type { Plugin } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin"
import { runRustAudit } from "./rust-audit.ts"
import { runTriageFindings } from "./triage-findings.ts"

// The subset of the plugin input that our orchestration needs.
export interface PluginCtx {
  client: any        // @opencode-ai/sdk client (session.create / session.prompt)
  $: any             // Bun shell ($`...`)
  directory: string
  worktree: string
}

const CraftRustPlugin: Plugin = async ({ client, $, directory, worktree }) => {
  const ctx: PluginCtx = { client, $, directory, worktree }
  return {
    // ONLY this hook. No global hooks → inert on every unrelated session.
    tool: {
      "rust-audit": tool({
        description:
          "Full Rust crate audit: fan out the craft review agents (reviewer, architecture, security, and Miri if unsafe is present) and synthesize one severity-ranked report. Optional arg `base` fixes the diff base ref.",
        args: { base: tool.schema.string().optional() },
        async execute(args: { base?: string }) {
          return await runRustAudit(ctx, args)
        },
      }),
      "triage-findings": tool({
        description:
          "Validate review findings against the code and render one ordered fix plan + triage ledger (no edits). Arg `locator` points at the findings source (a report path, PR ref, or pasted findings).",
        args: { locator: tool.schema.string() },
        async execute(args: { locator: string }) {
          return await runTriageFindings(ctx, args)
        },
      }),
    },
  }
}

export default CraftRustPlugin
```

- [ ] **Step 4: Add minimal stubs so the scaffold typechecks in isolation**

So Task 3 is independently testable before Tasks 4-6 exist, create temporary one-line stubs (Tasks 5-6 replace them with full files). Create `opencode/plugin/rust-audit.ts`:

```typescript
import type { PluginCtx } from "./index.ts"
export async function runRustAudit(_ctx: PluginCtx, _args: { base?: string }): Promise<string> {
  return "stub"
}
```

Create `opencode/plugin/triage-findings.ts`:

```typescript
import type { PluginCtx } from "./index.ts"
export async function runTriageFindings(_ctx: PluginCtx, _args: { locator: string }): Promise<string> {
  return "stub"
}
```

- [ ] **Step 5: Structural containment check (no global hooks)**

Run:
```bash
grep -Eq '\b(event|chat\.message|chat\.params|permission\.ask|tool\.execute)\b' opencode/plugin/index.ts \
  && { echo "FAIL: a forbidden global hook is present"; exit 1; } \
  || echo "containment OK: only the tool hook is registered"
grep -c 'tool(' opencode/plugin/index.ts   # expect 2 tool() registrations (rust-audit, triage-findings)
```
Expected: `containment OK: ...`, and the count is `2`.

- [ ] **Step 6: Typecheck (if a toolchain is available)**

Run:
```bash
cd opencode/plugin
if command -v bun >/dev/null; then
  bun install >/dev/null 2>&1 && bunx tsc --noEmit --moduleResolution bundler --module esnext --target esnext --strict false index.ts && echo "tsc OK"
elif command -v npx >/dev/null; then
  npm install >/dev/null 2>&1 && npx tsc --noEmit --moduleResolution bundler --module esnext --target esnext --strict false index.ts && echo "tsc OK"
else
  echo "no bun/npx — skipping typecheck (structural check covered it)"
fi
cd - >/dev/null
```
Expected: `tsc OK`, or the skip notice. If `tsc` reports a signature mismatch against the installed `@opencode-ai/*` types, adjust the `tool` / `Plugin` usage to match and re-run.

- [ ] **Step 7: Commit**

```bash
git add opencode/plugin/package.json opencode/plugin/.gitignore opencode/plugin/index.ts opencode/plugin/rust-audit.ts opencode/plugin/triage-findings.ts
git commit -m "feat(opencode): plugin scaffold — register two tools, zero global hooks"
```

---

### Task 4: orchestrator — child-session fan-out + sequential fallback

**Files:**
- Create: `opencode/plugin/orchestrator.ts`

**Interfaces:**
- Consumes: `PluginCtx` (Task 3).
- Produces:
  - `runAgent(ctx, agentName, prompt): Promise<string>` — create a child session and prompt it with the named hidden agent; returns the agent's final text.
  - `fanOut(ctx, jobs): Promise<Array<{ label: string; ok: boolean; text: string }>>` where `jobs: Array<{ label: string; agent: string; prompt: string }>`. Tries all jobs concurrently; if a child session is created but produces no output within `STUCK_MS`, retries the failed jobs sequentially; surfaces a clear error per job that still fails. Consumed by Tasks 5-6.

- [ ] **Step 1: Write `opencode/plugin/orchestrator.ts`**

```typescript
// Deterministic child-session fan-out with a sequential fallback for opencode's known
// child-session execution bugs (anomalyco/opencode #8528, sst/opencode #6573): if a child
// session is created but never executes within STUCK_MS, retry the failed jobs one at a time;
// if a job still yields nothing, surface a clear, actionable error rather than hang.
//
// Signatures (client.session.create / client.session.prompt) follow the opencode SDK docs;
// `tsc` will flag any mismatch against the installed @opencode-ai/sdk types — adjust there.
import type { PluginCtx } from "./index.ts"

const STUCK_MS = 90_000

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | { __timeout: true }> {
  return Promise.race([p, new Promise<{ __timeout: true }>((r) => setTimeout(() => r({ __timeout: true }), ms))])
}

// Spawn one child session bound to a hidden agent and return its final text.
export async function runAgent(ctx: PluginCtx, agentName: string, prompt: string): Promise<string> {
  const session = await ctx.client.session.create({ body: { title: `craft:${agentName}` } })
  const path = { id: session.id ?? session.data?.id }
  const res = await ctx.client.session.prompt({
    path,
    body: { agent: agentName, parts: [{ type: "text", text: prompt }] },
  })
  // The prompt result carries the assistant message; pull text out defensively across shapes.
  return extractText(res)
}

function extractText(res: any): string {
  const parts = res?.parts ?? res?.data?.parts ?? res?.message?.parts ?? []
  const text = parts
    .filter((p: any) => p?.type === "text" && typeof p.text === "string")
    .map((p: any) => p.text)
    .join("\n")
    .trim()
  return text || (typeof res?.text === "string" ? res.text.trim() : "")
}

export interface Job { label: string; agent: string; prompt: string }
export interface JobResult { label: string; ok: boolean; text: string }

async function tryOne(ctx: PluginCtx, job: Job): Promise<JobResult> {
  try {
    const out = await withTimeout(runAgent(ctx, job.agent, job.prompt), STUCK_MS)
    if (out && typeof out === "object" && (out as any).__timeout) {
      return { label: job.label, ok: false, text: "" } // stuck — eligible for sequential retry
    }
    const text = String(out)
    return { label: job.label, ok: text.length > 0, text }
  } catch (e) {
    return { label: job.label, ok: false, text: `error: ${e instanceof Error ? e.message : String(e)}` }
  }
}

export async function fanOut(ctx: PluginCtx, jobs: Job[]): Promise<JobResult[]> {
  // Pass 1: concurrent.
  const first = await Promise.all(jobs.map((j) => tryOne(ctx, j)))
  const failedIdx = first.map((r, i) => (r.ok ? -1 : i)).filter((i) => i >= 0)
  if (failedIdx.length === 0) return first

  // Pass 2: sequential retry of the stuck/failed jobs (the #8528/#6573 mitigation).
  for (const i of failedIdx) {
    const retry = await tryOne(ctx, jobs[i])
    first[i] = retry.ok
      ? retry
      : {
          label: jobs[i].label,
          ok: false,
          text:
            `NOT RUN — child session for "${jobs[i].agent}" produced no output after a concurrent ` +
            `attempt and a sequential retry. This matches opencode child-session execution bugs ` +
            `(#8528/#6573); check your opencode version. ${retry.text}`.trim(),
        }
  }
  return first
}
```

- [ ] **Step 2: Structural check (timeout + sequential fallback present)**

Run:
```bash
grep -q 'STUCK_MS' opencode/plugin/orchestrator.ts \
  && grep -q 'Pass 2: sequential' opencode/plugin/orchestrator.ts \
  && grep -q '8528' opencode/plugin/orchestrator.ts \
  && echo "orchestrator shape OK"
```
Expected: `orchestrator shape OK`.

- [ ] **Step 3: Typecheck (if available)**

Run:
```bash
cd opencode/plugin
if command -v bun >/dev/null; then bunx tsc --noEmit --moduleResolution bundler --module esnext --target esnext --strict false orchestrator.ts && echo "tsc OK"; else echo "skipped"; fi
cd - >/dev/null
```
Expected: `tsc OK` or `skipped`.

- [ ] **Step 4: Commit**

```bash
git add opencode/plugin/orchestrator.ts
git commit -m "feat(opencode): child-session fan-out with sequential fallback for #8528/#6573"
```

---

### Task 5: rust-audit workflow logic

**Files:**
- Modify: `opencode/plugin/rust-audit.ts` (replace the Task 3 stub)

**Interfaces:**
- Consumes: `PluginCtx` (Task 3), `fanOut` + `runAgent` (Task 4).
- Produces: `runRustAudit(ctx, args: { base?: string }): Promise<string>` — scouts the diff base + unsafe presence via `ctx.$`, fans out the reviewers (and Miri only if unsafe), synthesizes one markdown report. Consumed by `index.ts` (Task 3).

- [ ] **Step 1: Replace `opencode/plugin/rust-audit.ts` with the full implementation**

```typescript
// Mirrors workflows/rust-audit.js: scout → fan out reviewers (Miri only if unsafe) → synthesize.
import type { PluginCtx } from "./index.ts"
import { fanOut, runAgent, type Job } from "./orchestrator.ts"

async function sh(ctx: PluginCtx, cmd: string): Promise<string> {
  try {
    const r = await ctx.$`bash -lc ${cmd}`.quiet()
    return (r.stdout?.toString?.() ?? String(r.stdout ?? "")).trim()
  } catch {
    return ""
  }
}

async function scout(ctx: PluginCtx, base?: string): Promise<{ baseRef: string; hasUnsafe: boolean }> {
  let baseRef = base ?? ""
  if (!baseRef) {
    for (const c of [
      "git merge-base HEAD origin/main 2>/dev/null",
      "git merge-base HEAD main 2>/dev/null",
      "git rev-parse HEAD~1 2>/dev/null",
    ]) {
      baseRef = await sh(ctx, c)
      if (baseRef) break
    }
  }
  const unsafeHits = await sh(ctx, `grep -rnE "\\\\bunsafe\\\\b" --include=*.rs . | head -n1`)
  return { baseRef, hasUnsafe: unsafeHits.length > 0 }
}

export async function runRustAudit(ctx: PluginCtx, args: { base?: string }): Promise<string> {
  const { baseRef, hasUnsafe } = await scout(ctx, args.base)
  const diffNote = baseRef
    ? `Diff base: \`${baseRef}\`.`
    : "There is no clean base ref — review uncommitted changes, or the most recent commit if the tree is clean."

  const jobs: Job[] = [
    {
      label: "review",
      agent: "rust-reviewer",
      prompt: `Review the Rust diff for mergeability using the rust-review rubric. ${diffNote} Report every finding with severity and confidence (coverage, not filtering), then your Approve/Warning/Block verdict.`,
    },
    {
      label: "architecture",
      agent: "rust-architecture-reviewer",
      prompt: `Audit the architecture of this whole Rust project: build the crate/module dependency graph and judge it in both directions (layer leaks/god modules vs ghost abstractions/over-layering). Return your Healthy/Concerns/At-risk rating and findings.`,
    },
    {
      label: "security",
      agent: "rust-security-scanner",
      prompt: `Run the Rust security toolchain (cargo-audit, cargo-deny, cargo-geiger, semgrep — whatever is installed) and consolidate into a severity-ranked verdict and findings. Note any absent tools.`,
    },
  ]
  if (hasUnsafe) {
    jobs.push({
      label: "miri",
      agent: "rust-miri",
      prompt: `This workspace contains unsafe code. Run its tests under Miri and report any undefined behavior against the rust-unsafe rubric. Return a Clean / UB-found verdict and findings.`,
    })
  }

  const results = await fanOut(ctx, jobs)

  // Synthesize through a fresh child session (no agent → the session's default model/persona).
  const blob = results.map((r) => `### ${r.label} (${r.ok ? "ran" : "NOT RUN"})\n\n${r.text}`).join("\n\n")
  const synthPrompt = `You are consolidating a Rust audit. Below are the per-dimension results. Produce ONE markdown report — do not invent findings, only merge what is given:

1. An **overall verdict** line — the worst case across dimensions. If any dimension is "NOT RUN", mark the audit INCOMPLETE.
2. A **dimension → verdict** table; give any NOT RUN dimension the verdict \`NOT RUN\` (do not treat absence as a pass).
3. **Findings by severity** (Critical first), each tagged with its dimension and location + a one-line fix direction.
4. A short **"Fix first"** list of the highest-leverage items.

RESULTS:
${blob}`

  return await runAgent(ctx, "", synthPrompt).catch(() => blob) || blob
}
```

Note: `runAgent(ctx, "", ...)` prompts a child session with an empty `agent` name → the synthesis runs on the session's default model/persona (per § Model strategy: synthesis inherits, no special agent). If the installed SDK rejects an empty `agent`, drop the field — confirm against types; `tsc` / a live run will tell.

- [ ] **Step 2: Structural check (Miri gated on unsafe, scout fallbacks present)**

Run:
```bash
grep -q 'if (hasUnsafe)' opencode/plugin/rust-audit.ts \
  && grep -q 'merge-base HEAD origin/main' opencode/plugin/rust-audit.ts \
  && grep -q "agent: \"rust-architecture-reviewer\"" opencode/plugin/rust-audit.ts \
  && echo "rust-audit shape OK"
```
Expected: `rust-audit shape OK`.

- [ ] **Step 3: Typecheck (if available)**

Run:
```bash
cd opencode/plugin
if command -v bun >/dev/null; then bunx tsc --noEmit --moduleResolution bundler --module esnext --target esnext --strict false index.ts && echo "tsc OK"; else echo "skipped"; fi
cd - >/dev/null
```
Expected: `tsc OK` or `skipped`.

- [ ] **Step 4: Commit**

```bash
git add opencode/plugin/rust-audit.ts
git commit -m "feat(opencode): rust-audit workflow — scout, fan out reviewers, synthesize"
```

---

### Task 6: triage-findings workflow logic

**Files:**
- Modify: `opencode/plugin/triage-findings.ts` (replace the Task 3 stub)

**Interfaces:**
- Consumes: `PluginCtx` (Task 3), `runAgent` + `fanOut` (Task 4).
- Produces: `runTriageFindings(ctx, args: { locator: string }): Promise<string>` — gathers findings from the locator, validates each against the code (parallel via `fanOut`, one job per finding) using the `rust-reviewer` agent as the validator, then renders one ordered fix plan + triage ledger (no edits). Consumed by `index.ts` (Task 3).

- [ ] **Step 1: Replace `opencode/plugin/triage-findings.ts` with the full implementation**

```typescript
// Mirrors workflows/triage-findings.js: gather → validate each finding against the code (parallel)
// → render one ordered fix plan + triage ledger. No edits. Delegates the per-finding code-check to
// the hidden rust-reviewer agent; the final plan is synthesized on the session's default model.
import type { PluginCtx } from "./index.ts"
import { fanOut, runAgent, type Job } from "./orchestrator.ts"

async function sh(ctx: PluginCtx, cmd: string): Promise<string> {
  try {
    const r = await ctx.$`bash -lc ${cmd}`.quiet()
    return (r.stdout?.toString?.() ?? String(r.stdout ?? "")).trim()
  } catch {
    return ""
  }
}

// Resolve the locator into raw findings text: a readable file path, else the literal string.
async function gather(ctx: PluginCtx, locator: string): Promise<string> {
  const asFile = await sh(ctx, `test -f ${JSON.stringify(locator)} && cat ${JSON.stringify(locator)} || true`)
  return asFile || locator
}

// Split a findings blob into individual items (one per non-empty line that looks like a finding).
function splitFindings(blob: string): string[] {
  return blob
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !/^#{1,6}\s/.test(l)) // drop markdown headings
    .slice(0, 40) // cap; a triage of >40 raw lines should be scoped down first
}

export async function runTriageFindings(ctx: PluginCtx, args: { locator: string }): Promise<string> {
  const blob = await gather(ctx, args.locator)
  const findings = splitFindings(blob)
  if (findings.length === 0) return "No findings parsed from the locator."

  const jobs: Job[] = findings.map((f, i) => ({
    label: `f${i + 1}`,
    agent: "rust-reviewer",
    prompt: `Validate this single review finding against the actual code. Do NOT fix anything.
Finding: ${f}

Decide exactly one outcome: accept | reject | defer | needs-decision | conflict, with one or two
sentences of reasoning grounded in the code (cite file:line if you can). Output:
OUTCOME: <one of the five>
REASON: <grounded reasoning>`,
  }))

  const validated = await fanOut(ctx, jobs)
  const ledger = validated
    .map((r, i) => `- **${r.label}** (${r.ok ? "validated" : "NOT RUN"}): ${findings[i]}\n  ${r.text.replace(/\n/g, "\n  ")}`)
    .join("\n")

  const planPrompt = `You are turning validated review findings into ONE ordered fix plan (writing-plans style) plus a triage ledger. Do not edit code.

Below is each finding with its validation outcome. Build:
1. A **triage ledger** table: finding · outcome (accept/reject/defer/needs-decision/conflict) · reason.
2. An **ordered fix plan** containing ONLY the \`accept\`ed findings, sequenced so prerequisites come first, each as a short task with file:line and the fix direction.
3. A short **open questions** list for any \`needs-decision\` / \`conflict\` items.

VALIDATED FINDINGS:
${ledger}`

  return (await runAgent(ctx, "", planPrompt).catch(() => ledger)) || ledger
}
```

- [ ] **Step 2: Structural check (per-finding validation + ledger + no-edits intent)**

Run:
```bash
grep -q 'one per' opencode/plugin/triage-findings.ts; true  # informational
grep -q 'accept | reject | defer | needs-decision | conflict' opencode/plugin/triage-findings.ts \
  && grep -q 'triage ledger' opencode/plugin/triage-findings.ts \
  && grep -q 'Do not edit code' opencode/plugin/triage-findings.ts \
  && echo "triage shape OK"
```
Expected: `triage shape OK`.

- [ ] **Step 3: Full-plugin typecheck (if available)**

Run:
```bash
cd opencode/plugin
if command -v bun >/dev/null; then bun install >/dev/null 2>&1 && bunx tsc --noEmit --moduleResolution bundler --module esnext --target esnext --strict false index.ts && echo "tsc OK"; else echo "skipped"; fi
cd - >/dev/null
```
Expected: `tsc OK` (whole plugin compiles together) or `skipped`.

- [ ] **Step 4: Commit**

```bash
git add opencode/plugin/triage-findings.ts
git commit -m "feat(opencode): triage-findings workflow — validate per finding, render fix plan"
```

---

### Task 7: command entry points

**Files:**
- Create: `opencode/commands/rust-audit.md`
- Create: `opencode/commands/triage-findings.md`

**Interfaces:**
- Consumes: the plugin tools `rust-audit` / `triage-findings` (Task 3).
- Produces: `/rust-audit` and `/triage-findings` opencode commands whose template tells the agent to invoke the matching plugin tool, passing `$ARGUMENTS`.

- [ ] **Step 1: Write `opencode/commands/rust-audit.md`**

```markdown
---
description: Full Rust crate audit — fan out the craft review agents and synthesize one severity-ranked report.
---

Run the craft Rust audit by invoking the `rust-audit` tool.

If the user passed an argument, treat it as the diff base ref and call the tool with `base` set to it:

`$ARGUMENTS`

Otherwise call `rust-audit` with no arguments (it scouts the diff base itself). Return the tool's
synthesized report verbatim.
```

- [ ] **Step 2: Write `opencode/commands/triage-findings.md`**

```markdown
---
description: Triage review findings into one ordered, validated fix plan — no edits.
---

Run craft's findings triage by invoking the `triage-findings` tool with `locator` set to the
argument below (a report path, a PR ref, or pasted findings):

`$ARGUMENTS`

Return the tool's fix plan and triage ledger verbatim. Do not edit any code yourself — this is
triage only.
```

- [ ] **Step 3: Validate command frontmatter**

Run:
```bash
python3 opencode/scripts/check-frontmatter.py command opencode/commands/*.md
grep -q '\$ARGUMENTS' opencode/commands/rust-audit.md && grep -q '\$ARGUMENTS' opencode/commands/triage-findings.md && echo "templating OK"
```
Expected: two `OK  ...` lines, then `templating OK`.

- [ ] **Step 4: Commit**

```bash
git add opencode/commands
git commit -m "feat(opencode): /rust-audit and /triage-findings command entry points"
```

---

### Task 8: opencode README

**Files:**
- Create: `opencode/README.md`

**Interfaces:**
- Produces: install/usage/caveats documentation, including the § Model strategy tier table (the opencode side inherits the session model; this README carries the per-task guidance).

- [ ] **Step 1: Write `opencode/README.md`**

```markdown
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

### superpowers co-requisite

craft skills defer to `superpowers:*` skills (generic engineering-process discipline). opencode
reads the same Anthropic skill spec, so install superpowers' skills the same way — symlink their
skill directories into your opencode `skills/` dir. **Without them craft still works**; only the
generic-process deferrals go inert (the Rust knowledge is self-contained).

### Plugin dependencies

opencode auto-loads the plugin from `plugins/craft-rust` and Bun installs its `package.json`
dependencies on startup. If your opencode version doesn't auto-install them, add
`@opencode-ai/plugin` and `@opencode-ai/sdk` to your opencode tree's `package.json` and restart.

## Use

- **Skills** — auto-discovered; opencode's `skill` tool lists all 24 and routes by description.
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

The plugin is deliberately inert until you invoke it: it registers **only** the two workflow
tools and installs **no** global hooks (no message/event/permission interception). It talks only
to the local opencode server, opens no ports, and makes no outbound calls. Installed project-scoped
by default.

## Parity caveats

- Skill sub-files aren't first-class bundled in opencode — the agent reads them by path on demand.
- `craft:` / `superpowers:` namespace prefixes in skill bodies are cosmetic here (skill name = bare
  dir); the model still resolves them.
- Workflow determinism rides on opencode's child-session API; the plugin retries sequentially and
  surfaces a clear error if a child session is stuck (opencode #8528 / #6573).
```

- [ ] **Step 2: Verify the README covers the required sections**

Run:
```bash
for h in '## Install' 'superpowers co-requisite' '## Model strategy' '## Containment' '## Parity caveats'; do
  grep -qF "$h" opencode/README.md || { echo "MISSING: $h"; exit 1; }
done
echo "README sections OK"
```
Expected: `README sections OK`.

- [ ] **Step 3: Commit**

```bash
git add opencode/README.md
git commit -m "docs(opencode): README — install, usage, model strategy, containment, caveats"
```

---

### Task 9: surface opencode support in the repo docs

**Files:**
- Modify: `README.md` (repo root — add an opencode section)
- Modify: `MAP.md` (note the opencode adapter subtree)

**Interfaces:** none (documentation only).

- [ ] **Step 1: Add an opencode section to the repo `README.md`**

Append, after the existing `## Install` section, a new section:

```markdown
## opencode

craft also runs in [opencode](https://opencode.ai) via a contained adapter layer under
`opencode/`: the 24 skills are shared verbatim (opencode reads the Anthropic skill spec), the 4
review agents are translated to opencode agent files, and the `rust-audit` / `triage-findings`
workflows ship as one contained TS/Bun plugin (`/rust-audit`, `/triage-findings`). Install with
`opencode/install.sh` (project-scoped by default). See `opencode/README.md` for details, the model
strategy, and parity caveats.
```

- [ ] **Step 2: Note the adapter subtree in `MAP.md`**

Add this row to the layout/contents discussion — append a short paragraph near the end of `MAP.md`:

```markdown
## opencode adapter

`opencode/` is a thin, contained adapter layer that makes the collection usable from opencode
(skills shared verbatim by symlink; 4 translated agent files; a TS/Bun plugin hosting the
`rust-audit` and `triage-findings` workflows; a symlink `install.sh`). Single source of truth: the
skills are not duplicated. See the design spec
`docs/superpowers/specs/2026-06-17-craft-opencode-support-design.md`.
```

- [ ] **Step 3: Verify the references exist**

Run:
```bash
grep -q '## opencode' README.md && grep -q 'opencode adapter' MAP.md && echo "repo docs updated"
```
Expected: `repo docs updated`.

- [ ] **Step 4: Commit**

```bash
git add README.md MAP.md
git commit -m "docs: surface opencode support in README and MAP"
```

---

## Final acceptance — manual, in opencode

These can't run in CI (no opencode runtime); run them once on a real opencode install (against a
small Rust fixture crate, ideally one with and one without `unsafe`):

- [ ] `opencode/install.sh --project` in a Rust repo; restart opencode.
- [ ] opencode's `skill` tool lists all 24 craft skills; opening a SKILL.md that references a
  sub-file (e.g. `rust-review` → `api-design.md`) gets the sub-file read on demand.
- [ ] The 4 agents appear as **hidden** subagents (absent from `@`-autocomplete) and are
  dispatchable; `rust-reviewer` against a tiny diff returns a verdict.
- [ ] With the plugin loaded, an **unrelated** opencode session triggers none of its code (the two
  tools are present but inert until invoked) — containment holds.
- [ ] `/rust-audit` on the unsafe fixture fans out all four agents (Miri included) and returns one
  synthesized report; on the non-unsafe fixture, Miri is skipped.
- [ ] Simulate a stuck child session (or run on a known-buggy opencode version) and confirm the
  sequential fallback engages and the report marks the dimension `NOT RUN` rather than hanging.
- [ ] `/triage-findings <path-to-a-rust-audit-report>` returns a triage ledger + ordered fix plan,
  with no edits applied.

## Self-review notes (already reconciled)

- Spec coverage: skills (Task 2 symlink), agents (Task 1), workflows→plugin (Tasks 3-6), commands
  (Task 7), install (Task 2), distribution/README (Task 8), containment (Tasks 3 + acceptance),
  superpowers co-requisite (Task 2 post-install note + Task 8), model strategy / inherit (Task 1
  no-model + Task 8 table). Repo-doc surfacing (Task 9) is additive.
- Type consistency: `PluginCtx` (Task 3) is consumed verbatim by Tasks 4-6; `Job` / `JobResult` /
  `fanOut` / `runAgent` (Task 4) are consumed by Tasks 5-6; `runRustAudit` / `runTriageFindings`
  signatures match `index.ts` (Task 3) exactly.
- Known soft spots flagged inline for the implementer to confirm against the installed
  `@opencode-ai/*` types (gated by the `tsc` step): `client.session.create` / `client.session.prompt`
  shapes, the `tool()` helper signature, and whether an empty `agent` is accepted on `session.prompt`
  (drop the field if not). Plugin directory-vs-file discovery and dep auto-install are flagged in
  `install.sh` output and the README.
```
