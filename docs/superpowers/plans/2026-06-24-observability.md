# Observability for craft reviews — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist a durable, structured record of every craft review/audit run to a global store so runs can be studied later (finding quality, cost, trends, workflow improvement).

**Architecture:** Workflow scripts run sandboxed (no filesystem, no clock), so they assemble a plain record object from what they know and hand it to a cheap **logger agent** that stamps runtime fields (`ts`/`project`/`commit`/`dirty`) and writes it to `~/.craft/runs/`. The bug-prone record-shaping helpers live in a tested `lib/run-record.mjs`; the workflow scripts inline verbatim copies (the sandbox can't `import`). Standalone agents self-log via an Observability section in their `.md`, suppressed when run as a workflow sub-agent.

**Tech Stack:** Plain JavaScript (Node built-in test runner, no deps); craft workflow scripts (`workflows/*.js`); agent prompt markdown (`agents/*.md`).

## Global Constraints

- Workflow scripts: **no filesystem access**, and `Date.now()`/`new Date()`/`Math.random()` throw. Only an agent step may write files or read the clock.
- Workflow scripts MUST begin with `export const meta = {...}` as a pure literal; body uses `agent()`/`parallel()`/`pipeline()`/`phase()`/`log()`/`budget`.
- `budget.spent()` is the only in-script cost signal (output tokens this turn, shared pool — approximate).
- Store location: `~/.craft/runs/` — `index.jsonl` (append-only, one compact line per run) + `<ts>-<kind>-<name>.json` (full per-run detail) + `README.md`.
- `ts` filesystem-safe UTC form: `date -u +%Y-%m-%dT%H-%M-%SZ` (e.g. `2026-06-24T14-30-00Z`).
- Record `schemaVersion: 1`.
- No Claude attribution in commits (per repo CLAUDE.md).
- The inline helper copies in `workflows/rust-audit.js` and `workflows/rust-review.js` MUST stay byte-identical to the exported functions in `lib/run-record.mjs`.

---

## File Structure

- `lib/run-record.mjs` — **new.** Canonical, tested pure helpers: severity counting, verdict derivation, index projection. Workflows inline copies of these.
- `lib/run-record.test.mjs` — **new.** `node --test` unit tests for the helpers.
- `workflows/rust-audit.js` — **modify.** Inline helpers + `logRun`; expose verification counts from the `unused-crates` thunk; build + log the audit record before `return`; append observability-suppression line to the four `agentType` sub-prompts; pass `_via` to the nested `rust-review`.
- `workflows/rust-review.js` — **modify.** Inline helpers + `logRun` + `reviewRecord`; read `_via` arg; append suppression line to `lensPrompt`; build + log a record before each of the three `return`s.
- `agents/rust-reviewer.md`, `agents/rust-security-scanner.md`, `agents/rust-miri.md`, `agents/rust-architecture-reviewer.md` — **modify.** Add an `## Observability` section (self-log unless told the workflow owns it).
- `docs/observability.md` — **new.** Repo-side reference to the store format (points at the spec).
- `MAP.md` — **modify.** One pointer line.

---

### Task 1: Tested record-shaping helpers (`lib/run-record.mjs`)

**Files:**
- Create: `lib/run-record.mjs`
- Test: `lib/run-record.test.mjs`

**Interfaces:**
- Produces (consumed by Tasks 2 & 3 as inlined copies, and by the test):
  - `SEVERITIES: string[]`
  - `countBySeverity(findings: Array<{severity?}>) -> {Critical,High,Medium,Low,Info}`
  - `summarizeFindings(findings) -> {total:int, bySeverity}`
  - `worstVerdict(verdicts: string[]) -> 'Block'|'Warning'|'Approve'`
  - `reviewVerdict(confirmed: Array<{severity}>) -> 'Block'|'Warning'|'Approve'`
  - `refuteRate(candidates:int, confirmed:int) -> number` (fraction dropped, 2-dp)
  - `indexProjection(record) -> compact object`

- [ ] **Step 1: Write the failing test**

Create `lib/run-record.test.mjs`:

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  countBySeverity, summarizeFindings, worstVerdict, reviewVerdict, refuteRate, indexProjection,
} from './run-record.mjs'

test('countBySeverity tallies known severities, ignores unknown and malformed', () => {
  assert.deepEqual(
    countBySeverity([{ severity: 'Critical' }, { severity: 'Critical' }, { severity: 'Low' }, { severity: 'Bogus' }, {}]),
    { Critical: 2, High: 0, Medium: 0, Low: 1, Info: 0 },
  )
})

test('countBySeverity tolerates non-array input', () => {
  assert.deepEqual(countBySeverity(null), { Critical: 0, High: 0, Medium: 0, Low: 0, Info: 0 })
})

test('summarizeFindings totals across severities', () => {
  const got = summarizeFindings([{ severity: 'High' }, { severity: 'Info' }, { severity: 'High' }])
  assert.equal(got.total, 3)
  assert.equal(got.bySeverity.High, 2)
})

test('worstVerdict picks the worst across mixed vocabularies', () => {
  assert.equal(worstVerdict(['Approve', 'Concerns', 'At-risk']), 'Block')
  assert.equal(worstVerdict(['Approve', 'Warning']), 'Warning')
  assert.equal(worstVerdict(['Approve', 'Healthy', 'Clean']), 'Approve')
  assert.equal(worstVerdict(['UB-found']), 'Block')
})

test('reviewVerdict is driven by confirmed severities', () => {
  assert.equal(reviewVerdict([{ severity: 'High' }]), 'Block')
  assert.equal(reviewVerdict([{ severity: 'Medium' }]), 'Warning')
  assert.equal(reviewVerdict([{ severity: 'Low' }, { severity: 'Info' }]), 'Approve')
  assert.equal(reviewVerdict([]), 'Approve')
})

test('refuteRate is the dropped fraction, 2-dp, safe at zero', () => {
  assert.equal(refuteRate(4, 1), 0.75)
  assert.equal(refuteRate(2, 2), 0)
  assert.equal(refuteRate(0, 0), 0)
  assert.equal(refuteRate(3, 0), 1)
})

test('indexProjection keeps only summary fields', () => {
  const rec = {
    schemaVersion: 1, ts: 'T', kind: 'workflow', name: 'rust-audit', project: '/p', commit: 'abc', dirty: false,
    verdict: 'Warning', findings: { total: 5, bySeverity: {} }, nested: true, via: 'rust-audit',
    outputTokens: 1234, dimensions: [{ dimension: 'security' }], scout: { x: 1 },
  }
  assert.deepEqual(indexProjection(rec), {
    schemaVersion: 1, ts: 'T', kind: 'workflow', name: 'rust-audit', project: '/p', commit: 'abc', dirty: false,
    verdict: 'Warning', findingsTotal: 5, nested: true, via: 'rust-audit', outputTokens: 1234,
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test lib/run-record.test.mjs`
Expected: FAIL — `Cannot find module '.../lib/run-record.mjs'`.

- [ ] **Step 3: Write the implementation**

Create `lib/run-record.mjs`:

```js
// Canonical, tested helpers for building craft run records.
// NOTE: workflow scripts run sandboxed and cannot import — they inline VERBATIM copies of these
// functions. Keep the copies in workflows/rust-audit.js and workflows/rust-review.js in sync.

export const SEVERITIES = ['Critical', 'High', 'Medium', 'Low', 'Info']

export function countBySeverity(findings) {
  const by = { Critical: 0, High: 0, Medium: 0, Low: 0, Info: 0 }
  for (const f of (Array.isArray(findings) ? findings : [])) {
    if (f && Object.prototype.hasOwnProperty.call(by, f.severity)) by[f.severity] += 1
  }
  return by
}

export function summarizeFindings(findings) {
  const bySeverity = countBySeverity(findings)
  return { total: SEVERITIES.reduce((n, s) => n + bySeverity[s], 0), bySeverity }
}

export function worstVerdict(verdicts) {
  if (verdicts.some(v => /Block|At-risk|UB-found/i.test(v || ''))) return 'Block'
  if (verdicts.some(v => /Warning|Concerns/i.test(v || ''))) return 'Warning'
  return 'Approve'
}

export function reviewVerdict(confirmed) {
  const by = countBySeverity(confirmed)
  if (by.Critical || by.High) return 'Block'
  if (by.Medium) return 'Warning'
  return 'Approve'
}

export function refuteRate(candidates, confirmed) {
  const c = Number(candidates) || 0
  const k = Number(confirmed) || 0
  if (c <= 0) return 0
  return Math.round(((c - k) / c) * 100) / 100
}

export function indexProjection(r) {
  return {
    schemaVersion: r.schemaVersion, ts: r.ts, kind: r.kind, name: r.name,
    project: r.project, commit: r.commit, dirty: r.dirty,
    verdict: r.verdict, findingsTotal: r.findings ? r.findings.total : 0,
    nested: r.nested, via: r.via, outputTokens: r.outputTokens ?? null,
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test lib/run-record.test.mjs`
Expected: PASS — all 7 tests pass.

- [ ] **Step 5: Commit**

```bash
git add lib/run-record.mjs lib/run-record.test.mjs
git commit -m "feat(observability): tested run-record shaping helpers"
```

---

### Task 2: Instrument `rust-audit.js`

**Files:**
- Modify: `workflows/rust-audit.js`

**Interfaces:**
- Consumes: inlined copies of `countBySeverity`, `summarizeFindings`, `worstVerdict`, `indexProjection` from Task 1; the `budget` global.
- Produces: `logRun(record)` (also inlined verbatim into Task 3); a `rust-audit` workflow record written to `~/.craft/runs/`.

- [ ] **Step 1: Add the inlined helper block + `logRun`**

In `workflows/rust-audit.js`, immediately AFTER the `UNUSED_VERDICT_SCHEMA` definition (the block that ends `removal: { ... },\n  },\n}`), insert:

```js
// ---- run-record helpers (VERBATIM mirror of lib/run-record.mjs — the sandbox can't import; keep in sync) ----
const SEVERITIES = ['Critical', 'High', 'Medium', 'Low', 'Info']
function countBySeverity(findings) {
  const by = { Critical: 0, High: 0, Medium: 0, Low: 0, Info: 0 }
  for (const f of (Array.isArray(findings) ? findings : [])) {
    if (f && Object.prototype.hasOwnProperty.call(by, f.severity)) by[f.severity] += 1
  }
  return by
}
function summarizeFindings(findings) {
  const bySeverity = countBySeverity(findings)
  return { total: SEVERITIES.reduce((n, s) => n + bySeverity[s], 0), bySeverity }
}
function worstVerdict(verdicts) {
  if (verdicts.some(v => /Block|At-risk|UB-found/i.test(v || ''))) return 'Block'
  if (verdicts.some(v => /Warning|Concerns/i.test(v || ''))) return 'Warning'
  return 'Approve'
}
function indexProjection(r) {
  return {
    schemaVersion: r.schemaVersion, ts: r.ts, kind: r.kind, name: r.name,
    project: r.project, commit: r.commit, dirty: r.dirty,
    verdict: r.verdict, findingsTotal: r.findings ? r.findings.total : 0,
    nested: r.nested, via: r.via, outputTokens: r.outputTokens ?? null,
  }
}
// Drop internal (`_`-prefixed) keys so they never leak into the synthesis prompt.
function stripInternal(obj) {
  const out = {}
  for (const k of Object.keys(obj)) if (!k.startsWith('_')) out[k] = obj[k]
  return out
}
// Persist a run record to ~/.craft/runs via a cheap logger agent (the script has no FS/clock).
async function logRun(record) {
  const index = indexProjection(record)
  await agent(
    `You are the craft observability logger. Persist ONE run record to the global store \`~/.craft/runs/\`. This is mechanical IO — do not analyze.
Steps:
1. \`mkdir -p ~/.craft/runs\`.
2. Compute: TS=\`date -u +%Y-%m-%dT%H-%M-%SZ\`; PROJECT=\`pwd\`; COMMIT=\`git rev-parse --short HEAD 2>/dev/null\` (empty string if not a git repo); DIRTY=true if \`git status --porcelain\` prints anything, else false.
3. Take RECORD below, add fields {"ts":TS,"project":PROJECT,"commit":COMMIT,"dirty":DIRTY}, and write the result as pretty JSON to \`~/.craft/runs/<TS>-<kind>-<name>.json\` (kind and name are fields in RECORD).
4. Take INDEX below, add the same four fields, and append it as ONE compact line (single atomic \`>>\`) to \`~/.craft/runs/index.jsonl\`.
5. If \`~/.craft/runs/README.md\` does not exist, create it describing the store: "craft run records. index.jsonl = one compact JSON line per run (load with jq); <ts>-<kind>-<name>.json = full per-run detail. Common fields: schemaVersion, ts, kind (workflow|agent), name, project, commit, dirty, verdict, findings{total,bySeverity}, nested, via. Workflows add scout/dimensions/verification/notRun/outputTokens; agents add toolsRun." Include two jq examples: \`jq -s 'group_by(.name)[]|{name:.[0].name,runs:length}' index.jsonl\` and \`jq 'select(.verdict|test("Block"))' index.jsonl\`.
Best-effort: if anything fails, report it but do NOT error the run.

RECORD:
${JSON.stringify(record, null, 2)}

INDEX:
${JSON.stringify(index)}`,
    { label: 'log-run', phase: 'Synthesize', model: 'haiku', effort: 'low' },
  )
}
```

- [ ] **Step 2: Expose verification counts from the `unused-crates` thunk**

In the `unused-crates` thunk, the no-candidates early return currently reads:

```js
  if (!candidates.length) return { ...found, dimension: 'unused-crates' }
```

Change it to:

```js
  if (!candidates.length) return { ...found, dimension: 'unused-crates', _verification: { candidates: 0, confirmed: 0 } }
```

And the final return of that thunk currently reads:

```js
  return {
    dimension: 'unused-crates',
    verdict: confirmed.length ? 'Warning' : 'Approve',
    summary: `${candidates.length} candidate(s) flagged; ${confirmed.length} verified unused after trying to refute each (unverified dropped as likely false positives).`,
    findings: confirmed.length ? confirmed : [{ severity: 'Info', title: 'No verified unused crates', location: '', detail: `${candidates.length} candidate(s) flagged, none survived verification.` }],
  }
```

Add the `_verification` field as the last property:

```js
  return {
    dimension: 'unused-crates',
    verdict: confirmed.length ? 'Warning' : 'Approve',
    summary: `${candidates.length} candidate(s) flagged; ${confirmed.length} verified unused after trying to refute each (unverified dropped as likely false positives).`,
    findings: confirmed.length ? confirmed : [{ severity: 'Info', title: 'No verified unused crates', location: '', detail: `${candidates.length} candidate(s) flagged, none survived verification.` }],
    _verification: { candidates: candidates.length, confirmed: confirmed.length },
  }
```

- [ ] **Step 3: Append the suppression line to the four `agentType` sub-prompts**

Add this exact suffix to the END of the prompt string (just before the closing `` ` `` and `,`) of the `contract`, `architecture`, `security`, and `miri` `agent()` calls:

```
\n\nObservability: the rust-audit workflow records this run — do NOT write your own record.
```

For example, the `security` call's prompt changes from ending `...verdict and findings.` to ending `...verdict and findings.\n\nObservability: the rust-audit workflow records this run — do NOT write your own record.` Apply the identical suffix to `contract`, `architecture`, and `miri`.

- [ ] **Step 4: Pass `_via` to the nested `rust-review`**

The two `workflow('rust-review', ...)` calls currently read:

```js
    tasks.push(() => workflow('rust-review', { base: baseRef, path: c.path })
```
```js
    tasks.push(() => workflow('rust-review', baseRef ? { base: baseRef } : {})
```

Change them to thread `_via`:

```js
    tasks.push(() => workflow('rust-review', { base: baseRef, path: c.path, _via: 'rust-audit' })
```
```js
    tasks.push(() => workflow('rust-review', baseRef ? { base: baseRef, _via: 'rust-audit' } : { _via: 'rust-audit' })
```

- [ ] **Step 5: Use `stripInternal` in the synthesis prompt**

The synthesis prompt currently ends:

```js
RESULTS:
${JSON.stringify(results, null, 2)}`,
```

Change to:

```js
RESULTS:
${JSON.stringify(results.map(stripInternal), null, 2)}`,
```

- [ ] **Step 6: Build and log the record before returning**

The file currently ends:

```js
  { label: 'synthesis', effort: 'medium' },
)

return report
```

Replace the `return report` with:

```js
const uc = results.find(r => r.dimension === 'unused-crates')
const auditRecord = {
  schemaVersion: 1,
  kind: 'workflow',
  name: 'rust-audit',
  verdict: worstVerdict(results.map(r => r.verdict)) + (notRun.length ? ' (INCOMPLETE)' : ''),
  findings: summarizeFindings(results.flatMap(r => (Array.isArray(r.findings) ? r.findings : []))),
  nested: false,
  via: null,
  scout: { baseRef, crateCount: crates.length, changedCrateCount: changedCrates.length, edgeCount: edges.length, hasUnsafe },
  dimensions: results.map(stripInternal).map(r => {
    const s = summarizeFindings(r.findings)
    return { dimension: r.dimension, verdict: r.verdict, findingCount: s.total, bySeverity: s.bySeverity }
  }),
  verification: uc && uc._verification
    ? {
      candidates: uc._verification.candidates,
      confirmed: uc._verification.confirmed,
      refuteRate: uc._verification.candidates
        ? Math.round(((uc._verification.candidates - uc._verification.confirmed) / uc._verification.candidates) * 100) / 100
        : 0,
    }
    : null,
  notRun,
  outputTokens: budget.spent(),
}
await logRun(auditRecord)

return report
```

- [ ] **Step 7: Syntax-check**

Run: `node --check workflows/rust-audit.js`
Expected: exit 0, no output.

- [ ] **Step 8: Verify the markers are present**

Run: `grep -c "do NOT write your own record" workflows/rust-audit.js`
Expected: `4`

Run: `grep -c "_via: 'rust-audit'" workflows/rust-audit.js`
Expected: `3`

- [ ] **Step 9: Commit**

```bash
git add workflows/rust-audit.js
git commit -m "feat(observability): emit a run record from rust-audit"
```

---

### Task 3: Instrument `rust-review.js`

**Files:**
- Modify: `workflows/rust-review.js`

**Interfaces:**
- Consumes: inlined `countBySeverity`, `summarizeFindings`, `reviewVerdict`, `indexProjection`, `logRun` (verbatim from Tasks 1–2); the `budget` global; the `_via` arg from Task 2.
- Produces: a `rust-review` workflow record on every terminal path, marked `nested`/`via` when invoked by `rust-audit`.

- [ ] **Step 1: Parse the `_via` arg**

After the existing arg block (the line `const pathArg = ...`), add:

```js
const viaArg = (args && typeof args === 'object' && args._via) ? String(args._via) : ''   // set by a parent workflow (e.g. rust-audit)
```

- [ ] **Step 2: Add the inlined helper block + `logRun`**

Immediately AFTER the `VERDICT_SCHEMA` definition (ends `reason: { type: 'string' },\n  },\n}`), insert the SAME helper block as Task 2 Step 1 but with `reviewVerdict` in place of `worstVerdict` and without `stripInternal`:

```js
// ---- run-record helpers (VERBATIM mirror of lib/run-record.mjs — the sandbox can't import; keep in sync) ----
const SEVERITIES = ['Critical', 'High', 'Medium', 'Low', 'Info']
function countBySeverity(findings) {
  const by = { Critical: 0, High: 0, Medium: 0, Low: 0, Info: 0 }
  for (const f of (Array.isArray(findings) ? findings : [])) {
    if (f && Object.prototype.hasOwnProperty.call(by, f.severity)) by[f.severity] += 1
  }
  return by
}
function summarizeFindings(findings) {
  const bySeverity = countBySeverity(findings)
  return { total: SEVERITIES.reduce((n, s) => n + bySeverity[s], 0), bySeverity }
}
function reviewVerdict(confirmed) {
  const by = countBySeverity(confirmed)
  if (by.Critical || by.High) return 'Block'
  if (by.Medium) return 'Warning'
  return 'Approve'
}
function indexProjection(r) {
  return {
    schemaVersion: r.schemaVersion, ts: r.ts, kind: r.kind, name: r.name,
    project: r.project, commit: r.commit, dirty: r.dirty,
    verdict: r.verdict, findingsTotal: r.findings ? r.findings.total : 0,
    nested: r.nested, via: r.via, outputTokens: r.outputTokens ?? null,
  }
}
async function logRun(record) {
  const index = indexProjection(record)
  await agent(
    `You are the craft observability logger. Persist ONE run record to the global store \`~/.craft/runs/\`. This is mechanical IO — do not analyze.
Steps:
1. \`mkdir -p ~/.craft/runs\`.
2. Compute: TS=\`date -u +%Y-%m-%dT%H-%M-%SZ\`; PROJECT=\`pwd\`; COMMIT=\`git rev-parse --short HEAD 2>/dev/null\` (empty string if not a git repo); DIRTY=true if \`git status --porcelain\` prints anything, else false.
3. Take RECORD below, add fields {"ts":TS,"project":PROJECT,"commit":COMMIT,"dirty":DIRTY}, and write the result as pretty JSON to \`~/.craft/runs/<TS>-<kind>-<name>.json\` (kind and name are fields in RECORD).
4. Take INDEX below, add the same four fields, and append it as ONE compact line (single atomic \`>>\`) to \`~/.craft/runs/index.jsonl\`.
5. If \`~/.craft/runs/README.md\` does not exist, create it describing the store: "craft run records. index.jsonl = one compact JSON line per run (load with jq); <ts>-<kind>-<name>.json = full per-run detail. Common fields: schemaVersion, ts, kind (workflow|agent), name, project, commit, dirty, verdict, findings{total,bySeverity}, nested, via. Workflows add scout/dimensions/verification/notRun/outputTokens; agents add toolsRun." Include two jq examples: \`jq -s 'group_by(.name)[]|{name:.[0].name,runs:length}' index.jsonl\` and \`jq 'select(.verdict|test("Block"))' index.jsonl\`.
Best-effort: if anything fails, report it but do NOT error the run.

RECORD:
${JSON.stringify(record, null, 2)}

INDEX:
${JSON.stringify(index)}`,
    { label: 'log-run', phase: 'Synthesize', model: 'haiku', effort: 'low' },
  )
}
```

- [ ] **Step 3: Add the `reviewRecord` factory (closes over plan/gate/via/budget)**

Immediately AFTER the line `log(\`Gate: ${gateStatus} — ...\`)` (the `log(...)` right after `seedFindings` is defined), insert:

```js
// Common fields for every rust-review record; callers pass the path-specific extras.
function reviewRecord(extra) {
  return {
    schemaVersion: 1,
    kind: 'workflow',
    name: 'rust-review',
    nested: !!viaArg,
    via: viaArg || null,
    scout: { size: plan.sizeBucket, lenses: plan.lenses, model: plan.lensModel, maxRounds: plan.maxRounds, verifyVotes: plan.verifyVotes },
    gate: { status: gateStatus, provenance: gateProvenance },
    outputTokens: budget.spent(),
    ...extra,
  }
}
```

- [ ] **Step 4: Log on the gate-fail path**

The gate-fail block currently is:

```js
if (gateStatus === 'fail') {
  return [
    `## Verdict`,
    `⛔ Block — mechanical gate is red.`,
```

Insert the log call as the first statement inside the `if`, before the `return`:

```js
if (gateStatus === 'fail') {
  await logRun(reviewRecord({ verdict: 'Block', findings: summarizeFindings([]), dimensions: [], verification: null, notRun: [], failedChecks: gate.failedChecks || [] }))
  return [
    `## Verdict`,
    `⛔ Block — mechanical gate is red.`,
```

- [ ] **Step 5: Log on the no-findings path**

The no-pool block currently is:

```js
if (!pool.length) {
  return [`## Verdict`, `✅ Approve — gate ${gateStatus}; no findings across ${plan.lenses.length} lenses.`, ``, `## Gate`, gateProvenance].join('\n')
}
```

Change to:

```js
if (!pool.length) {
  await logRun(reviewRecord({ verdict: 'Approve', findings: summarizeFindings([]), dimensions: [], verification: null, notRun: [] }))
  return [`## Verdict`, `✅ Approve — gate ${gateStatus}; no findings across ${plan.lenses.length} lenses.`, ``, `## Gate`, gateProvenance].join('\n')
}
```

- [ ] **Step 6: Log on the main path**

The file currently ends (after the optional PR-comments block):

```js
return report
```

Replace that final `return report` with:

```js
const allReviewFindings = confirmed.concat(suspected)
const totalVerified = confirmed.length + suspected.length + dropped
await logRun(reviewRecord({
  verdict: reviewVerdict(confirmed),
  findings: summarizeFindings(allReviewFindings),
  dimensions: plan.lenses.map(l => {
    const s = summarizeFindings(confirmed.filter(f => (f.source || '') === l))
    return { dimension: l, verdict: '', findingCount: s.total, bySeverity: s.bySeverity }
  }),
  verification: { candidates: totalVerified, confirmed: confirmed.length, refuteRate: totalVerified ? Math.round((dropped / totalVerified) * 100) / 100 : 0 },
  notRun: [],
}))

return report
```

- [ ] **Step 7: Suppress self-logging in the lens agents**

`lensPrompt` (used for both lens rounds and critic follow-ups) dispatches `agentType: 'craft:rust-reviewer'`, which self-logs. The function currently ends:

```js
Return {lens, findings[]}.`
}
```

Change to:

```js
Return {lens, findings[]}.

Observability: the rust-review workflow records this run — do NOT write your own record.`
}
```

- [ ] **Step 8: Syntax-check**

Run: `node --check workflows/rust-review.js`
Expected: exit 0, no output.

- [ ] **Step 9: Verify markers**

Run: `grep -c "await logRun(" workflows/rust-review.js`
Expected: `3`

Run: `grep -c "do NOT write your own record" workflows/rust-review.js`
Expected: `1`

- [ ] **Step 10: Confirm the inline helpers match the canonical module**

Run:
```bash
node -e "import('./lib/run-record.mjs').then(m=>{for(const f of ['countBySeverity','summarizeFindings','reviewVerdict','indexProjection']) if(typeof m[f]!=='function') throw new Error('missing '+f); console.log('lib exports OK')})"
```
Expected: `lib exports OK` (guards that the names the workflows mirror still exist in the canonical module).

- [ ] **Step 11: Commit**

```bash
git add workflows/rust-review.js
git commit -m "feat(observability): emit a run record from rust-review (all paths)"
```

---

### Task 4: Standalone-agent self-logging

**Files:**
- Modify: `agents/rust-reviewer.md`
- Modify: `agents/rust-security-scanner.md`
- Modify: `agents/rust-miri.md`
- Modify: `agents/rust-architecture-reviewer.md`

**Interfaces:**
- Consumes: nothing (each agent writes via its own Bash tool).
- Produces: a `kind:"agent"` line in `~/.craft/runs/index.jsonl` on direct dispatch; silent when the dispatch prompt says the workflow owns observability.

- [ ] **Step 1: Append an Observability section to `rust-reviewer.md`**

At the END of `agents/rust-reviewer.md`, append:

```markdown

## Observability

After you have issued your verdict, record this run — UNLESS your dispatch prompt says the workflow
records this run (then skip; the workflow owns it). This is best-effort: never fail your review
because logging failed.

Append ONE compact JSON line to `~/.craft/runs/index.jsonl` (run `mkdir -p ~/.craft/runs` first),
using a single atomic append (`printf '%s\n' "$LINE" >> ~/.craft/runs/index.jsonl`):

`{"schemaVersion":1,"ts":"<date -u +%Y-%m-%dT%H-%M-%SZ>","kind":"agent","name":"rust-reviewer","project":"<pwd>","commit":"<git rev-parse --short HEAD, empty if none>","dirty":<true if git status --porcelain is non-empty, else false>,"verdict":"<Approve|Warning|Block>","findings":{"total":<n>,"bySeverity":{"Critical":0,"High":0,"Medium":0,"Low":0,"Info":0}},"nested":false,"via":null}`
```

- [ ] **Step 2: Append to `rust-security-scanner.md` (with `toolsRun`)**

At the END of `agents/rust-security-scanner.md`, append the same section but with `"name":"rust-security-scanner"` and an extra `toolsRun` field listing the tools that actually ran:

```markdown

## Observability

After you have issued your verdict, record this run — UNLESS your dispatch prompt says the workflow
records this run (then skip; the workflow owns it). This is best-effort: never fail your scan
because logging failed.

Append ONE compact JSON line to `~/.craft/runs/index.jsonl` (run `mkdir -p ~/.craft/runs` first),
using a single atomic append (`printf '%s\n' "$LINE" >> ~/.craft/runs/index.jsonl`):

`{"schemaVersion":1,"ts":"<date -u +%Y-%m-%dT%H-%M-%SZ>","kind":"agent","name":"rust-security-scanner","project":"<pwd>","commit":"<git rev-parse --short HEAD, empty if none>","dirty":<true if git status --porcelain is non-empty, else false>,"verdict":"<Approve|Warning|Block>","findings":{"total":<n>,"bySeverity":{"Critical":0,"High":0,"Medium":0,"Low":0,"Info":0}},"nested":false,"via":null,"toolsRun":["cargo-audit","cargo-deny"]}`

Set `toolsRun` to the tools that actually ran (omit ones that were absent).
```

- [ ] **Step 3: Append to `rust-miri.md`**

At the END of `agents/rust-miri.md`, append the same section as Step 1 but with `"name":"rust-miri"` and verdict vocabulary `<Clean|UB-found>`:

```markdown

## Observability

After you have issued your verdict, record this run — UNLESS your dispatch prompt says the workflow
records this run (then skip; the workflow owns it). This is best-effort: never fail your run because
logging failed.

Append ONE compact JSON line to `~/.craft/runs/index.jsonl` (run `mkdir -p ~/.craft/runs` first),
using a single atomic append (`printf '%s\n' "$LINE" >> ~/.craft/runs/index.jsonl`):

`{"schemaVersion":1,"ts":"<date -u +%Y-%m-%dT%H-%M-%SZ>","kind":"agent","name":"rust-miri","project":"<pwd>","commit":"<git rev-parse --short HEAD, empty if none>","dirty":<true if git status --porcelain is non-empty, else false>,"verdict":"<Clean|UB-found>","findings":{"total":<n>,"bySeverity":{"Critical":0,"High":0,"Medium":0,"Low":0,"Info":0}},"nested":false,"via":null}`
```

- [ ] **Step 4: Append to `rust-architecture-reviewer.md`**

At the END of `agents/rust-architecture-reviewer.md`, append the same section as Step 1 but with `"name":"rust-architecture-reviewer"` and verdict vocabulary `<Healthy|Concerns|At-risk>`:

```markdown

## Observability

After you have issued your health rating, record this run — UNLESS your dispatch prompt says the
workflow records this run (then skip; the workflow owns it). This is best-effort: never fail your
audit because logging failed.

Append ONE compact JSON line to `~/.craft/runs/index.jsonl` (run `mkdir -p ~/.craft/runs` first),
using a single atomic append (`printf '%s\n' "$LINE" >> ~/.craft/runs/index.jsonl`):

`{"schemaVersion":1,"ts":"<date -u +%Y-%m-%dT%H-%M-%SZ>","kind":"agent","name":"rust-architecture-reviewer","project":"<pwd>","commit":"<git rev-parse --short HEAD, empty if none>","dirty":<true if git status --porcelain is non-empty, else false>,"verdict":"<Healthy|Concerns|At-risk>","findings":{"total":<n>,"bySeverity":{"Critical":0,"High":0,"Medium":0,"Low":0,"Info":0}},"nested":false,"via":null}`
```

- [ ] **Step 5: Verify all four sections landed**

Run: `grep -l "## Observability" agents/*.md | wc -l`
Expected: `4`

- [ ] **Step 6: Commit**

```bash
git add agents/rust-reviewer.md agents/rust-security-scanner.md agents/rust-miri.md agents/rust-architecture-reviewer.md
git commit -m "feat(observability): standalone agents self-log run records"
```

---

### Task 5: Store-format dry-run + repo docs

**Files:**
- Create: `docs/observability.md`
- Modify: `MAP.md`

**Interfaces:**
- Consumes: the logger contract from Tasks 2–3.
- Produces: a deterministic check that the logger's shell steps work on this machine; a repo-side format reference.

- [ ] **Step 1: Dry-run the logger's shell steps (deterministic, no LLM)**

This proves `date`/`git`/`mkdir`/atomic-append behave as the logger expects, independent of any agent run.

Run:
```bash
TS=$(date -u +%Y-%m-%dT%H-%M-%SZ)
mkdir -p /tmp/craft-obs-test
LINE='{"schemaVersion":1,"ts":"'"$TS"'","kind":"workflow","name":"selftest","verdict":"Approve","findingsTotal":0,"nested":false,"via":null}'
printf '%s\n' "$LINE" >> /tmp/craft-obs-test/index.jsonl
tail -1 /tmp/craft-obs-test/index.jsonl | (command -v jq >/dev/null && jq . || cat)
rm -rf /tmp/craft-obs-test
```
Expected: the JSON line prints back (pretty if `jq` is installed). Confirms the TS format, append, and round-trip. If `jq` is absent, note it — the logger and the README's jq examples assume jq is available for *analysis* (writing does not need it).

- [ ] **Step 2: Write the repo-side format doc**

Create `docs/observability.md`:

```markdown
# Observability — craft run records

Every `rust-audit` / `rust-review` run, and every directly-dispatched review agent, writes a
structured record to a global per-user store so runs can be studied later.

## Store

```
~/.craft/runs/
  index.jsonl              # append-only, one compact JSON line per run — load with jq/pandas
  <ts>-<kind>-<name>.json  # full per-run detail
  README.md                # generated on first run
```

## Record schema (`schemaVersion: 1`)

Common: `ts`, `kind` (`workflow`|`agent`), `name`, `project`, `commit`, `dirty`, `verdict`,
`findings: {total, bySeverity:{Critical,High,Medium,Low,Info}}`, `nested`, `via`.

Workflows add: `scout`, `dimensions[]`, `verification {candidates, confirmed, refuteRate}`,
`notRun[]`, `outputTokens` (approximate — `budget.spent()`, shared per-turn pool).
Agents add: `toolsRun[]`.

`index.jsonl` carries the summary projection (drops `dimensions`/`scout`/`verification` detail,
adds `findingsTotal`).

## How it is produced

Workflow scripts are sandboxed (no filesystem, no clock), so they assemble the record object and
hand it to a cheap **logger agent** that stamps `ts`/`project`/`commit`/`dirty` and writes the
files. The shaping helpers are tested in `lib/run-record.mjs`; the workflow scripts inline verbatim
copies (the sandbox can't `import`). Standalone agents self-log via their `.md` Observability
section, suppressed when run as a workflow sub-agent.

## Studying the data

```bash
# runs per handler
jq -s 'group_by(.name)[] | {name: .[0].name, runs: length}' ~/.craft/runs/index.jsonl
# everything that blocked
jq 'select(.verdict | test("Block"))' ~/.craft/runs/index.jsonl
# unused-crate verification refute rate over audit runs (from detail files)
jq -s '[.[] | select(.name=="rust-audit") | .verification | select(.!=null)]' ~/.craft/runs/*-workflow-rust-audit.json
```

Design rationale and accepted limitations: see
`docs/superpowers/specs/2026-06-24-observability-design.md`.

## Out of scope (v1)

Per-agent timing/token cost (only in raw `agent-*.jsonl` transcripts) and any analysis UI.
```

- [ ] **Step 3: Add a pointer to `MAP.md`**

Read `MAP.md`, then add this line under the section that lists docs/workflows (next to the other `docs/` or `workflows/` entries):

```markdown
- `docs/observability.md` — run-record store (`~/.craft/runs/`) emitted by the review workflows and agents.
```

- [ ] **Step 4: Commit**

```bash
git add docs/observability.md MAP.md
git commit -m "docs(observability): store-format reference + MAP pointer"
```

---

## Self-Review

**1. Spec coverage:**
- Storage `~/.craft/runs/` (index.jsonl + detail + README) → Tasks 2/3 logger, Task 5 doc. ✅
- Single `schemaVersion:1` record, workflow/agent discriminator → Tasks 1–4. ✅
- Common + workflow-only + agent-only fields → Task 1 helpers, Tasks 2/3 assembly, Task 4 agent lines. ✅
- Logger agent stamps `ts`/`project`/`commit`/`dirty` → Tasks 2/3 `logRun`. ✅
- Nesting suppression (agentType sub-calls + review lenses) + nested review record → Task 2 Step 3/4, Task 3 Step 1/3/7. ✅
- Standalone agents self-log unless suppressed → Task 4. ✅
- Verification stats (unused-crates + review verify) → Task 2 Step 2/6, Task 3 Step 6. ✅
- `outputTokens` via `budget.spent()` → Tasks 2/3. ✅
- Out of scope: per-agent timing/tokens, analysis tooling → documented in Task 5 doc. ✅
- Accepted limitations (end-of-run write; no exact parent id; approximate tokens) → reflected (3 return sites covered; `via` string link; `budget.spent()` labeled approximate). ✅

**2. Placeholder scan:** No TBD/TODO/"handle edge cases"; every code step shows full code; every command has expected output. ✅

**3. Type consistency:** Helper names (`countBySeverity`, `summarizeFindings`, `worstVerdict`, `reviewVerdict`, `refuteRate`, `indexProjection`, `logRun`, `reviewRecord`, `stripInternal`) are used consistently across Tasks 1–3. Record fields (`schemaVersion`, `kind`, `name`, `verdict`, `findings.{total,bySeverity}`, `nested`, `via`, `scout`, `dimensions`, `verification.{candidates,confirmed,refuteRate}`, `notRun`, `outputTokens`, `toolsRun`) match between the JS assembly (Tasks 2/3), the agent lines (Task 4), and the doc (Task 5). `indexProjection` emits `findingsTotal` (flattened) — matched in Task 1 test and the doc. ✅
