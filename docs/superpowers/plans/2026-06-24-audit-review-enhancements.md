# Audit Review Enhancements Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn `rust-audit` into the comprehensive "full review": per-crate parallel review, inter-crate contract review, crate-decomposition advice, and four whole-project tool dimensions (semver / build-matrix / deps / tests-cov) — while `rust-review` gains only one optional, backward-compatible `path` arg.

**Architecture:** `rust-review` Scout learns to scope its diff to an optional crate `path`. `rust-audit` Scout additionally detects workspace `crates`/`changedCrates`/`edges` via `cargo metadata`; its Audit phase becomes a dynamically-assembled `tasks[]`/`dispatched[]` fan-out (per-crate review via nested `workflow('rust-review',{base,path})`, per-edge contracts via `craft:rust-reviewer`, a crate-decomposition agent, and four tool agents) all run in one `parallel()`; synthesis and NOT-RUN bookkeeping are driven by the `dispatched` labels. A new `skills/rust-ecosystem/crate-extraction.md` rubric backs the decomposition dimension.

**Tech Stack:** Plain-JS workflow scripts (`workflows/*.js`); Markdown skills; `cargo metadata`, `cargo-semver-checks`, `cargo-hack`, `cargo tree/machete/outdated`, `cargo-llvm-cov`, `cargo-mutants`, `cargo doc`.

## Global Constraints

- **No test runner.** Verification is mechanical: `node --check workflows/<file>.js && echo "SYNTAX OK"` run on the **`.js` file IN PLACE** (these scripts use top-level `return` + `export`, so copying to `.mjs`/`.cjs` falsely fails — never copy), plus `rg -n "<phrase>" <file>` content checks and cross-reference existence. Never fabricate a pytest cycle.
- **Workflow conventions:** `export const meta` is a pure literal; body uses `phase()`, `agent(prompt,{label,agentType,phase,schema,model,effort})`, `parallel([...thunks])`, `workflow(name,args)`, `log()`, and the `args` global. Schemas are JSON Schema with `additionalProperties: false`.
- **Forbidden in scripts:** `Date.now()`, `Math.random()`, `new Date()`.
- **Nesting is one level:** `rust-audit` (parent) MAY call `workflow('rust-review', …)`; `rust-review` MUST NOT call `workflow(...)`.
- **Commit messages:** written as the user — NO `Co-Authored-By: Claude`, no "Generated with Claude Code" footer.
- **Graceful degradation:** every tool dimension treats a missing tool/toolchain as an intentional skip (logged / noted in the result), never a failure, never NOT-RUN.
- **`rust-review` default behaviour is unchanged** — the only edit there is the additive optional `path` arg (absent `path` = today's whole-tree behaviour).

---

### Task 1: `rust-review` — optional `path` argument

**Files:**
- Modify: `workflows/rust-review.js` (the `// ---- args ----` block ~14-17 and the Scout prompt intro ~96)

**Interfaces:**
- Produces: `rust-review` now accepts `args.path` (a crate directory). When set, Scout scopes every `git diff` to that path and reviews only files under it. Absent → whole tree (today). `rust-audit`'s per-crate fan-out (Task 4) relies on this.

- [ ] **Step 1: Add the `pathArg` to the args block**

Find:
```javascript
const baseArg = (args && typeof args === 'object' && args.base) ? String(args.base) : ''
const intentArg = (args && typeof args === 'object' && args.intent) ? String(args.intent) : ''
const postComments = !!(args && typeof args === 'object' && args.comment)
```
Replace with (append one line):
```javascript
const baseArg = (args && typeof args === 'object' && args.base) ? String(args.base) : ''
const intentArg = (args && typeof args === 'object' && args.intent) ? String(args.intent) : ''
const postComments = !!(args && typeof args === 'object' && args.comment)
const pathArg = (args && typeof args === 'object' && args.path) ? String(args.path) : ''   // optional crate-scope (audit per-crate fan-out)
```

- [ ] **Step 2: Make the Scout prompt path-aware**

Find the Scout prompt's first line:
```javascript
  `You are scouting a Rust diff to plan an elastic review. Use shell + read only — do NOT review yet.
```
Replace with (inject a SCOPE clause that is empty when no `path` is given):
```javascript
  `You are scouting a Rust diff to plan an elastic review. Use shell + read only — do NOT review yet.${pathArg ? `\n\nSCOPE: review ONLY the crate at \`${pathArg}\`. Pass \`-- ${pathArg}\` to every \`git diff\` command below, consider only files under that path, and name the crate in your notes.` : ''}
```

- [ ] **Step 3: Verify syntax and content**

Run:
```bash
node --check workflows/rust-review.js && echo "SYNTAX OK"
rg -n "pathArg|SCOPE: review ONLY the crate" workflows/rust-review.js
```
Expected: `SYNTAX OK`; both the `pathArg` definition and the `SCOPE:` clause match. Confirm the change is additive (no other lines altered).

- [ ] **Step 4: Commit**

```bash
git add workflows/rust-review.js
git commit -m "feat(rust-review): optional path arg to scope the review to one crate"
```

---

### Task 2: `crate-extraction.md` rubric + link

**Files:**
- Create: `skills/rust-ecosystem/crate-extraction.md`
- Modify: `skills/rust-ecosystem/SKILL.md` (the "Project layout" section ~64-73 and the "Boundaries" section ~86-95)

**Interfaces:**
- Produces: the "when & how to extract a crate" rubric the `rust-audit` crate-decomposition dimension (Task 6) loads. Linked from `rust-ecosystem`.

- [ ] **Step 1: Create the sub-file**

Create `skills/rust-ecosystem/crate-extraction.md` with exactly:
```markdown
# Crate extraction: when and how

When does code belong in its own crate, and how do you pull it out — or, when an over-split
crate earns its keep, when do you merge it back. The shape of a workspace is a design decision
with real costs on both sides; make it on a driver, not a hunch.

## When to extract (each is a driver — you want at least one)

| Driver | Signal | Owner of the deeper "how" |
|---|---|---|
| Reuse | the code is (or will be) consumed by more than one crate/binary | `rust-ecosystem` (workspaces) |
| Compile parallelism | a module is a recompile hotspot or serializes the build | `rust-performance` → [compile-times.md](../rust-performance/compile-times.md) |
| Dependency inversion | a port/trait + adapters belong behind a boundary so the core doesn't depend on the framework | `rust-architecture` (ports) |
| Trust boundary | a swappable/sandboxed plugin or FFI surface | `rust-plugins` |
| Independent release | the code must version / publish on its own cadence | `rust-ecosystem` → [libraries.md](libraries.md) |
| Test isolation | heavy integration-test deps that shouldn't leak into the main build | `rust-testing` |
| God-crate split | one crate doing too much, with internally separable concerns | `rust-architecture` |

## How to extract

1. Add a workspace member: `[workspace] members = [..., "crates/foo"]`.
2. Move the module's files into the new crate; give it a `Cargo.toml` (name, version, edition).
3. Expose the **minimum** `pub` surface — the new crate boundary is now a public API (visibility
   → `rust-idioms`).
4. Re-export from the original crate (`pub use foo::…`) if downstream code shouldn't have to change
   its paths yet.
5. From here the new public surface has **semver** obligations like any library (→ [libraries.md](libraries.md)).

## When NOT to extract (the cost side)

Every crate boundary costs link time, `Cargo.toml` boilerplate, and cross-crate coordination, and
it ossifies an API across the boundary. So:

- **Don't** extract a single-consumer module that has no reuse / compile / boundary driver — it
  just adds ceremony.
- **Don't** extract prematurely — pulling out an API you're still reshaping freezes it before it's
  ready.
- **Reverse signal — merge back:** a crate with a single consumer and no boundary reason is
  over-split; fold it into its consumer.
```

- [ ] **Step 2: Link from `rust-ecosystem` "Project layout"**

In `skills/rust-ecosystem/SKILL.md`, find:
```markdown
Put real logic in a library crate and keep `main.rs` a thin shell — it makes the code testable
and reusable (this is also the spirit of `rust-architecture`). Module tree and `mod`/visibility
mechanics → `rust-idioms` (visibility) and `cargo.md` (workspaces).
```
Replace with (append one sentence):
```markdown
Put real logic in a library crate and keep `main.rs` a thin shell — it makes the code testable
and reusable (this is also the spirit of `rust-architecture`). Module tree and `mod`/visibility
mechanics → `rust-idioms` (visibility) and `cargo.md` (workspaces). When and how to pull a module
out into its own crate (or merge an over-split one) → [crate-extraction.md](crate-extraction.md).
```

- [ ] **Step 3: Add a Boundaries bullet**

In `skills/rust-ecosystem/SKILL.md`, find:
```markdown
- Naming and visibility idioms → `rust-idioms`.
```
Replace with:
```markdown
- Naming and visibility idioms → `rust-idioms`.
- When/how to extract code into its own crate, or merge an over-split one →
  [crate-extraction.md](crate-extraction.md).
```

- [ ] **Step 4: Verify**

Run:
```bash
rg -n "Crate extraction: when and how|Reverse signal — merge back" skills/rust-ecosystem/crate-extraction.md
rg -n "crate-extraction.md" skills/rust-ecosystem/SKILL.md
```
Expected: the sub-file headings match; two `crate-extraction.md` links in `SKILL.md`. Confirm the relative links resolve (`../rust-performance/compile-times.md`, `libraries.md` both exist).

- [ ] **Step 5: Commit**

```bash
git add skills/rust-ecosystem/crate-extraction.md skills/rust-ecosystem/SKILL.md
git commit -m "docs(rust-ecosystem): add crate-extraction rubric (when/how to extract a crate)"
```

---

### Task 3: `rust-audit` Scout detection + dynamic Audit scaffolding

**Files:**
- Modify: `workflows/rust-audit.js` (SCOUT_SCHEMA ~15-25; Scout prompt ~53-64; defaults ~66-68; the whole Audit-phase scaffolding ~70-111)

**Interfaces:**
- Produces: `crates [{name,path}]`, `changedCrates [{name,path}]`, `edges [{from,to}]` from Scout; a `reviewResult(dimension, report)` helper; the `tasks[]` + `dispatched[]` dynamic-assembly model; `notRun` derived from `dispatched`. Tasks 4-7 push thunks onto `tasks`/`dispatched`; Task 8 reads `dispatched`/`results`.
- Consumes: nothing new.

- [ ] **Step 1: Add crate/edge schema items + extend SCOUT_SCHEMA**

Find:
```javascript
const SCOUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['hasDiff', 'hasUnsafe', 'baseRef', 'notes'],
  properties: {
    hasDiff: { type: 'boolean', description: 'true if any .rs files differ vs the base ref (committed or uncommitted)' },
    hasUnsafe: { type: 'boolean', description: 'true if the workspace contains any `unsafe` block or impl' },
    baseRef: { type: 'string', description: 'the git ref the diff was computed against, or empty if none resolved' },
    notes: { type: 'string', description: 'one line on what was detected' },
  },
}
```
Replace with:
```javascript
const CRATE_ITEM = {
  type: 'object',
  additionalProperties: false,
  required: ['name', 'path'],
  properties: {
    name: { type: 'string', description: 'crate (package) name' },
    path: { type: 'string', description: "crate directory (its manifest dir), relative to the repo root" },
  },
}

const EDGE_ITEM = {
  type: 'object',
  additionalProperties: false,
  required: ['from', 'to'],
  properties: {
    from: { type: 'string', description: 'caller crate name (depends on `to`)' },
    to: { type: 'string', description: 'callee crate name' },
  },
}

const SCOUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['hasDiff', 'hasUnsafe', 'baseRef', 'crates', 'changedCrates', 'edges', 'notes'],
  properties: {
    hasDiff: { type: 'boolean', description: 'true if any .rs files differ vs the base ref (committed or uncommitted)' },
    hasUnsafe: { type: 'boolean', description: 'true if the workspace contains any `unsafe` block or impl' },
    baseRef: { type: 'string', description: 'the git ref the diff was computed against, or empty if none resolved' },
    crates: { type: 'array', items: CRATE_ITEM, description: 'workspace members; empty if cargo metadata is unavailable' },
    changedCrates: { type: 'array', items: CRATE_ITEM, description: 'subset of crates with a changed .rs file vs the base; empty if no base / no changes' },
    edges: { type: 'array', items: EDGE_ITEM, description: 'intra-workspace dependency edges; empty if cargo metadata is unavailable' },
    notes: { type: 'string', description: 'one line on what was detected' },
  },
}
```

- [ ] **Step 2: Extend the Scout prompt with crate/edge detection**

Find:
```javascript
2. hasDiff = true if \`git diff --name-only <base>...HEAD\` lists any \`.rs\` file, OR \`git status --porcelain\` shows uncommitted \`.rs\` changes.
3. hasUnsafe = true if \`grep -rnE "\\bunsafe\\b" --include=*.rs .\` finds any match (a rough check is fine; ignore obvious comment-only hits if cheap to do).
4. baseRef = the ref you actually used (empty string if none resolved).`,
```
Replace with:
```javascript
2. hasDiff = true if \`git diff --name-only <base>...HEAD\` lists any \`.rs\` file, OR \`git status --porcelain\` shows uncommitted \`.rs\` changes.
3. hasUnsafe = true if \`grep -rnE "\\bunsafe\\b" --include=*.rs .\` finds any match (a rough check is fine; ignore obvious comment-only hits if cheap to do).
4. baseRef = the ref you actually used (empty string if none resolved).
5. crates = workspace members from \`cargo metadata --no-deps --format-version 1\` — each as {name, path} where path is the crate's manifest directory relative to the repo root. Empty array if \`cargo metadata\` is unavailable.
6. changedCrates = the subset of \`crates\` whose directory contains a \`.rs\` file listed by \`git diff --name-only <base>...HEAD\` (or \`git status --porcelain\` for uncommitted work). Empty if no base or no changed \`.rs\`.
7. edges = intra-workspace dependency edges from \`cargo metadata --format-version 1\`: {from, to} where BOTH \`from\` and \`to\` are workspace members and \`from\` depends on \`to\`. Empty array if \`cargo metadata\` is unavailable.`,
```

- [ ] **Step 3: Add fail-safe defaults for the new fields**

Find:
```javascript
const baseRef = scout?.baseRef ?? ''
const hasUnsafe = scout?.hasUnsafe ?? true // fail-safe: run Miri when detection didn't resolve
log(scout?.notes ?? 'scout produced no result — assuming unsafe present, no base ref')
```
Replace with:
```javascript
const baseRef = scout?.baseRef ?? ''
const hasUnsafe = scout?.hasUnsafe ?? true // fail-safe: run Miri when detection didn't resolve
const crates = Array.isArray(scout?.crates) ? scout.crates : []
const changedCrates = Array.isArray(scout?.changedCrates) ? scout.changedCrates : []
const edges = Array.isArray(scout?.edges) ? scout.edges : []
log(scout?.notes ?? 'scout produced no result — assuming unsafe present, no base ref')
```

- [ ] **Step 4: Replace the Audit-phase scaffolding with the dynamic model**

Find the whole block from `phase('Audit')` through the `if (notRun.length) log(...)` line (the `const tasks = [ ... ]`, the `if (hasUnsafe)` push, `const results = ...`, `expectedDimensions`, `ran`, `notRun`). Replace it with:
```javascript
phase('Audit')

// Map a rust-review workflow report string into a FINDINGS_SCHEMA-shaped dimension result.
function reviewResult(dimension, report) {
  return {
    dimension,
    verdict: /⛔|Block/.test(report || '') ? 'Block' : /⚠️|Warning/.test(report || '') ? 'Warning' : 'Approve',
    summary: 'Elastic deep review — see findings below.',
    findings: [{ severity: 'Info', title: 'Deep review report', location: '', detail: String(report || 'no report').slice(0, 4000) }],
  }
}

// Dimensions are assembled dynamically; `dispatched` records one label per thunk and drives the
// NOT-RUN bookkeeping (a thunk that returns null is flagged NOT RUN).
const tasks = []
const dispatched = []

// Review dimension — a single whole-workspace review for now; Task 4 replaces this with a
// per-crate fan-out.
tasks.push(() => workflow('rust-review', baseRef ? { base: baseRef } : {})
  .then(report => reviewResult('review', report))
  .catch(() => null))
dispatched.push('review')

tasks.push(() => agent(
  `Audit the architecture of this whole Rust project against the rust-architecture-review rubric (load the rust-architecture-review skill). Build the crate/module dependency graph and judge the structure in BOTH directions — too little (layer leaks, god modules) and too much (ghost abstractions, over-layering). Return your health rating and findings.`,
  { label: 'architecture', agentType: 'craft:rust-architecture-reviewer', phase: 'Audit', schema: FINDINGS_SCHEMA },
).then(r => (r ? { ...r, dimension: 'architecture' } : null)))
dispatched.push('architecture')

tasks.push(() => agent(
  `Run the Rust security toolchain (cargo-audit, cargo-deny, cargo-geiger, semgrep — whatever is available) against the rust-security rubric (load the rust-security skill). Consolidate into a severity-ranked verdict and findings.`,
  { label: 'security', agentType: 'craft:rust-security-scanner', phase: 'Audit', schema: FINDINGS_SCHEMA },
).then(r => (r ? { ...r, dimension: 'security' } : null)))
dispatched.push('security')

if (hasUnsafe) {
  tasks.push(() => agent(
    `This workspace contains unsafe code. Run its tests under Miri and report any undefined behavior against the rust-unsafe rubric (load the rust-unsafe skill). Return a verdict (Clean / UB-found) and findings.`,
    { label: 'miri', agentType: 'craft:rust-miri', phase: 'Audit', schema: FINDINGS_SCHEMA },
  ).then(r => (r ? { ...r, dimension: 'miri' } : null)))
  dispatched.push('miri')
} else {
  log('No unsafe code detected — skipping Miri.')
}

const results = (await parallel(tasks)).filter(Boolean)

// NOT RUN = a dispatched dimension that produced no result (its agent failed). Intentional skips
// (Miri without unsafe, contracts without edges, a tool dimension whose tool is absent) are never
// pushed to `dispatched` as failures, so they don't land here.
const ran = new Set(results.map(r => r.dimension))
const notRun = dispatched.filter(d => !ran.has(d))
if (notRun.length) log(`No result from: ${notRun.join(', ')} — flagged NOT RUN in the report.`)
```

- [ ] **Step 5: Verify syntax and content**

Run:
```bash
node --check workflows/rust-audit.js && echo "SYNTAX OK"
rg -n "function reviewResult|const dispatched = \[\]|const notRun = dispatched.filter|crates = Array.isArray|edges = Array.isArray" workflows/rust-audit.js
```
Expected: `SYNTAX OK`; all five anchors match. (Behaviour is unchanged this task — same four dimensions, now dynamically assembled.)

- [ ] **Step 6: Commit**

```bash
git add workflows/rust-audit.js
git commit -m "refactor(rust-audit): dynamic dimension assembly + scout crate/edge detection"
```

---

### Task 4: `rust-audit` per-crate review fan-out (feature A)

**Files:**
- Modify: `workflows/rust-audit.js` (the single review `tasks.push` block from Task 3 ~after `const dispatched = []`)

**Interfaces:**
- Consumes: `crates`, `changedCrates`, `baseRef`, `reviewResult`, `workflow('rust-review', {base, path})` (Task 1's `path` arg), `tasks`/`dispatched`.
- Produces: per-crate `review:<name>` dimensions (or a single `review` dimension as fallback).

- [ ] **Step 1: Replace the single review push with the fan-out**

Find:
```javascript
// Review dimension — a single whole-workspace review for now; Task 4 replaces this with a
// per-crate fan-out.
tasks.push(() => workflow('rust-review', baseRef ? { base: baseRef } : {})
  .then(report => reviewResult('review', report))
  .catch(() => null))
dispatched.push('review')
```
Replace with:
```javascript
// Review dimension — per-crate fan-out (feature A). changedCrates → diff-scoped; no base → all
// crates; 0 or 1 crate → today's single whole-workspace review.
const reviewCrates = changedCrates.length ? changedCrates : (baseRef ? [] : crates)
if (reviewCrates.length > 1) {
  for (const c of reviewCrates) {
    tasks.push(() => workflow('rust-review', { base: baseRef, path: c.path })
      .then(report => reviewResult(`review:${c.name}`, report))
      .catch(() => null))
    dispatched.push(`review:${c.name}`)
  }
} else {
  tasks.push(() => workflow('rust-review', baseRef ? { base: baseRef } : {})
    .then(report => reviewResult('review', report))
    .catch(() => null))
  dispatched.push('review')
}
```

- [ ] **Step 2: Verify**

Run:
```bash
node --check workflows/rust-audit.js && echo "SYNTAX OK"
rg -n "const reviewCrates =|review:\$\{c.name\}|workflow\('rust-review', \{ base: baseRef, path: c.path \}\)" workflows/rust-audit.js
```
Expected: `SYNTAX OK`; the `reviewCrates` selection, the `review:${c.name}` label, and the per-crate `workflow('rust-review', { base: baseRef, path: c.path })` all match.

- [ ] **Step 3: Commit**

```bash
git add workflows/rust-audit.js
git commit -m "feat(rust-audit): per-crate parallel review fan-out"
```

---

### Task 5: `rust-audit` inter-crate contracts dimension (feature B)

**Files:**
- Modify: `workflows/rust-audit.js` (insert after the review fan-out block, before the `architecture` push)

**Interfaces:**
- Consumes: `edges`, `changedCrates`, `baseRef`, `tasks`/`dispatched`, `FINDINGS_SCHEMA`, `craft:rust-reviewer`.
- Produces: per-edge `contract:<from>→<to>` dimensions; or a logged skip when there are no intra-workspace edges.

- [ ] **Step 1: Insert the contracts fan-out**

Immediately after the per-crate review fan-out block (the `if (reviewCrates.length > 1) { … } else { … }`), insert:
```javascript
// Contracts dimension (feature B) — one focused review per TOUCHED intra-workspace edge. An edge
// is touched when its caller or callee is a changed crate; with no base, every edge is touched.
const changedNames = new Set(changedCrates.map(c => c.name))
const touchedEdges = edges.filter(e => !baseRef || changedNames.has(e.from) || changedNames.has(e.to))
if (touchedEdges.length) {
  for (const e of touchedEdges) {
    tasks.push(() => agent(
      `Review the call contract on the workspace dependency edge \`${e.from}\` → \`${e.to}\`: does \`${e.from}\` use \`${e.to}\`'s PUBLIC API the way its contract intends? Check signatures and types at the boundary, error and panic contracts, documented invariants and trait laws, and the semver/breaking-change compatibility of \`${e.to}\`'s public surface against \`${e.from}\`'s usage. Load the rust-review skill (the api-design pass), rust-errors (error contracts), and rust-traits (trait laws) for the rubric. Return a verdict and findings.`,
      { label: `contract:${e.from}->${e.to}`, agentType: 'craft:rust-reviewer', phase: 'Audit', schema: FINDINGS_SCHEMA },
    ).then(r => (r ? { ...r, dimension: `contract:${e.from}→${e.to}` } : null)))
    dispatched.push(`contract:${e.from}→${e.to}`)
  }
} else {
  log('No intra-workspace dependency edges to review — skipping the contracts dimension.')
}
```

- [ ] **Step 2: Verify**

Run:
```bash
node --check workflows/rust-audit.js && echo "SYNTAX OK"
rg -n "Contracts dimension \(feature B\)|const touchedEdges =|contract:\$\{e.from\}" workflows/rust-audit.js
```
Expected: `SYNTAX OK`; the contracts block, `touchedEdges` filter, and the `contract:${e.from}…` label all match. Note the agent `label` uses `->` (display-safe) while the `dimension` and `dispatched` entry use `→` consistently.

- [ ] **Step 3: Commit**

```bash
git add workflows/rust-audit.js
git commit -m "feat(rust-audit): inter-crate contract review per dependency edge"
```

---

### Task 6: `rust-audit` crate-decomposition dimension (feature C)

**Files:**
- Modify: `workflows/rust-audit.js` (insert after the contracts block, before the `architecture` push)

**Interfaces:**
- Consumes: `tasks`/`dispatched`, `FINDINGS_SCHEMA`, the `rust-ecosystem` crate-extraction rubric (Task 2).
- Produces: the `crate-decomposition` dimension.

- [ ] **Step 1: Insert the crate-decomposition dimension**

Immediately after the contracts block (`} else { log('No intra-workspace … contracts dimension.') }`), insert:
```javascript
// Crate-decomposition dimension (feature C) — whole-project; runs even on a single crate.
tasks.push(() => agent(
  `Judge this Rust workspace's crate boundaries and recommend where code should be EXTRACTED into its own crate, or where an over-split crate should be MERGED back. Load the rust-ecosystem skill and its crate-extraction.md rubric, and build on the workspace dependency graph (\`cargo metadata\`). For EACH recommendation give: the DRIVER (reuse / compile parallelism / dependency inversion / trust boundary / independent semver / test isolation / god-crate split — or, for a merge, "single consumer, no boundary reason"), the BOUNDARY (which module or code), and the HOW. Recommend only — do NOT move code. Return a verdict (Healthy / Concerns / At-risk) and findings.`,
  { label: 'crate-decomposition', phase: 'Audit', schema: FINDINGS_SCHEMA, effort: 'medium' },
).then(r => (r ? { ...r, dimension: 'crate-decomposition' } : null)))
dispatched.push('crate-decomposition')
```

- [ ] **Step 2: Verify**

Run:
```bash
node --check workflows/rust-audit.js && echo "SYNTAX OK"
rg -n "Crate-decomposition dimension \(feature C\)|'crate-decomposition'" workflows/rust-audit.js
```
Expected: `SYNTAX OK`; the block and both `crate-decomposition` references match. Confirm the agent has no `agentType` (a generic agent) and loads the rubric via the prompt.

- [ ] **Step 3: Commit**

```bash
git add workflows/rust-audit.js
git commit -m "feat(rust-audit): crate-decomposition dimension (when/how to extract a crate)"
```

---

### Task 7: `rust-audit` tool dimensions — semver / build-matrix / deps / tests-cov (D–G)

**Files:**
- Modify: `workflows/rust-audit.js` (a `runMutants` arg near the top ~13, and four `tasks.push` blocks inserted before `const results = (await parallel(tasks))`)

**Interfaces:**
- Consumes: `tasks`/`dispatched`, `FINDINGS_SCHEMA`, `args.mutants` (opt-in gate for mutation testing).
- Produces: the `semver`, `build-matrix`, `deps`, `tests-cov` dimensions. Each degrades gracefully (missing tool → non-failing result noting the skip).

- [ ] **Step 1: Add the `runMutants` opt-in gate**

Find:
```javascript
// Optional: pass {base: "origin/main"} as args to fix the diff base for the reviewer.
const baseArg = (args && typeof args === 'object' && args.base) ? String(args.base) : ''
```
Replace with:
```javascript
// Optional args: {base: "origin/main"} fixes the diff base; {mutants: true} opts into the slow
// mutation-testing pass in the tests-cov dimension.
const baseArg = (args && typeof args === 'object' && args.base) ? String(args.base) : ''
const runMutants = !!(args && typeof args === 'object' && args.mutants)
```

- [ ] **Step 2: Insert the four tool-dimension thunks**

Immediately before:
```javascript
const results = (await parallel(tasks)).filter(Boolean)
```
insert:
```javascript
// ---- Whole-project tool dimensions (D–G). Each runs its tools, interprets, and degrades
// gracefully: a missing tool/toolchain is an intentional skip (verdict Approve + a note), never a
// failure. ----

tasks.push(() => agent(
  `Check public-API semver compatibility across the workspace's PUBLISHED crates. Run \`cargo semver-checks check-release\` (per published crate as needed). If \`cargo-semver-checks\` is not installed, or there is no published library crate, say so and return verdict "Approve" with a one-line note that it was skipped — do NOT fail. Load the rust-ecosystem skill (semver/publishing) and the rust-review api-design pass. Report breaking changes vs the published baseline as findings.`,
  { label: 'semver', phase: 'Audit', schema: FINDINGS_SCHEMA, effort: 'low' },
).then(r => (r ? { ...r, dimension: 'semver' } : null)))
dispatched.push('semver')

tasks.push(() => agent(
  `Check the build across feature combinations and the MSRV. If \`cargo-hack\` is installed: \`cargo hack check --feature-powerset --no-dev-deps\`, plus \`cargo check --no-default-features\` and \`cargo check --all-features\`. For MSRV: read \`rust-version\` from Cargo.toml and run \`cargo hack --rust-version check\` (or \`cargo +<rust-version> check\` if that toolchain is installed). Skip any tool/toolchain that is absent with a note, and return "Approve" if nothing could run — do NOT fail. Load the rust-ecosystem skill. Report failing feature combinations or MSRV breakage as findings.`,
  { label: 'build-matrix', phase: 'Audit', schema: FINDINGS_SCHEMA, effort: 'low' },
).then(r => (r ? { ...r, dimension: 'build-matrix' } : null)))
dispatched.push('build-matrix')

tasks.push(() => agent(
  `Audit dependency HYGIENE (distinct from security vulns/licenses). Run \`cargo tree -d\` (duplicate/conflicting versions that bloat the build and binary), \`cargo machete\` (unused dependencies; or \`cargo +nightly udeps\` if machete is absent), and \`cargo outdated\` (out-of-date deps). Skip any tool that is not installed with a note — do NOT fail. Load the rust-ecosystem skill (dependency weight/hygiene). Report duplicates, unused deps, and notably out-of-date deps as findings.`,
  { label: 'deps', phase: 'Audit', schema: FINDINGS_SCHEMA, effort: 'low' },
).then(r => (r ? { ...r, dimension: 'deps' } : null)))
dispatched.push('deps')

tasks.push(() => agent(
  `Assess test effectiveness and docs. Run \`cargo llvm-cov --summary-only\` (overall coverage + worst-covered files) if \`cargo-llvm-cov\` is installed.${runMutants ? ' Run \`cargo mutants --timeout 60\`, time-boxed, to surface weak spots (it is slow).' : ' Do NOT run cargo mutants (not requested via {mutants:true}).'} Build docs cleanly: \`cargo doc --no-deps\` (flag broken intra-doc links) and run doctests (\`cargo test --doc\`). Skip any tool that is not installed with a note — do NOT fail. Load the rust-testing skill (coverage/mutation/doctests) and rust-idioms (rustdoc). Report low-coverage hotspots, surviving mutants, broken doc links, and failing doctests as findings.`,
  { label: 'tests-cov', phase: 'Audit', schema: FINDINGS_SCHEMA, effort: 'low' },
).then(r => (r ? { ...r, dimension: 'tests-cov' } : null)))
dispatched.push('tests-cov')

```

- [ ] **Step 3: Verify**

Run:
```bash
node --check workflows/rust-audit.js && echo "SYNTAX OK"
rg -n "const runMutants =|'semver'|'build-matrix'|'deps'|'tests-cov'|cargo hack check --feature-powerset|cargo mutants" workflows/rust-audit.js
```
Expected: `SYNTAX OK`; the `runMutants` gate, all four dimension labels, the `cargo hack` command, and the gated `cargo mutants` reference all match.

- [ ] **Step 4: Commit**

```bash
git add workflows/rust-audit.js
git commit -m "feat(rust-audit): semver / build-matrix / deps / tests-cov tool dimensions"
```

---

### Task 8: `rust-audit` synthesis + meta refresh

**Files:**
- Modify: `workflows/rust-audit.js` (`meta.description` ~3 and `meta.phases` ~5-9; the synthesis prompt ~114-126)

**Interfaces:**
- Consumes: `dispatched`/`results`/`notRun`.
- Produces: a synthesis prompt and `meta` that reflect the full dimension set.

- [ ] **Step 1: Refresh `meta.description` and `meta.phases`**

Find:
```javascript
  description: 'Full Rust crate audit — review, architecture, security, and Miri in parallel, synthesized into one report',
  whenToUse: 'Before a release or a big merge, when you want every craft review agent run at once and consolidated into a single verdict.',
  phases: [
    { title: 'Scout', detail: 'detect the diff base and whether the workspace has unsafe code', model: 'haiku' },
    { title: 'Audit', detail: 'parallel rust-reviewer / rust-architecture-reviewer / rust-security-scanner / rust-miri' },
    { title: 'Synthesize', detail: 'merge the verdicts into one severity-ranked report' },
  ],
```
Replace with:
```javascript
  description: 'Full Rust crate audit — per-crate review, inter-crate contracts, architecture, crate decomposition, security, Miri, semver, build-matrix, deps, and test/doc health in parallel, synthesized into one report',
  whenToUse: 'Before a release or a big merge, when you want the comprehensive full review — every craft dimension run at once and consolidated into a single verdict. Pass {base} to fix the diff base; {mutants:true} to include the slow mutation pass.',
  phases: [
    { title: 'Scout', detail: 'detect the diff base, unsafe code, and the workspace crates + dependency edges', model: 'haiku' },
    { title: 'Audit', detail: 'parallel per-crate review + per-edge contracts + architecture + crate-decomposition + security + Miri + semver/build-matrix/deps/tests-cov' },
    { title: 'Synthesize', detail: 'merge every dimension into one severity-ranked report' },
  ],
```

- [ ] **Step 2: Update the synthesis prompt for the new dimension families**

Find:
```javascript
  `You are consolidating a Rust audit. Below are JSON results from independent review agents. Produce ONE markdown report — do not invent findings, only merge what is given:

1. An **overall verdict** line — the worst case across all dimensions. If any dimension did not run, mark the audit INCOMPLETE.
2. A **dimension → verdict** table. Add a row for every dimension under NOT RUN below with verdict \`NOT RUN\` — its agent failed or was skipped, so do not treat its absence as a pass.
3. **Findings by severity** (Critical first), each tagged with its dimension and location, plus a one-line fix direction.
4. A short **"Fix first"** list — the few highest-leverage items.
5. If the review dimension's summary names a **gate provenance** (CI vs local), surface it in one line under the verdict so a reader knows whether the mechanical gate was consumed from CI or run locally.
```
Replace with:
```javascript
  `You are consolidating a Rust audit. Below are JSON results from independent review agents. Dimensions come in families: \`review:<crate>\` (one per crate reviewed), \`contract:<from>→<to>\` (one per inter-crate dependency edge), \`crate-decomposition\` (extract/merge recommendations), \`architecture\`, \`security\`, \`miri\`, and the tool dimensions \`semver\`/\`build-matrix\`/\`deps\`/\`tests-cov\`. Produce ONE markdown report — do not invent findings, only merge what is given:

1. An **overall verdict** line — the worst case across all dimensions. If any dimension did not run, mark the audit INCOMPLETE.
2. A **dimension → verdict** table with one row per dimension present (list each \`review:<crate>\` and \`contract:<from>→<to>\` separately). Add a row for every dimension under NOT RUN below with verdict \`NOT RUN\` — its agent failed, so do not treat its absence as a pass.
3. **Findings by severity** (Critical first), each tagged with its dimension and location, plus a one-line fix direction.
4. A short **"Fix first"** list — the few highest-leverage items across all dimensions.
5. A **"Crate boundaries"** note: summarise the \`crate-decomposition\` extract/merge recommendations (driver + boundary), if any.
6. If a \`review:*\` dimension's summary names a **gate provenance** (CI vs local), surface it in one line under the verdict.
```

- [ ] **Step 3: Verify**

Run:
```bash
node --check workflows/rust-audit.js && echo "SYNTAX OK"
rg -n "per-crate review, inter-crate contracts|review:<crate>|Crate boundaries|crate-decomposition extract/merge" workflows/rust-audit.js
```
Expected: `SYNTAX OK`; the new description, the `review:<crate>` family note, and the "Crate boundaries" synthesis item all match.

- [ ] **Step 4: Final whole-file check**

Run:
```bash
node --check workflows/rust-audit.js && echo "SYNTAX OK"
rg -n "Date\.now|Math\.random|new Date" workflows/rust-audit.js || echo "no forbidden APIs"
rg -c "tasks.push" workflows/rust-audit.js
```
Expected: `SYNTAX OK`; `no forbidden APIs`; `tasks.push` count is at least 9 (review fallback or per-crate loop, contracts loop, architecture, security, miri, crate-decomposition, semver, build-matrix, deps, tests-cov).

- [ ] **Step 5: Commit**

```bash
git add workflows/rust-audit.js
git commit -m "feat(rust-audit): synthesis + meta for the comprehensive dimension set"
```

---

## Self-Review

**1. Spec coverage**

- Feature A — `rust-review` optional `path` → Task 1; per-crate fan-out + selection/fallback → Task 4 (uses `reviewResult` + dynamic scaffolding from Task 3). ✓
- `rust-audit` Scout crates/changedCrates/edges → Task 3. ✓
- Feature B — contracts per touched edge, `craft:rust-reviewer`, api-design+errors+traits rubric, skip-when-no-edges → Task 5. ✓
- Feature C — crate-extraction rubric sub-file + link → Task 2; crate-decomposition dimension → Task 6. ✓
- Tool dimensions D–G (semver / build-matrix / deps / tests-cov), graceful degradation, mutation gated → Task 7. ✓
- Synthesis handles `review:<crate>` + `contract:<from>→<to>` + crate-decomposition + tool dims; NOT-RUN from `dispatched`; meta refreshed → Tasks 3 (notRun) + 8. ✓
- Nesting one level (audit → review only), no forbidden APIs → enforced by Global Constraints + Task 8 Step 4 check. ✓

**2. Placeholder scan:** No TBD/TODO/"handle edge cases". Every step shows the exact find/replace text or full new content and an exact verification command. ✓

**3. Type/name consistency:** `reviewResult(dimension, report)` defined in Task 3, used in Tasks 3-4. `crates`/`changedCrates`/`edges` defined in Task 3, consumed in Tasks 4-5. `dispatched` labels exactly match each thunk's emitted `dimension` (`review:<name>`, `contract:<from>→<to>` with the `→` arrow in both `dimension` and `dispatched`, `crate-decomposition`, `semver`/`build-matrix`/`deps`/`tests-cov`), so `notRun = dispatched.filter(d => !ran.has(d))` is correct. `runMutants` defined in Task 7 Step 1, consumed in the same task's tests-cov thunk. `args.path` produced in Task 1, consumed in Task 4. ✓
