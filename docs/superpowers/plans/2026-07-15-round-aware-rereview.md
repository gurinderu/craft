# Round-aware Re-review Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the `review` workflow round-aware — persist a disposition-annotated finding ledger per branch, auto-detect re-reviews, and split round N into an *adjudicate* track (was each prior finding fixed?) plus a cheap *delta* track (new bugs from the fixes).

**Architecture:** All cross-round logic lives as pure, unit-tested helpers in `lib/run-record.mjs`; the sandboxed `workflows/review.js` inlines VERBATIM copies of them (the sandbox cannot `import`) and wires them into the scout → adjudicate → lenses → synthesize pipeline. The two fix-loop skills (`triage-findings`, `addressing-findings`) write human-sourced dispositions into the same ledger under a documented contract.

**Tech Stack:** Node.js ESM (`node --test` built-in runner, `node:assert/strict`); the craft workflow runtime (sandboxed JS with `agent()/parallel()/pipeline()` — no `import`, no `Date.now`/`Math.random`); markdown skills.

## Global Constraints

- **No `import` in `workflows/review.js`** — helpers are inlined VERBATIM from `lib/run-record.mjs`. When you add a helper to the lib, copy it byte-for-byte into the workflow's mirror block and keep both in sync (see the header comment in `lib/run-record.mjs`).
- **No `Date.now()` / `Math.random()` / argless `new Date()`** anywhere reachable from a workflow — they throw in the sandbox. Fingerprints and hashes MUST be deterministic pure functions of their inputs.
- **Run record store:** `~/.craft/runs/` — full per-run JSON at `<ts>-<kind>-<name>.json`, one compact line per run in `index.jsonl`. Schema version stays `1` unless a field is renamed/removed (additive fields do not bump it).
- **Ledger key:** `project + branch`; fall back to PR number only when there is no branch.
- **Disposition vocabulary (fixed):** `open | closed | rejected | justified | deferred`.
- **Existing triage verdicts (do not rename):** `accept | reject | defer | needs-decision | conflict` (`TRIAGE_VERDICTS` in `lib/run-record.mjs`).
- **Test command:** `node --test lib/run-record.test.mjs`.

---

## File Structure

- `lib/run-record.mjs` — **modify.** Add pure ledger helpers: `titleShingle`, `fingerprint`, `shingleOverlap`, `matchesPrior`, `dispositionFromTriage`, `rereviewVerdict`, `selectPriorRound`; extend `indexProjection` with `branch`/`head`/`round`.
- `lib/run-record.test.mjs` — **modify.** One `test(...)` block per new helper.
- `workflows/review.js` — **modify.** Inline-mirror the new helpers; load the prior round at scout; ancestor-guard the round decision; add the adjudicate stage; scope delta lenses to `prevHead...HEAD`; merge the two tracks in synthesis; extend `logRun`/`reviewRecord` to persist full findings + `branch`/`head`/`round`.
- `skills/addressing-findings/SKILL.md` (+ `skills/addressing-findings/schema.md`) — **modify.** Document + instruct the review-ledger disposition write for ALL human-sourced dispositions (`rejected`/`justified`/`deferred`/`closed`). **CORRECTION (impl-time):** `triage-findings` is a *workflow* (`workflows/triage-findings.js`), NOT a skill — there is no `skills/triage-findings/`. Per the user's decision, all disposition writes are consolidated into the `addressing-findings` skill (the documented primary loop `review → triage-findings → addressing-findings → re-review` always runs it). A standalone-`triage-findings`-workflow writeback is a documented follow-up, not built here. Task 10 is therefore folded into Task 11.

---

## Task 1: Title shingle + deterministic fingerprint

**Files:**
- Modify: `lib/run-record.mjs` (append helpers near the bottom, before `indexProjection`)
- Test: `lib/run-record.test.mjs`

**Interfaces:**
- Produces: `titleShingle(title: string): string` — lowercased, non-alphanumerics collapsed to spaces, words sorted and space-joined. `fingerprint(f: {file,symbol,ruleId,title}): string` — 8-hex-char deterministic djb2 hash of `file \0 symbol \0 ruleId \0 titleShingle(title)`.

- [ ] **Step 1: Write the failing test**

```js
// add to lib/run-record.test.mjs
import {
  titleShingle, fingerprint,
} from './run-record.mjs'

test('titleShingle normalizes, sorts, and is word-order independent', () => {
  assert.equal(titleShingle('Lock held across .await'), 'across await held lock')
  assert.equal(titleShingle('await held lock across'), 'across await held lock')
  assert.equal(titleShingle(null), '')
})

test('fingerprint is deterministic and ignores title word order', () => {
  const a = { file: 'src/foo.rs', symbol: 'Foo::bar', ruleId: 'CON-003', title: 'Lock held across await' }
  const b = { file: 'src/foo.rs', symbol: 'Foo::bar', ruleId: 'CON-003', title: 'await across held Lock' }
  assert.equal(fingerprint(a), fingerprint(b))
  assert.match(fingerprint(a), /^[0-9a-f]{8}$/)
})

test('fingerprint separates on file, symbol, and ruleId', () => {
  const base = { file: 'src/foo.rs', symbol: 'Foo::bar', ruleId: 'CON-003', title: 'x' }
  assert.notEqual(fingerprint(base), fingerprint({ ...base, file: 'src/other.rs' }))
  assert.notEqual(fingerprint(base), fingerprint({ ...base, symbol: 'Foo::baz' }))
  assert.notEqual(fingerprint(base), fingerprint({ ...base, ruleId: 'CON-004' }))
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test lib/run-record.test.mjs`
Expected: FAIL — `titleShingle` / `fingerprint` not exported.

- [ ] **Step 3: Write minimal implementation**

```js
// lib/run-record.mjs — add before `export function indexProjection`
// Normalized, word-order-independent word-set of a finding title. Used inside the fingerprint and
// for fuzzy cross-round matching so a lightly reworded title still matches its prior-round twin.
export function titleShingle(title) {
  return String(title || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .sort()
    .join(' ')
}

// Line-tolerant finding identity: hash of file + enclosing symbol + ruleId + title shingle.
// djb2 (not crypto) — the sandbox has no crypto and bans Math.random, and we only need a stable,
// collision-resistant-enough key, computed identically in the lib and in the workflow mirror.
export function fingerprint(f) {
  const basis = [f?.file || '', f?.symbol || '', f?.ruleId || '', titleShingle(f?.title)].join('\0')
  let h = 5381
  for (let i = 0; i < basis.length; i++) h = ((h << 5) + h + basis.charCodeAt(i)) >>> 0
  return h.toString(16).padStart(8, '0')
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test lib/run-record.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/run-record.mjs lib/run-record.test.mjs
git commit -m "feat(review): line-tolerant finding fingerprint helper"
```

---

## Task 2: Fuzzy cross-round matching

**Files:**
- Modify: `lib/run-record.mjs`
- Test: `lib/run-record.test.mjs`

**Interfaces:**
- Consumes: `titleShingle` (Task 1).
- Produces: `shingleOverlap(a: string, b: string): number` in `[0,1]` (intersection over larger word-set). `matchesPrior(cur, prior, opts?: {threshold?: number}): boolean` — same `file` AND same `ruleId` AND (symbols absent or equal) AND `shingleOverlap(titles) >= threshold` (default `0.6`).

- [ ] **Step 1: Write the failing test**

```js
// add to lib/run-record.test.mjs imports: shingleOverlap, matchesPrior
test('shingleOverlap is 1 for identical, 0 for disjoint, fractional for partial', () => {
  assert.equal(shingleOverlap('lock across await', 'await across lock'), 1)
  assert.equal(shingleOverlap('lock across await', 'unrelated other words'), 0)
  assert.ok(shingleOverlap('lock held across await', 'lock across await') > 0.5)
  assert.equal(shingleOverlap('', 'anything'), 0)
})

test('matchesPrior requires same file+ruleId and a title above threshold', () => {
  const prior = { file: 'src/foo.rs', symbol: 'Foo::bar', ruleId: 'CON-003', title: 'Lock held across await' }
  assert.ok(matchesPrior({ ...prior, line: 99, title: 'lock across await held' }, prior))
  assert.ok(!matchesPrior({ ...prior, file: 'src/other.rs' }, prior))
  assert.ok(!matchesPrior({ ...prior, ruleId: 'CON-004' }, prior))
  assert.ok(!matchesPrior({ ...prior, title: 'completely different unrelated defect here' }, prior))
})

test('matchesPrior treats a moved symbol as the same finding when file+ruleId+title hold', () => {
  const prior = { file: 'src/foo.rs', symbol: '', ruleId: 'SAF-002', title: 'unwrap on reachable path' }
  assert.ok(matchesPrior({ file: 'src/foo.rs', symbol: 'Foo::run', ruleId: 'SAF-002', title: 'unwrap on reachable path' }, prior))
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test lib/run-record.test.mjs`
Expected: FAIL — `shingleOverlap` / `matchesPrior` not exported.

- [ ] **Step 3: Write minimal implementation**

```js
// lib/run-record.mjs — after fingerprint()
export function shingleOverlap(a, b) {
  const sa = new Set(titleShingle(a).split(' ').filter(Boolean))
  const sb = new Set(titleShingle(b).split(' ').filter(Boolean))
  if (!sa.size || !sb.size) return 0
  let inter = 0
  for (const w of sa) if (sb.has(w)) inter++
  return inter / Math.max(sa.size, sb.size)
}

// True when `cur` (a freshly located finding) is the same defect as `prior` (from the ledger).
// file + ruleId must match exactly; a symbol mismatch only disqualifies when BOTH carry one (a
// finding can move symbols across a fix, so an absent symbol is not a veto); titles must overlap.
export function matchesPrior(cur, prior, { threshold = 0.6 } = {}) {
  if ((cur?.file || '') !== (prior?.file || '')) return false
  if ((cur?.ruleId || '') !== (prior?.ruleId || '')) return false
  if ((cur?.symbol || '') && (prior?.symbol || '') && cur.symbol !== prior.symbol) return false
  return shingleOverlap(cur?.title, prior?.title) >= threshold
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test lib/run-record.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/run-record.mjs lib/run-record.test.mjs
git commit -m "feat(review): fuzzy cross-round finding matching"
```

---

## Task 3: Disposition mapping + track verdict

**Files:**
- Modify: `lib/run-record.mjs`
- Test: `lib/run-record.test.mjs`

**Interfaces:**
- Consumes: `reviewVerdict` (existing).
- Produces: `dispositionFromTriage(v: string): string` — maps a triage verdict to a ledger disposition (`reject→rejected`, `defer→deferred`, everything else→`open`). `rereviewVerdict({stillOpen?, regressed?, neu?}): 'Block'|'Warning'|'Approve'` — `reviewVerdict` over the union of the three arrays (resolved/carried excluded by construction).

- [ ] **Step 1: Write the failing test**

```js
// add to lib/run-record.test.mjs imports: dispositionFromTriage, rereviewVerdict
test('dispositionFromTriage maps triage verdicts to ledger dispositions', () => {
  assert.equal(dispositionFromTriage('reject'), 'rejected')
  assert.equal(dispositionFromTriage('defer'), 'deferred')
  assert.equal(dispositionFromTriage('accept'), 'open')
  assert.equal(dispositionFromTriage('needs-decision'), 'open')
  assert.equal(dispositionFromTriage('conflict'), 'open')
  assert.equal(dispositionFromTriage('garbage'), 'open')
})

test('rereviewVerdict weighs only still-open, regressed, and new findings', () => {
  assert.equal(rereviewVerdict({ stillOpen: [], regressed: [], neu: [] }), 'Approve')
  assert.equal(rereviewVerdict({ stillOpen: [{ severity: 'Medium' }] }), 'Warning')
  assert.equal(rereviewVerdict({ regressed: [{ severity: 'High' }] }), 'Block')
  assert.equal(rereviewVerdict({ neu: [{ severity: 'Critical' }], stillOpen: [{ severity: 'Low' }] }), 'Block')
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test lib/run-record.test.mjs`
Expected: FAIL — helpers not exported.

- [ ] **Step 3: Write minimal implementation**

```js
// lib/run-record.mjs — after matchesPrior()
// A ledger disposition sourced from a human triage decision. accept/needs-decision/conflict stay
// `open` (still to be adjudicated or fixed); only reject/defer carry a settled disposition.
export const DISPOSITION_FROM_TRIAGE = { reject: 'rejected', defer: 'deferred', accept: 'open', 'needs-decision': 'open', conflict: 'open' }
export function dispositionFromTriage(v) {
  return DISPOSITION_FROM_TRIAGE[v] || 'open'
}

// Re-review verdict: reviewVerdict over the findings that still matter this round. resolved and
// carried (rejected/justified) findings are excluded by the caller, so they never reach here.
export function rereviewVerdict({ stillOpen = [], regressed = [], neu = [] } = {}) {
  return reviewVerdict([...stillOpen, ...regressed, ...neu])
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test lib/run-record.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/run-record.mjs lib/run-record.test.mjs
git commit -m "feat(review): disposition mapping and re-review verdict"
```

---

## Task 4: Prior-round selection + index projection fields

**Files:**
- Modify: `lib/run-record.mjs` (`indexProjection`, plus new `selectPriorRound`)
- Test: `lib/run-record.test.mjs`

**Interfaces:**
- Produces: `selectPriorRound(indexEntries, {project, branch}): entry|null` — the most-recent (`ts` lexical max) index entry with `kind==='workflow'`, `name==='review'`, matching `project` and `branch`; `null` if none. `indexProjection(r)` additionally emits `branch`, `head`, `round` (defaulting to `null`/`0`).

- [ ] **Step 1: Write the failing test**

```js
// add to lib/run-record.test.mjs imports: selectPriorRound  (indexProjection already imported)
test('indexProjection carries branch/head/round', () => {
  const p = indexProjection({ schemaVersion: 1, ts: 't', kind: 'workflow', name: 'review', project: '/p', branch: 'feat/x', head: 'abc123', round: 2, verdict: 'Approve' })
  assert.equal(p.branch, 'feat/x')
  assert.equal(p.head, 'abc123')
  assert.equal(p.round, 2)
})

test('indexProjection defaults branch/head/round when absent', () => {
  const p = indexProjection({ schemaVersion: 1, ts: 't', kind: 'workflow', name: 'review', project: '/p', verdict: 'Approve' })
  assert.equal(p.branch, null)
  assert.equal(p.head, null)
  assert.equal(p.round, 0)
})

test('selectPriorRound picks the latest matching review for the branch', () => {
  const idx = [
    { ts: '2026-07-10T00-00-00Z', kind: 'workflow', name: 'review', project: '/p', branch: 'feat/x' },
    { ts: '2026-07-12T00-00-00Z', kind: 'workflow', name: 'review', project: '/p', branch: 'feat/x' },
    { ts: '2026-07-13T00-00-00Z', kind: 'workflow', name: 'review', project: '/p', branch: 'other' },
    { ts: '2026-07-11T00-00-00Z', kind: 'workflow', name: 'rust-audit', project: '/p', branch: 'feat/x' },
    { ts: '2026-07-14T00-00-00Z', kind: 'workflow', name: 'review', project: '/OTHER', branch: 'feat/x' },
  ]
  assert.equal(selectPriorRound(idx, { project: '/p', branch: 'feat/x' }).ts, '2026-07-12T00-00-00Z')
  assert.equal(selectPriorRound(idx, { project: '/p', branch: 'nope' }), null)
  assert.equal(selectPriorRound([], { project: '/p', branch: 'feat/x' }), null)
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test lib/run-record.test.mjs`
Expected: FAIL — `selectPriorRound` missing; `indexProjection` lacks `branch`.

- [ ] **Step 3: Write minimal implementation**

```js
// lib/run-record.mjs — replace the existing indexProjection body's return with the extended one:
export function indexProjection(r) {
  return {
    schemaVersion: r.schemaVersion, runtime: r.runtime ?? null, ts: r.ts, kind: r.kind, name: r.name,
    project: r.project, commit: r.commit, dirty: r.dirty,
    branch: r.branch ?? null, head: r.head ?? null, round: r.round ?? 0,
    verdict: r.verdict, findingsTotal: r.findings ? r.findings.total : 0,
    nested: r.nested, via: r.via, outputTokens: r.outputTokens ?? null,
  }
}

// Pick the newest prior `review` run for this project+branch from the loaded index.jsonl entries.
// ts strings are UTC and lexically sortable (YYYY-MM-DDTHH-MM-SSZ), so a string max is chronological.
export function selectPriorRound(indexEntries, { project, branch }) {
  let best = null
  for (const e of (Array.isArray(indexEntries) ? indexEntries : [])) {
    if (!e || e.kind !== 'workflow' || e.name !== 'review') continue
    if (e.project !== project || e.branch !== branch || !e.branch) continue
    if (!best || String(e.ts) > String(best.ts)) best = e
  }
  return best
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test lib/run-record.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/run-record.mjs lib/run-record.test.mjs
git commit -m "feat(review): prior-round selection and index branch/head/round"
```

---

## Task 5: Mirror the helpers into the workflow + persist the full ledger

**Files:**
- Modify: `workflows/review.js` — the run-record mirror block (`~lines 246-312`), `logRun` prompt (`~lines 289-308`), `reviewRecord` (`~lines 781-796`), and the final `logRun` call (`~lines 870-882`).

**Interfaces:**
- Consumes: the Task 1–4 helpers (copied VERBATIM).
- Produces: every `review` run now writes a per-run JSON whose `findings` array holds the full located findings (each with `fp`, `symbol`, `tier`, `disposition`), plus top-level `branch`, `head`, `round`. Later tasks read this back.

> This task changes the workflow, which is a sandboxed multi-agent script — it has no unit test. Validate it in Task 9 by running a real review and inspecting `~/.craft/runs/`.

- [ ] **Step 1: Add the mirrored helpers to the workflow's run-record mirror block**

In `workflows/review.js`, immediately after the existing `function key(f)` (around line 312), paste the VERBATIM bodies of `titleShingle`, `fingerprint`, `shingleOverlap`, `matchesPrior`, `DISPOSITION_FROM_TRIAGE`, `dispositionFromTriage`, `rereviewVerdict`, and `selectPriorRound` from `lib/run-record.mjs` (drop the `export` keyword on each). Update the mirror-sync comment at the top of that block to add these names.

- [ ] **Step 2: Capture `branch` and `head` in the detect stage**

Extend the DETECT_SCHEMA (around line 157) with two fields and the detect prompt (around line 332) to fill them:

```js
// DETECT_SCHEMA.properties — add:
    branch: { type: 'string', description: 'current git branch name; empty string if detached HEAD' },
    head: { type: 'string', description: 'current HEAD short SHA; empty string if not a git repo' },
// DETECT_SCHEMA.required — add 'branch', 'head'
```

Add to the detect prompt's numbered steps:

```
4. Capture `branch` = `git rev-parse --abbrev-ref HEAD` (empty string if detached) and `head` = `git rev-parse --short HEAD` (empty string if not a git repo).
```

Then after the existing `const spec = ...` (around line 350):

```js
const branch = (typeof detected?.branch === 'string' ? detected.branch : '').trim()
const head = (typeof detected?.head === 'string' ? detected.head : '').trim()
```

- [ ] **Step 3: Have `logRun` persist `findings` verbatim**

The `logRun` agent prompt writes `RECORD` as-is, so any field added to the record is persisted automatically. Keep `findings` as the severity summary (the index's `findingsTotal` reads `r.findings.total` — do not disturb it) and ADD a sibling `ledger` array holding the full located findings:

```js
// in reviewRecord(extra), add alongside the existing fields:
    branch, head,
```

```js
// at the final logRun (around line 870), extend the record:
await logRun(reviewRecord({
  verdict: finalVerdict(confirmed) + (notRun.length ? ' (INCOMPLETE)' : ''),
  round: priorRound ? (priorRound.round || 1) + 1 : 1,
  findings: summarizeFindings(allReviewFindings),
  ledger: allReviewFindings.map(f => ({
    fp: fingerprint(f), file: f.file || '', line: f.line || 0, symbol: f.symbol || '',
    severity: f.severity, tier: confirmed.includes(f) ? 'confirmed' : 'suspected',
    disposition: 'open', source: f.source || '', ruleId: f.ruleId || '', title: f.title || '', why: f.why || '',
  })),
  // …existing dimensions / verification / notRun unchanged…
```

> `priorRound` is defined in Task 6. Until then this references an undefined var — Task 6 lands before this file is run, and both are committed together only after Task 6. If implementing strictly in order, temporarily hardcode `round: 1` here and replace it in Task 6.

- [ ] **Step 4: Run the lib tests (unchanged, must stay green) and a syntax check**

Run: `node --test lib/run-record.test.mjs && node --check workflows/review.js`
Expected: tests PASS; `node --check` prints nothing (valid syntax).

- [ ] **Step 5: Commit**

```bash
git add workflows/review.js
git commit -m "feat(review): persist full finding ledger with branch/head/round"
```

---

## Task 6: Load the prior round + ancestor guard at scout

**Files:**
- Modify: `workflows/review.js` — after the detect stage / before `reviewProfile` is called (around lines 350-363), and args parsing (around lines 14-22).

**Interfaces:**
- Consumes: `selectPriorRound` (mirrored), `branch`/`head` (Task 5).
- Produces: module-scoped `priorRound` — `null` on a first review, else `{ round, head, ledger: [...] }` loaded from `~/.craft/runs/`. `fresh` arg forces `priorRound = null`.

- [ ] **Step 1: Parse the `fresh` override**

Add near the other args (around line 20):

```js
const freshArg = !!(args && typeof args === 'object' && args.fresh)   // force a full first-pass review, ignore any prior round
```

- [ ] **Step 2: Load and ancestor-guard the prior round**

After `const head = ...` (Task 5, around line 351), add:

```js
// Round detection: find the newest prior `review` run for this branch, and accept it as the prior
// round ONLY if its head is an ANCESTOR of the current HEAD (a rebase/force-push makes a stale run
// non-ancestor → treat as a fresh first review). `fresh` skips the whole mechanism.
let priorRound = null
if (!freshArg && branch && head) {
  priorRound = await ragent(
    `You are locating the prior review round for this branch, if any. Shell + read only.
1. If \`~/.craft/runs/index.jsonl\` does not exist, return {found:false}.
2. Read it. Select the newest line with kind="workflow", name="review", project=\`pwd\`, branch=${JSON.stringify(branch)} (newest = lexical-max ts). If none, return {found:false}.
3. That line has a \`head\` field (a prior commit). Check ancestry: \`git merge-base --is-ancestor <priorHead> HEAD\` (exit 0 = ancestor). If NOT an ancestor (rebase/force-push/unrelated), return {found:false}.
4. Reconstruct the full record path \`~/.craft/runs/<ts>-workflow-review.json\` from that line's ts, read it, and return {found:true, round:<its round>, head:<its head>, ledger:<its ledger array, or [] if absent>}.
Best-effort: any error → {found:false}.`,
    { label: 'prior-round', schema: PRIOR_ROUND_SCHEMA, model: 'haiku', effort: 'low', phase: 'Scout' },
  )
  if (!priorRound?.found) priorRound = null
}
if (priorRound) log(`Re-review: prior round ${priorRound.round} @ ${priorRound.head} · ${priorRound.ledger?.length || 0} ledger finding(s)`)
else log(freshArg ? 'Fresh review (—fresh): prior round ignored' : 'First review for this branch (no prior round)')
```

- [ ] **Step 3: Add the schema**

Near the other schemas (around line 220):

```js
const PRIOR_ROUND_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['found', 'round', 'head', 'ledger'],
  properties: {
    found: { type: 'boolean' },
    round: { type: 'integer', description: 'the prior round number; 0 when found=false' },
    head: { type: 'string', description: 'prior HEAD sha; empty when found=false' },
    ledger: { type: 'array', items: FINDING_ITEM, description: 'prior findings with fp/symbol/tier/disposition; empty when found=false' },
  },
}
```

> `FINDING_ITEM` lacks `fp`/`symbol`/`tier`/`disposition`; add them as optional (`required` unchanged) so the ledger array validates:
```js
// FINDING_ITEM.properties — add:
    fp: { type: 'string', description: 'line-tolerant fingerprint; empty if not from a ledger' },
    symbol: { type: 'string', description: 'enclosing fn/type name; empty if unknown' },
    tier: { type: 'string', description: 'confirmed|suspected|refuted; empty if n/a' },
    disposition: { type: 'string', description: 'open|closed|rejected|justified|deferred; empty if n/a' },
```

- [ ] **Step 4: Replace the Task 5 `round` placeholder**

If Task 5 hardcoded `round: 1`, replace it with `round: priorRound ? (priorRound.round || 1) + 1 : 1`.

- [ ] **Step 5: Syntax check + commit**

Run: `node --check workflows/review.js`
Expected: no output.

```bash
git add workflows/review.js
git commit -m "feat(review): auto-detect re-review round with ancestor guard"
```

---

## Task 7: Adjudicate track

**Files:**
- Modify: `workflows/review.js` — a new stage between the merge of profile results and synthesis (around lines 772-826).

**Interfaces:**
- Consumes: `priorRound.ledger`, `matchesPrior` (mirrored), the current-run `confirmed`/`suspected`.
- Produces: module-scoped `adjudicated = { resolved: [], stillOpen: [], regressed: [], carried: [] }` — empty arrays on a first review.

- [ ] **Step 1: Add the adjudicate stage after profile results merge**

After `let confirmed = results.flatMap(r => r.confirmed)` … `let suspected = ...` (around line 813), add:

```js
// ---- Adjudicate track (re-review only) ----
// For each prior-round finding, decide its fate this round. rejected/justified are carried (not
// re-raised) unless the code around them changed; open/deferred/confirmed priors get a targeted
// "is it still here?" check against the current tree.
const adjudicated = { resolved: [], stillOpen: [], regressed: [], carried: [] }
if (priorRound?.ledger?.length) {
  phase('Adjudicate')
  const settled = priorRound.ledger.filter(f => f.disposition === 'rejected' || f.disposition === 'justified')
  const toCheck = priorRound.ledger.filter(f => !(f.disposition === 'rejected' || f.disposition === 'justified'))

  // Settled priors: carried unless the code around them changed since the prior round.
  const carriedResults = (await parallel(settled.map(f => () =>
    ragent(
      `A prior review finding was dismissed by the author (disposition: ${f.disposition}). Decide only whether the CODE AROUND IT CHANGED since commit ${priorRound.head}. Shell + read only.
FINDING: [${f.severity}] ${f.title} — at ${f.file}:${f.line} (symbol ${f.symbol || '?'}), rule ${f.ruleId || '—'}.
Run \`git diff ${priorRound.head}...HEAD -- ${JSON.stringify(f.file)}\` and judge whether the enclosing symbol/region was touched. Return {changed: <bool>, reason}.`,
      { label: `carry:${f.file}:${f.line}`, phase: 'Adjudicate', schema: CHANGED_SCHEMA, model: CULL_MODEL },
    ).then(r => ({ f, changed: !!r?.changed })),
  ))).filter(Boolean)
  for (const { f, changed } of carriedResults) {
    if (changed) adjudicated.stillOpen.push({ ...f, why: `${f.why} (reopened: dismissed as ${f.disposition}, but the code around it changed — re-verify the justification)` })
    else adjudicated.carried.push(f)
  }

  // Open/deferred/confirmed priors: is the defect still at its (re-located) site?
  const checkResults = (await parallel(toCheck.map(f => () =>
    ragent(
      `You are adjudicating whether a prior review finding is still present after a fix attempt. Load the ${active[0].rubricSkill} skill for the rubric. Shell + read only; do NOT hunt for new bugs.
FINDING: [${f.severity}] ${f.title}
  originally at ${f.file}:${f.line} (enclosing symbol ${f.symbol || '?'}), rule ${f.ruleId || '—'}
  why it mattered: ${f.why}
METHOD: re-locate the symbol (grep it — the line has likely moved), read it, and decide:
  - "resolved": the defect is gone (the fix addressed it).
  - "still-open": the defect is still present (cite the current file:line).
  - "regressed": the site was changed but now has a DIFFERENT defect of the same kind (cite it).
Return {status, currentLine, note}.`,
      { label: `adjudicate:${f.file}:${f.line}`, phase: 'Adjudicate', schema: ADJUDICATE_SCHEMA, model: active[0].plan?.lensModel || 'opus' },
    ).then(r => ({ f, r })),
  ))).filter(Boolean)
  for (const { f, r } of checkResults) {
    const status = r?.status || 'still-open'   // verification died → assume still-open (safe: keeps it in the verdict)
    const located = { ...f, line: r?.currentLine || f.line }
    if (status === 'resolved') adjudicated.resolved.push({ ...located, disposition: 'closed' })
    else if (status === 'regressed') adjudicated.regressed.push({ ...located, why: `${f.why} — REGRESSED after fix: ${r?.note || ''}` })
    else adjudicated.stillOpen.push(located)
  }
  log(`Adjudicate: ${adjudicated.resolved.length} resolved · ${adjudicated.stillOpen.length} still-open · ${adjudicated.regressed.length} regressed · ${adjudicated.carried.length} carried`)
}
```

- [ ] **Step 2: Add the two schemas**

Near the other schemas (around line 230):

```js
const CHANGED_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['changed', 'reason'],
  properties: { changed: { type: 'boolean' }, reason: { type: 'string' } },
}
const ADJUDICATE_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['status', 'currentLine', 'note'],
  properties: {
    status: { type: 'string', enum: ['resolved', 'still-open', 'regressed'] },
    currentLine: { type: 'integer', description: 're-located 1-based line; 0 if not found' },
    note: { type: 'string' },
  },
}
```

> `active[0].rubricSkill` — `rubricSkill` lives on the profile, and `active` holds profiles, so `active[0].rubricSkill` is valid. `active[0].plan` does NOT exist (plan is built inside `reviewProfile`); use `results[0]?.plan?.lensModel || 'opus'` instead. Fix that reference when pasting.

- [ ] **Step 3: Syntax check**

Run: `node --check workflows/review.js`
Expected: no output.

- [ ] **Step 4: Commit**

```bash
git add workflows/review.js
git commit -m "feat(review): adjudicate track for prior-round findings"
```

---

## Task 8: Delta-scoped lenses + merged re-review report

**Files:**
- Modify: `workflows/review.js` — the lens diff base (scout/lens prompts, around lines 371-431) and the synthesis prompt (around lines 828-856).

**Interfaces:**
- Consumes: `priorRound`, `adjudicated`.
- Produces: on a re-review, lenses diff `prevHead...HEAD`; the synthesized report uses the §5 five-section shape.

- [ ] **Step 1: Scope the lens diff base to the delta on a re-review**

Introduce one module-scoped base used by the lens/scout prompts. After `priorRound` is resolved (Task 6), add:

```js
// On a re-review the lenses look only at the fix commits (prevHead...HEAD) — cheap, and it catches
// regressions the fixes introduced. `fresh` (priorRound=null) keeps the full base...HEAD scan.
const lensBase = priorRound ? priorRound.head : baseRef
```

Then replace the lens/scout diff references that read `baseRef` for the *review* diff (NOT the detect stage) with `lensBase`: in `scoutPrompt` (line ~374), `negativeSpacePrompt` (line ~397), and `lensPrompt` (line ~415), change `${baseRef ? ...}` diff commands to use `lensBase`. Keep `baseRef` for the gate and detect (the gate still evaluates the whole tree state). Add a one-line note in `lensPrompt` when `priorRound`:

```js
${priorRound ? `RE-REVIEW: you are reviewing ONLY the fix commits since the prior round (base ${lensBase}). Prior findings are adjudicated separately — do not re-report them; surface only NEW defects the fixes introduced.` : ''}
```

- [ ] **Step 2: Feed the adjudicate results + track shape into synthesis**

Replace the synthesis prompt's section list (around lines 843-850) so that, when `priorRound`, it emits the re-review shape. Add before the synthesis call:

```js
const isRereview = !!priorRound
const rereviewData = isRereview ? {
  resolved: adjudicated.resolved, stillOpen: adjudicated.stillOpen,
  regressed: adjudicated.regressed, carried: adjudicated.carried, neu: confirmed,
} : null
```

In the synthesis prompt, branch the "Produce, in order" list:

```js
${isRereview ? `This is a RE-REVIEW (round ${(priorRound.round||1)+1}). Produce, in order:
1. \`## Verdict\` — driven ONLY by Still-open + Regressed + New Confirmed findings (Block on any Critical/High; Warning on Medium; else Approve). Resolved and Carried NEVER change the verdict.
2. \`## Gate\` — ${JSON.stringify(mergedProvenance)}.
3. \`## ✅ Resolved\` — prior findings the fixes closed (one line each); omit if empty.
4. \`## 🔴 Still open\` — prior findings still present; \`severity · file:line · [ruleId] · what · why\`; omit if empty.
5. \`## ⚠️ Regressed\` — new defects the fixes introduced at a prior site; omit if empty.
6. \`## 🆕 New\` — Confirmed findings from the delta lenses (same format); omit if empty.
7. \`## 🔽 Carried\` — dismissed priors (rejected/justified) carried forward unchanged, collapsed to a count + one-line list; omit if empty.
RE-REVIEW DATA (JSON): ${JSON.stringify(rereviewData, null, 2)}` : `Produce, in order:
1. \`## Verdict\` — one line (emoji + reason).${notRun.length ? ` Append " · ⚠️ INCOMPLETE …"` : ''}
... (existing first-pass section list unchanged) ...`}
```

(Keep the existing first-pass branch verbatim in the `else`.)

- [ ] **Step 3: Use the track verdict for the record on a re-review**

At the final `logRun` (Task 5), compute the verdict from tracks when re-reviewing:

```js
const recordVerdict = isRereview
  ? rereviewVerdict({ stillOpen: adjudicated.stillOpen, regressed: adjudicated.regressed, neu: confirmed })
  : finalVerdict(confirmed)
// use `recordVerdict + (notRun.length ? ' (INCOMPLETE)' : '')` in the logRun verdict field
```

- [ ] **Step 4: Syntax check**

Run: `node --check workflows/review.js`
Expected: no output.

- [ ] **Step 5: Commit**

```bash
git add workflows/review.js
git commit -m "feat(review): delta-scoped lenses and re-review report shape"
```

---

## Task 9: End-to-end validation on a two-round scenario

**Files:**
- No product code. A throwaway scratch repo under the scratchpad.

- [ ] **Step 1: Build a tiny two-commit Rust scenario**

Create a scratch crate with one deliberate finding (e.g. an `.unwrap()` on a reachable path), commit it on a branch, and run the first review:

```bash
cd "$(mktemp -d)" && cargo init --name rr_demo -q && git add -A && git commit -qm init
git checkout -qb feat/demo
# introduce a reachable unwrap in src/main.rs, commit it
git commit -aqm "add feature with unwrap"
```

Run the review workflow against this branch (via the Workflow tool, `name: 'review'`). Expected: a first-pass report; `~/.craft/runs/index.jsonl` gains a line with `branch=feat/demo`, `round=1`; the matching `<ts>-workflow-review.json` has a non-empty `ledger` array with an `fp` and `symbol` on the unwrap finding.

- [ ] **Step 2: "Fix" it and re-review**

```bash
# replace the unwrap with a match/?, commit
git commit -aqm "fix: handle the error instead of unwrap"
```

Run `review` again on the same branch. Expected:
- Log shows `Re-review: prior round 1 @ <sha> · N ledger finding(s)`.
- The report uses the re-review shape; the unwrap appears under `## ✅ Resolved`.
- `index.jsonl` gains a `round=2` line.

- [ ] **Step 3: Verify the ancestor guard**

```bash
git checkout -qb feat/demo-rebased && git commit --amend -qm "amend to break ancestry"
```

Run `review` on `feat/demo-rebased`. Expected: log shows `First review for this branch (no prior round)` (or, if branch name reused, the non-ancestor prior is rejected) — i.e. no bogus round-2 against a rewritten history.

- [ ] **Step 4: Verify `fresh` override**

Run `review` with `args: { fresh: true }` on `feat/demo` (which has a prior round). Expected: log shows `Fresh review (—fresh): prior round ignored`; the report is the first-pass shape over the full `base...HEAD` diff.

- [ ] **Step 5: Record the result**

No commit (no product change). Note pass/fail of each check in the PR description. If any step fails, fix the responsible task's workflow code and re-run before proceeding.

---

## Task 10: Ledger disposition contract in triage-findings

**Files:**
- Modify: `skills/triage-findings/SKILL.md` (and `skills/triage-findings/*.md` if the write mechanics warrant their own section).

**Interfaces:**
- Consumes: the ledger record contract (Task 5) and `dispositionFromTriage` mapping (Task 3, as documented behavior — the skill is prose, not code).

- [ ] **Step 1: Read the current skill to find the write-back point**

Run: `sed -n '1,60p' skills/triage-findings/SKILL.md` and locate where triage emits its per-finding verdicts.

- [ ] **Step 2: Add a "Write dispositions to the ledger" section**

Append a section instructing: after triage assigns each finding a verdict, update the latest `~/.craft/runs/<ts>-workflow-review.json` for this branch — set each matched finding's `disposition` per the mapping `reject→rejected`, `defer→deferred`, `accept/needs-decision/conflict→open` (leave untouched). Match findings to ledger entries by `fp` when present, else by `file`+`ruleId`+title similarity. State that this is what lets the NEXT re-review skip re-raising dismissed findings. Best-effort: if the record is absent, skip silently.

- [ ] **Step 3: Cross-check the wording against the spec**

Confirm the section names the exact disposition vocabulary (`open|closed|rejected|justified|deferred`) and the exact key (`project+branch`). No code to run.

- [ ] **Step 4: Commit**

```bash
git add skills/triage-findings/
git commit -m "docs(triage-findings): write dispositions to the review ledger"
```

---

## Task 11: Ledger disposition contract in addressing-findings

**Files:**
- Modify: `skills/addressing-findings/SKILL.md`, `skills/addressing-findings/schema.md`.

**Interfaces:**
- Consumes: the ledger record contract (Task 5).

- [ ] **Step 1: Read the current fix-loop close-out steps**

Run: `sed -n '1,80p' skills/addressing-findings/SKILL.md` and find where the loop marks a finding fixed / justified / deferred and closes GitHub threads.

- [ ] **Step 2: Document the ledger write in schema.md**

Add the ledger record shape (from Task 5 / the spec §1) to `schema.md` as the shared contract, noting the two writer roles (engine vs fix-loop) and which dispositions each may set.

- [ ] **Step 3: Add the write step to the fix loop**

In `SKILL.md`, at the point where a finding is resolved, instruct: update the branch's latest ledger record — `closed` when a fix landed and verified, `justified` when kept-with-justification in the PR body, `deferred` when postponed. Match by `fp` (else `file`+`ruleId`+title). Emphasize `justified` has NO triage-verdict source and is set only here. Best-effort if the record is absent.

- [ ] **Step 4: Cross-check vocabulary + commit**

Confirm `justified`/`closed`/`deferred` spelled exactly as the spec. Then:

```bash
git add skills/addressing-findings/
git commit -m "docs(addressing-findings): write closed/justified/deferred to the ledger"
```

---

## Self-Review

**Spec coverage:**
- §1 Ledger → Tasks 4 (index fields), 5 (persist full findings + writers), 10–11 (skill writers). ✓
- §2 Fingerprint identity → Tasks 1 (fingerprint), 2 (matching). ✓
- §3 Two tracks → Tasks 6 (round detect + ancestor guard + `fresh`), 7 (adjudicate), 8 (delta lenses). ✓
- §4 Verdict stability → Task 3 (`rereviewVerdict`), Task 8 step 3 (track verdict), Task 7 (carried not re-litigated). Severity anchor: carried findings keep their prior severity because they are copied verbatim from the ledger in Task 7 — no re-derivation. ✓
- §5 Report shape → Task 8 step 2. ✓

**Placeholder scan:** Tasks 10–11 describe skill prose rather than showing verbatim final markdown — acceptable because the target files are unread at plan time; each step names the exact vocabulary, mapping, and match rule to write. All code tasks (1–9) carry complete code.

**Type consistency:** `fingerprint`/`titleShingle`/`shingleOverlap`/`matchesPrior`/`dispositionFromTriage`/`rereviewVerdict`/`selectPriorRound` names are identical across the lib, the tests, and the workflow mirror. `priorRound` shape `{round, head, ledger}` is consistent between Task 6 (producer), Task 7 (consumer), Task 8 (consumer). `adjudicated` shape `{resolved, stillOpen, regressed, carried}` consistent between Tasks 7 and 8. Two known cross-reference fixes are called out inline in Task 7 step 2 (`results[0]?.plan?.lensModel`, not `active[0].plan`).

**Note on `ledger` vs `findings`:** Task 5 keeps the index's `findings` summary intact (so `indexProjection`'s `findingsTotal` is unaffected) and adds a sibling `ledger` full array. Task 6's loader reads `.ledger`. Consistent.
