# opencode Observability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the opencode `/rust-audit` and `/triage-findings` workflows write structured run records to the shared `~/.craft/runs/` store, and add an explicit `runtime` discriminator to both runtimes' records.

**Architecture:** opencode is not sandboxed — the plugin (`PluginCtx`) has `$` (Bun shell) and `node:fs`, so it logs deterministically in TypeScript with no logger agent. A new plain-JS module `opencode/plugin/run-record.mjs` (node-testable, like `lib/run-record.mjs`) holds the pure record-shaping helpers plus a best-effort `writeRecord`. The Claude Code side gains only a `runtime: "claude-code"` field.

**Tech Stack:** Plain JavaScript (Node built-in test runner, no deps); TypeScript opencode plugin (Bun); markdown agents/docs.

## Global Constraints

- opencode records are deterministic-minimum: NO `findings.bySeverity`, NO `outputTokens`; `findings` is `null`; `verdict` is parsed from text. These omissions are intentional, not bugs.
- Shared store `~/.craft/runs/` with `schemaVersion: 1`: `index.jsonl` (one compact line per run) + `<ts>-<kind>-<name>.json` (detail). `ts` is filesystem-safe UTC `YYYY-MM-DDTHH-MM-SSZ`.
- `runtime` field: opencode records carry `"opencode"`; Claude Code records carry `"claude-code"`.
- Claude Code inlined helper copies in `workflows/rust-audit.js` and `workflows/rust-review.js` MUST stay byte-identical to the matching exports in `lib/run-record.mjs`.
- opencode logging is **best-effort**: a failure in `writeRecord` must never throw into the workflow.
- No new runtime dependencies; opencode tests run via `node --test` (no Bun required for the `.mjs` module).
- No Claude/Co-Authored-By attribution on commits.

---

## File Structure

- `lib/run-record.mjs` — **modify.** `indexProjection` carries `runtime`.
- `lib/run-record.test.mjs` — **modify.** `indexProjection` test asserts `runtime` passthrough.
- `workflows/rust-audit.js` — **modify.** `auditRecord` gains `runtime: 'claude-code'`; inline `indexProjection` copy updated.
- `workflows/rust-review.js` — **modify.** `reviewRecord` gains `runtime: 'claude-code'`; inline `indexProjection` copy updated.
- `agents/rust-reviewer.md`, `agents/rust-security-scanner.md`, `agents/rust-miri.md`, `agents/rust-architecture-reviewer.md` — **modify.** Self-log JSON line gains `"runtime":"claude-code"`.
- `docs/observability.md` — **modify.** Document the `runtime` field and the opencode subset.
- `opencode/plugin/run-record.mjs` — **new.** Pure helpers + `writeRecord`.
- `opencode/plugin/run-record.test.mjs` — **new.** `node --test` coverage.
- `opencode/plugin/rust-audit.ts` — **modify.** Build + write the audit record before returning.
- `opencode/plugin/triage-findings.ts` — **modify.** Build + write the triage record before returning.
- `opencode/README.md` — **modify.** Replace the "no observability" caveat with an Observability subsection.

---

### Task 1: Add the `runtime` field to Claude Code records

**Files:**
- Modify: `lib/run-record.mjs`, `lib/run-record.test.mjs`, `workflows/rust-audit.js`, `workflows/rust-review.js`, `agents/rust-reviewer.md`, `agents/rust-security-scanner.md`, `agents/rust-miri.md`, `agents/rust-architecture-reviewer.md`, `docs/observability.md`

**Interfaces:**
- Consumes: nothing.
- Produces: `indexProjection(record)` now emits `runtime: r.runtime ?? null`; Claude Code workflow/agent records carry `runtime: "claude-code"`.

- [ ] **Step 1: Update the `indexProjection` test to expect `runtime`**

In `lib/run-record.test.mjs`, replace the existing `indexProjection` test with:

```js
test('indexProjection keeps only summary fields and passes runtime through', () => {
  const rec = {
    schemaVersion: 1, runtime: 'claude-code', ts: 'T', kind: 'workflow', name: 'rust-audit',
    project: '/p', commit: 'abc', dirty: false,
    verdict: 'Warning', findings: { total: 5, bySeverity: {} }, nested: true, via: 'rust-audit',
    outputTokens: 1234, dimensions: [{ dimension: 'security' }], scout: { x: 1 },
  }
  assert.deepEqual(indexProjection(rec), {
    schemaVersion: 1, runtime: 'claude-code', ts: 'T', kind: 'workflow', name: 'rust-audit',
    project: '/p', commit: 'abc', dirty: false,
    verdict: 'Warning', findingsTotal: 5, nested: true, via: 'rust-audit', outputTokens: 1234,
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test lib/run-record.test.mjs`
Expected: FAIL — the `indexProjection` test fails because the output is missing `runtime`.

- [ ] **Step 3: Add `runtime` to `lib/run-record.mjs` `indexProjection`**

In `lib/run-record.mjs`, replace:

```js
    schemaVersion: r.schemaVersion, ts: r.ts, kind: r.kind, name: r.name,
```

with:

```js
    schemaVersion: r.schemaVersion, runtime: r.runtime ?? null, ts: r.ts, kind: r.kind, name: r.name,
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test lib/run-record.test.mjs`
Expected: PASS — all tests pass.

- [ ] **Step 5: Mirror the `indexProjection` change into both workflow inline copies**

The exact same substring exists in `workflows/rust-audit.js` and `workflows/rust-review.js`. In BOTH files, replace:

```js
    schemaVersion: r.schemaVersion, ts: r.ts, kind: r.kind, name: r.name,
```

with:

```js
    schemaVersion: r.schemaVersion, runtime: r.runtime ?? null, ts: r.ts, kind: r.kind, name: r.name,
```

- [ ] **Step 6: Add `runtime` to the `auditRecord` object**

In `workflows/rust-audit.js`, replace:

```js
const auditRecord = {
  schemaVersion: 1,
  kind: 'workflow',
  name: 'rust-audit',
```

with:

```js
const auditRecord = {
  schemaVersion: 1,
  runtime: 'claude-code',
  kind: 'workflow',
  name: 'rust-audit',
```

- [ ] **Step 7: Add `runtime` to the `reviewRecord` factory**

In `workflows/rust-review.js`, replace:

```js
  return {
    schemaVersion: 1,
    kind: 'workflow',
    name: 'rust-review',
```

with:

```js
  return {
    schemaVersion: 1,
    runtime: 'claude-code',
    kind: 'workflow',
    name: 'rust-review',
```

- [ ] **Step 8: Add `runtime` to each agent's self-log JSON line**

The substring `"schemaVersion":1,"ts":` appears once in each of the four agent files. In EACH of `agents/rust-reviewer.md`, `agents/rust-security-scanner.md`, `agents/rust-miri.md`, `agents/rust-architecture-reviewer.md`, replace:

```
"schemaVersion":1,"ts":
```

with:

```
"schemaVersion":1,"runtime":"claude-code","ts":
```

- [ ] **Step 9: Document the `runtime` field in `docs/observability.md`**

In `docs/observability.md`, find the "Common" fields line that begins:

> Common: `ts`, `kind` (`workflow`|`agent`), `name`, ...

Insert `runtime` (`"claude-code"` | `"opencode"`) into that common-fields list, and append this paragraph immediately after the workflow/agent field descriptions:

```markdown
Records carry a `runtime` field — `"claude-code"` for the Claude Code workflows/agents,
`"opencode"` for the opencode adapter. opencode records are a deterministic subset: `findings`
is `null` (no structured findings), and there is no `outputTokens` (no token meter) — so
`findingsTotal` is `null` in their index projection.
```

- [ ] **Step 10: Verify and commit**

Run: `node --test lib/run-record.test.mjs` → Expected: PASS.
Run: `node --check workflows/rust-audit.js && node --check workflows/rust-review.js` → Expected: exit 0.
Run: `grep -c '"runtime":"claude-code"' agents/*.md | grep -c ':1'` → Expected: `4` (each file has exactly one).
Run: `grep -rc "runtime: 'claude-code'" workflows/*.js` → Expected: `rust-audit.js:1` and `rust-review.js:1`.

```bash
git add lib/run-record.mjs lib/run-record.test.mjs workflows/rust-audit.js workflows/rust-review.js agents/*.md docs/observability.md
git commit -m "feat(observability): add explicit runtime field to records"
```

---

### Task 2: opencode `run-record.mjs` module + tests

**Files:**
- Create: `opencode/plugin/run-record.mjs`
- Test: `opencode/plugin/run-record.test.mjs`

**Interfaces:**
- Produces (consumed by Task 3):
  - `parseVerdict(text) -> 'Block'|'Warning'|'Approve'`
  - `buildAuditRecord({results, baseRef, hasUnsafe, synthesisText}) -> record`
  - `buildTriageRecord({results}) -> record`
  - `indexProjection(record) -> compact object` (carries `runtime`, `findingsTotal`)
  - `async writeRecord(ctx, record) -> Promise<void>` (stamps `ts`/`project`/`commit`/`dirty`, writes the detail file + appends the index line; best-effort)
  - `results` items are opencode `JobResult` shape: `{ label: string, ok: boolean, text: string }`.
  - `ctx` is `PluginCtx`: `{ $, directory, worktree, client }`. `writeRecord` uses `ctx.$` and `ctx.worktree || ctx.directory`. The store dir is `process.env.CRAFT_RUNS_DIR || ~/.craft/runs` (the env override exists only so tests can redirect it).

- [ ] **Step 1: Write the failing tests**

Create `opencode/plugin/run-record.test.mjs`:

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  parseVerdict, buildAuditRecord, buildTriageRecord, indexProjection, writeRecord,
} from './run-record.mjs'

test('parseVerdict picks the worst signal in the text', () => {
  assert.equal(parseVerdict('all good, Approve'), 'Approve')
  assert.equal(parseVerdict('some Warning here'), 'Warning')
  assert.equal(parseVerdict('Concerns about layering'), 'Warning')
  assert.equal(parseVerdict('⛔ Block — must fix'), 'Block')
  assert.equal(parseVerdict('At-risk structure'), 'Block')
  assert.equal(parseVerdict('Miri: UB-found'), 'Block')
  assert.equal(parseVerdict(''), 'Approve')
})

test('buildAuditRecord assembles dimensions, notRun, and a null findings field', () => {
  const rec = buildAuditRecord({
    results: [
      { label: 'security', ok: true, text: 'Approve — clean' },
      { label: 'architecture', ok: false, text: '' },
    ],
    baseRef: 'main', hasUnsafe: false, synthesisText: 'overall verdict: Warning',
  })
  assert.equal(rec.schemaVersion, 1)
  assert.equal(rec.runtime, 'opencode')
  assert.equal(rec.kind, 'workflow')
  assert.equal(rec.name, 'rust-audit')
  assert.equal(rec.verdict, 'Warning')           // parsed from synthesisText
  assert.equal(rec.findings, null)
  assert.equal(rec.nested, false)
  assert.equal(rec.via, null)
  assert.deepEqual(rec.scout, { baseRef: 'main', hasUnsafe: false })
  assert.deepEqual(rec.dimensions, [
    { dimension: 'security', ran: true, verdict: 'Approve' },
    { dimension: 'architecture', ran: false, verdict: '' },
  ])
  assert.deepEqual(rec.notRun, ['architecture'])
})

test('buildTriageRecord uses an empty verdict and per-finding dimensions', () => {
  const rec = buildTriageRecord({
    results: [
      { label: 'f1', ok: true, text: 'OUTCOME: accept' },
      { label: 'f2', ok: false, text: '' },
    ],
  })
  assert.equal(rec.runtime, 'opencode')
  assert.equal(rec.name, 'triage-findings')
  assert.equal(rec.verdict, '')
  assert.equal(rec.findings, null)
  assert.deepEqual(rec.dimensions, [
    { dimension: 'f1', ran: true },
    { dimension: 'f2', ran: false },
  ])
  assert.deepEqual(rec.notRun, ['f2'])
})

test('indexProjection carries runtime and nulls findingsTotal when findings is null', () => {
  const rec = {
    schemaVersion: 1, runtime: 'opencode', ts: 'T', kind: 'workflow', name: 'rust-audit',
    project: '/p', commit: 'abc', dirty: true, verdict: 'Approve', findings: null,
    nested: false, via: null, dimensions: [{ dimension: 'x' }],
  }
  assert.deepEqual(indexProjection(rec), {
    schemaVersion: 1, runtime: 'opencode', ts: 'T', kind: 'workflow', name: 'rust-audit',
    project: '/p', commit: 'abc', dirty: true, verdict: 'Approve', findingsTotal: null,
    nested: false, via: null,
  })
})

test('writeRecord writes a detail file and appends one index line', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'craft-obs-'))
  process.env.CRAFT_RUNS_DIR = dir
  // Fake PluginCtx: $ is a tagged-template returning a .quiet() that yields canned git output.
  const ctx = {
    worktree: '/proj',
    directory: '/proj',
    $: (_strings, ...vals) => ({
      quiet: async () => {
        const cmd = vals.join('')
        if (cmd.includes('rev-parse')) return { stdout: 'abc1234\n' }
        return { stdout: '' } // status --porcelain → clean
      },
    }),
  }
  try {
    await writeRecord(ctx, buildAuditRecord({
      results: [{ label: 'security', ok: true, text: 'Approve' }],
      baseRef: 'main', hasUnsafe: false, synthesisText: 'Approve',
    }))
    const lines = readFileSync(join(dir, 'index.jsonl'), 'utf8').trim().split('\n')
    assert.equal(lines.length, 1)
    const line = JSON.parse(lines[0])
    assert.equal(line.runtime, 'opencode')
    assert.equal(line.kind, 'workflow')
    assert.equal(line.name, 'rust-audit')
    assert.equal(line.project, '/proj')
    assert.equal(line.commit, 'abc1234')
    assert.equal(line.dirty, false)
    assert.equal(line.findingsTotal, null)
    assert.match(line.ts, /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z$/)
    const detail = readdirSync(dir).filter((f) => f.endsWith('.json'))
    assert.equal(detail.length, 1)
  } finally {
    delete process.env.CRAFT_RUNS_DIR
  }
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test opencode/plugin/run-record.test.mjs`
Expected: FAIL — `Cannot find module './run-record.mjs'`.

- [ ] **Step 3: Write the module**

Create `opencode/plugin/run-record.mjs`:

```js
// Observability run-record helpers for the opencode adapter. Plain JS (no opencode imports) so it
// is node --test-able. The opencode plugin is NOT sandboxed: this module reads the clock and writes
// files directly, so there is no logger agent (unlike the Claude Code workflows). opencode records
// are a deterministic subset of the shared schema: no findings.bySeverity, no outputTokens.
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

// Worst-signal-wins, mirroring the Claude Code workflows' verdict precedence.
export function parseVerdict(text) {
  const t = String(text || '')
  if (/⛔|Block|At-risk|UB-found/i.test(t)) return 'Block'
  if (/⚠️|Warning|Concerns/i.test(t)) return 'Warning'
  return 'Approve'
}

export function buildAuditRecord({ results, baseRef, hasUnsafe, synthesisText }) {
  const rs = Array.isArray(results) ? results : []
  return {
    schemaVersion: 1,
    runtime: 'opencode',
    kind: 'workflow',
    name: 'rust-audit',
    verdict: parseVerdict(synthesisText),
    findings: null,
    nested: false,
    via: null,
    scout: { baseRef: baseRef || '', hasUnsafe: !!hasUnsafe },
    dimensions: rs.map((r) => ({ dimension: r.label, ran: !!r.ok, verdict: r.ok ? parseVerdict(r.text) : '' })),
    notRun: rs.filter((r) => !r.ok).map((r) => r.label),
  }
}

export function buildTriageRecord({ results }) {
  const rs = Array.isArray(results) ? results : []
  return {
    schemaVersion: 1,
    runtime: 'opencode',
    kind: 'workflow',
    name: 'triage-findings',
    verdict: '',
    findings: null,
    nested: false,
    via: null,
    dimensions: rs.map((r) => ({ dimension: r.label, ran: !!r.ok })),
    notRun: rs.filter((r) => !r.ok).map((r) => r.label),
  }
}

export function indexProjection(r) {
  return {
    schemaVersion: r.schemaVersion, runtime: r.runtime ?? null, ts: r.ts, kind: r.kind, name: r.name,
    project: r.project, commit: r.commit, dirty: r.dirty,
    verdict: r.verdict, findingsTotal: r.findings ? r.findings.total : null,
    nested: r.nested, via: r.via,
  }
}

function runsDir() {
  return process.env.CRAFT_RUNS_DIR || join(homedir(), '.craft', 'runs')
}

// Filesystem-safe UTC: YYYY-MM-DDTHH-MM-SSZ (drop millis, replace the time colons).
function tsStamp(d) {
  return d.toISOString().replace(/\.\d{3}Z$/, 'Z').replace(/:/g, '-')
}

async function sh(ctx, cmd) {
  try {
    const r = await ctx.$`bash -lc ${cmd}`.quiet()
    return (r.stdout?.toString?.() ?? String(r.stdout ?? '')).trim()
  } catch {
    return ''
  }
}

// Best-effort: stamp the runtime fields, write the detail file, append the index line. NEVER throws
// into the caller — observability must not break a workflow run.
export async function writeRecord(ctx, record) {
  try {
    const dir = runsDir()
    const ts = tsStamp(new Date())
    const project = ctx.worktree || ctx.directory || (await sh(ctx, 'pwd'))
    const commit = await sh(ctx, 'git rev-parse --short HEAD 2>/dev/null')
    const dirty = (await sh(ctx, 'git status --porcelain 2>/dev/null')).length > 0
    const full = { ...record, ts, project, commit, dirty }
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, `${ts}-${full.kind}-${full.name}.json`), JSON.stringify(full, null, 2) + '\n')
    appendFileSync(join(dir, 'index.jsonl'), JSON.stringify(indexProjection(full)) + '\n')
  } catch (e) {
    try { console.error(`craft observability: failed to write run record: ${e?.message ?? e}`) } catch { /* ignore */ }
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test opencode/plugin/run-record.test.mjs`
Expected: PASS — all 5 tests pass.

- [ ] **Step 5: Commit**

```bash
git add opencode/plugin/run-record.mjs opencode/plugin/run-record.test.mjs
git commit -m "feat(opencode): run-record module for observability"
```

---

### Task 3: Wire the opencode workflows + docs

**Files:**
- Modify: `opencode/plugin/rust-audit.ts`, `opencode/plugin/triage-findings.ts`, `opencode/README.md`

**Interfaces:**
- Consumes: `buildAuditRecord`, `buildTriageRecord`, `writeRecord` from `./run-record.mjs` (Task 2).

- [ ] **Step 1: Import the record helpers in `rust-audit.ts`**

In `opencode/plugin/rust-audit.ts`, replace the import line:

```ts
import { fanOut, runAgent, type Job } from "./orchestrator.ts"
```

with:

```ts
import { fanOut, runAgent, type Job } from "./orchestrator.ts"
import { buildAuditRecord, writeRecord } from "./run-record.mjs"
```

- [ ] **Step 2: Build + write the audit record before returning**

In `opencode/plugin/rust-audit.ts`, replace the final return:

```ts
  return await runAgent(ctx, "", synthPrompt).catch(() => blob) || blob
}
```

with:

```ts
  const report = (await runAgent(ctx, "", synthPrompt).catch(() => blob)) || blob
  await writeRecord(ctx, buildAuditRecord({ results, baseRef, hasUnsafe, synthesisText: report }))
  return report
}
```

- [ ] **Step 3: Import the record helpers in `triage-findings.ts`**

In `opencode/plugin/triage-findings.ts`, replace the import line:

```ts
import { fanOut, runAgent, type Job } from "./orchestrator.ts"
```

with:

```ts
import { fanOut, runAgent, type Job } from "./orchestrator.ts"
import { buildTriageRecord, writeRecord } from "./run-record.mjs"
```

- [ ] **Step 4: Build + write the triage record before returning**

In `opencode/plugin/triage-findings.ts`, replace the final return:

```ts
  return (await runAgent(ctx, "", planPrompt).catch(() => ledger)) || ledger
}
```

with:

```ts
  const plan = (await runAgent(ctx, "", planPrompt).catch(() => ledger)) || ledger
  await writeRecord(ctx, buildTriageRecord({ results: validated }))
  return plan
}
```

- [ ] **Step 5: Replace the README parity caveat with an Observability subsection**

In `opencode/README.md`, replace this bullet:

```markdown
- **No observability run-records.** The Claude Code workflows/agents emit a structured run record
  to `~/.craft/runs/` (see `docs/observability.md`); the opencode adapters do not.
```

with:

```markdown
- **Observability is a deterministic subset.** `/rust-audit` and `/triage-findings` write a run
  record to the shared `~/.craft/runs/` store (`runtime: "opencode"`), straight from the plugin —
  no logger agent. Because opencode agents return free text (not schema-validated JSON), the record
  captures `ts`/`project`/`commit`/`dirty`, which dimensions ran vs `notRun`, and a `verdict` parsed
  from the synthesis text — but NOT `findings.bySeverity` or `outputTokens` (`findings` is `null`).
  The hidden review agents do not self-log, so a standalone hidden-agent invocation is not recorded.
```

- [ ] **Step 6: Verify the wiring**

Run: `node --test opencode/plugin/run-record.test.mjs` → Expected: PASS (unchanged — the module is intact).
Run: `grep -c "writeRecord(ctx, buildAuditRecord" opencode/plugin/rust-audit.ts` → Expected: `1`.
Run: `grep -c "writeRecord(ctx, buildTriageRecord" opencode/plugin/triage-findings.ts` → Expected: `1`.
Run: `grep -c 'from "./run-record.mjs"' opencode/plugin/rust-audit.ts opencode/plugin/triage-findings.ts` → Expected: each `1`.

(There is no Bun/tsc in this environment, so the `.ts` files cannot be type-checked here; the record logic is fully covered by the `.mjs` tests. The edits are additive imports + two call sites following the existing `sh`/return patterns.)

- [ ] **Step 7: Commit**

```bash
git add opencode/plugin/rust-audit.ts opencode/plugin/triage-findings.ts opencode/README.md
git commit -m "feat(opencode): emit run records from /rust-audit and /triage-findings"
```

---

## Self-Review

**1. Spec coverage:**
- Plugin-side logging for both opencode workflows → Task 3. ✅
- New `run-record.mjs` module (pure helpers + `writeRecord`) → Task 2. ✅
- Deterministic-minimum fidelity (`findings: null`, verdict parsed, dimensions/notRun) → Task 2 `buildAuditRecord`/`buildTriageRecord` + tests. ✅
- Same store, `schemaVersion: 1`, filesystem-safe `ts` → Task 2 `writeRecord`/`tsStamp` + test asserting the ts regex. ✅
- `runtime` explicit on both runtimes → Task 1 (Claude Code) + Task 2 (opencode `"opencode"`). ✅
- No logger agent; clock + git via plugin → Task 2 `writeRecord`. ✅
- Best-effort (never throws) → Task 2 `writeRecord` try/catch + comment. ✅
- Testing: pure fns + `writeRecord` integration with a fake ctx + `CRAFT_RUNS_DIR` → Task 2 tests. ✅
- Docs: `docs/observability.md` runtime + subset (Task 1 Step 9); `opencode/README.md` Observability subsection (Task 3 Step 5). ✅
- Out of scope (agent self-log in opencode, bySeverity/outputTokens, rust-review engine) → not implemented; documented in Task 3 Step 5. ✅

**2. Placeholder scan:** No TBD/TODO/vague steps; every code step has complete code; every command has expected output. ✅

**3. Type consistency:** `JobResult` shape `{label, ok, text}` is used consistently in `buildAuditRecord`/`buildTriageRecord` and the tests. `buildAuditRecord` takes `{results, baseRef, hasUnsafe, synthesisText}` — Task 3 Step 2 calls it with exactly those keys (`synthesisText: report`). `buildTriageRecord({results})` — Task 3 Step 4 calls it with `results: validated`. `writeRecord(ctx, record)` signature matches both call sites. `indexProjection` output keys match between the opencode module (Task 2) and its test. The Claude Code inline `indexProjection` edit (Task 1 Step 5) is the identical substring across `lib` + both workflows, keeping them byte-identical. ✅
