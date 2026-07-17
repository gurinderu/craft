# Fix-Completeness Adjudication Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** On re-review, a prior finding closes only if its *invariant* holds against constructed attacks — not merely if the described repro is gone; Critical/High closures get an independent red-team pass.

**Architecture:** Two edits inside the adjudicate track of `workflows/review.js`: (1) `ADJUDICATE_SCHEMA` gains required `invariant`/`attack` fields and the adjudicator prompt gains an invariant→attack METHOD; (2) a `redTeam()` helper chains a fresh attacker agent (schema `ATTACK_SCHEMA`) after any `resolved` Critical/High prior, inside the existing per-finding `parallel` thunk (no barrier). Guarded by new assertions in the structural lint `lib/review-registry.test.mjs`.

**Tech Stack:** plain JS workflow script (sandbox: `agent`/`parallel`/`phase`/`log` globals), `node:test` structural lint.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-18-fix-completeness-adjudication-design.md`.
- `workflows/review.js` only; adversarial-review.js untouched.
- No new statuses: enum stays `resolved|still-open|regressed`; verdict logic, synthesis prompt, ledger schema (11 fields) unchanged.
- Engine stays generic: no project nouns (the lint bans e.g. `\bcidr\b` — use "overlap/containment/ordering" phrasing in prompts).
- Dead red-team agent keeps `resolved` (must not spuriously reopen); dead adjudicator keeps defaulting to `still-open`.
- No Claude attribution in commits.

---

### Task 1: Schemas + structural-lint guard

**Files:**
- Modify: `workflows/review.js:278-285` (`ADJUDICATE_SCHEMA`, add `ATTACK_SCHEMA` below it)
- Test: `lib/review-registry.test.mjs:23-40` (`loadRegistry`), new test at end of file

**Interfaces:**
- Produces: `ADJUDICATE_SCHEMA` with required `['status','currentLine','note','invariant','attack']`; new const `ATTACK_SCHEMA` with required `['defeated','attack']`. Task 2 references both by these exact names.

- [ ] **Step 1: Write the failing test**

In `lib/review-registry.test.mjs`, extend the factory return in `loadRegistry()` (line 35):

```js
    `${prefix}\n;return { meta, PROFILES, ADJUDICATE_SCHEMA, ATTACK_SCHEMA };`,
```

and the destructuring (line 40):

```js
const { meta, PROFILES, ADJUDICATE_SCHEMA, ATTACK_SCHEMA } = loadRegistry()
```

Append at end of file:

```js
test('adjudicate track: schema forces the invariant→attack method; red-team is wired', () => {
  for (const field of ['invariant', 'attack']) {
    assert.ok(
      ADJUDICATE_SCHEMA.required.includes(field),
      `ADJUDICATE_SCHEMA must require "${field}" — optional fields let the model skip the fix-completeness steps`,
    )
  }
  assert.deepEqual(
    ATTACK_SCHEMA.required, ['defeated', 'attack'],
    'ATTACK_SCHEMA must require exactly defeated+attack',
  )
  assert.ok(
    /label: `redteam:/.test(src),
    'expected a red-team agent dispatch (label `redteam:<file>:<line>`) in the adjudicate track',
  )
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test lib/review-registry.test.mjs`
Expected: FAIL — `ATTACK_SCHEMA is not defined` (ReferenceError from the factory eval).

- [ ] **Step 3: Write minimal implementation**

In `workflows/review.js`, replace lines 278-285 with:

```js
const ADJUDICATE_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['status', 'currentLine', 'note', 'invariant', 'attack'],
  properties: {
    status: { type: 'string', enum: ['resolved', 'still-open', 'regressed'] },
    currentLine: { type: 'integer', description: 're-located 1-based line; 0 if not found' },
    note: { type: 'string' },
    invariant: { type: 'string', description: 'one-sentence invariant the finding violated' },
    attack: { type: 'string', description: 'the successful attack on the fix; empty string if every attack failed' },
  },
}
// Red-team verdict on a "resolved" Critical/High prior: an independent attempt to defeat the fix.
const ATTACK_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['defeated', 'attack'],
  properties: {
    defeated: { type: 'boolean', description: 'true only if a concrete input/state defeats the fix' },
    attack: { type: 'string', description: 'the concrete input/state and why it slips past the fix; empty if none found' },
  },
}
```

The `redteam:` label lands in Task 2 — this test stays red on its last assertion until then; that is expected mid-plan. If executing tasks with separate committers, keep both tasks on one branch and expect green only after Task 2.

- [ ] **Step 4: Run test to verify schema assertions pass**

Run: `node --test lib/review-registry.test.mjs`
Expected: the new test still FAILS but only on the `redteam:` assertion (schema assertions pass). All pre-existing tests PASS.

- [ ] **Step 5: Commit**

```bash
git add workflows/review.js lib/review-registry.test.mjs
git commit -m "feat(review): adjudicate schema requires invariant+attack; add ATTACK_SCHEMA + lint guard"
```

---

### Task 2: Invariant→attack adjudicator + red-team chain

**Files:**
- Modify: `workflows/review.js:993-1015` (the `toCheck` block and the adjudicate log line)

**Interfaces:**
- Consumes: `ADJUDICATE_SCHEMA`, `ATTACK_SCHEMA` from Task 1; existing `ragent`, `parallel`, `adjudicated`, `active`, `results`.
- Produces: nothing new for later code — `adjudicated.{resolved,stillOpen,regressed}` shapes unchanged (still-open entries may carry an augmented `why`).

- [ ] **Step 1: Replace the `toCheck` block**

Replace `workflows/review.js` lines 993-1014 (from the `// Open/deferred/confirmed priors:` comment through the `for (const { f, r } of checkResults)` loop) with:

```js
  // Open/deferred/confirmed priors: is the defect CLASS still present at its (re-located) site?
  // The adjudicator must state the violated invariant and attack the fix — a fix that closes the
  // literal repro but not the class must not close. A "resolved" Critical/High is then re-attacked
  // by an independent red-team agent that never sees the adjudicator's verdict.
  const adjudModel = results[0]?.plan?.lensModel || 'opus'
  let overturned = 0
  const redTeam = async (f, adj) => {
    if (!(f.severity === 'Critical' || f.severity === 'High')) return adj
    const rt = await ragent(
      `A code-review finding was raised on an earlier revision of this repo and the author has since pushed fix commits. Attack the fix. Shell + read only; do NOT hunt for unrelated bugs.
FINDING: [${f.severity}] ${f.title}
  originally at ${f.file}:${f.line} (enclosing symbol ${f.symbol || '?'}), rule ${f.ruleId || '—'}
  why it mattered: ${f.why}
INVARIANT it violated: ${adj.invariant || f.why}
METHOD: re-locate the symbol (grep it — the line has likely moved), read the current code, and try to CONSTRUCT a concrete input/state that violates the invariant even with the current code in place (canonical: the fix compares for exact equality where the invariant is about overlap/containment/ordering). Check every candidate against the actual code paths before claiming it works.
Return {defeated, attack} — defeated=true ONLY with a concrete attack that survives your own check against the code.`,
      { label: `redteam:${f.file}:${f.line}`, phase: 'Adjudicate', schema: ATTACK_SCHEMA, model: adjudModel },
    )
    // A dead red-teamer keeps `resolved`: the adjudicator already ran its own attack pass, and a
    // transient agent death must not spuriously reopen findings.
    if (rt?.defeated) { overturned++; return { ...adj, status: 'still-open', attack: `(red-team) ${rt.attack}` } }
    return adj
  }
  const checkResults = (await parallel(toCheck.map(f => () =>
    ragent(
      `You are adjudicating whether a prior review finding is still present after a fix attempt. Load the ${active[0].rubricSkill} skill for the rubric. Shell + read only; do NOT hunt for new bugs.
FINDING: [${f.severity}] ${f.title}
  originally at ${f.file}:${f.line} (enclosing symbol ${f.symbol || '?'}), rule ${f.ruleId || '—'}
  why it mattered: ${f.why}
METHOD:
  1. State in ONE sentence the INVARIANT this finding violated — the property that must hold, not the literal repro (derive it from the why/title).
  2. Re-locate the symbol (grep it — the line has likely moved) and read the fix.
  3. Construct AT LEAST TWO concrete attacks: inputs/states that would violate the invariant while the current fix is in place (canonical: the fix compares for exact equality where the invariant is about overlap/containment/ordering). Check each against the actual code.
  4. Decide:
  - "resolved": every attack fails — the fix closes the CLASS, not just the described instance.
  - "still-open": the defect is still present OR one of your attacks succeeds (cite the current file:line; put the attack in \`attack\`).
  - "regressed": the site was changed but now has a DIFFERENT defect of the same kind (cite it).
Return {status, currentLine, note, invariant, attack}.`,
      { label: `adjudicate:${f.file}:${f.line}`, phase: 'Adjudicate', schema: ADJUDICATE_SCHEMA, model: adjudModel },
    ).then(async r => ({ f, r: r?.status === 'resolved' ? await redTeam(f, r) : r })),
  ))).filter(Boolean)
  for (const { f, r } of checkResults) {
    const status = r?.status || 'still-open'   // verification died → assume still-open (safe: keeps it in the verdict)
    const located = { ...f, line: r?.currentLine || f.line }
    if (status === 'resolved') adjudicated.resolved.push({ ...located, disposition: 'closed' })
    else if (status === 'regressed') adjudicated.regressed.push({ ...located, why: `${f.why} — REGRESSED after fix: ${r?.note || ''}` })
    else adjudicated.stillOpen.push(r?.attack ? { ...located, why: `${f.why} — fix incomplete: ${r.attack}` } : located)
  }
```

- [ ] **Step 2: Extend the adjudicate log line**

Replace line (now shifted) `log(\`Adjudicate: ...\`)` with:

```js
  log(`Adjudicate: ${adjudicated.resolved.length} resolved · ${adjudicated.stillOpen.length} still-open · ${adjudicated.regressed.length} regressed · ${adjudicated.carried.length} carried · ${overturned} overturned by red-team`)
```

- [ ] **Step 3: Run the full lint**

Run: `node --test lib/`
Expected: ALL PASS, including the Task-1 test (the `redteam:` label now exists). Also run `node lib/check-workflows.mjs`; expected: exit 0.

- [ ] **Step 4: Commit**

```bash
git add workflows/review.js
git commit -m "feat(review): fix-completeness adjudication — invariant+attack method, red-team pass for resolved Crit/High priors"
```

---

## Self-review notes

- Spec §1 → Task 1 (schema) + Task 2 Step 1 (prompt METHOD). Spec §2 → Task 2 (`redTeam`). Spec §3 → no-op by construction (shapes unchanged). Spec §4 → Task 2 Steps 2-3. Error handling → `r=null` default still-open (kept verbatim); dead red-teamer → `rt?.defeated` falsy → stays resolved.
- Names consistent across tasks: `ADJUDICATE_SCHEMA`, `ATTACK_SCHEMA`, `redTeam`, `adjudModel`, `overturned`.
- Generic-noun ban respected: prompts say "overlap/containment/ordering", never the banned project tokens.
