# Elastic Deep Review Engine — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the single-pass Rust review with one elastic workflow engine that scout-scales depth to the diff, fans out across review lenses, loops until dry, grounds findings in real tool output, adversarially verifies each finding, and synthesizes one Confirmed/Suspected report.

**Architecture:** A new `workflows/rust-review.js` orchestrates phases Scout → Gate+grounding → Lenses (loop-until-dry) → Verify → Synthesize. `agents/rust-reviewer.md` becomes the per-lens worker. `skills/rust-review/SKILL.md` owns the rubric, lens catalog, confidence tiers, and verification protocol. `workflows/rust-audit.js` delegates its review dimension to the new workflow.

**Tech Stack:** craft workflow scripts (plain ES-module JS run by the Workflow tool — NOT TypeScript, NOT Node CommonJS), craft subagents (markdown + YAML frontmatter), craft skills (markdown).

## Global Constraints

- **Workflow scripts are plain JS run by the Workflow tool**, not Node. `export const meta = {...}` must be a **pure literal** (no variables/calls/spreads). Body uses the injected globals/helpers only: `phase()`, `agent(prompt, opts)`, `parallel([thunks])`, `pipeline()`, `log()`, `workflow()`, `args`, `budget`. **Forbidden:** `Date.now()`, `Math.random()`, `new Date()` (they throw).
- **Nesting is one level.** `workflows/rust-review.js` must **never** call `workflow(...)` itself — only `rust-audit.js` (the parent) calls `rust-review`.
- **JSON Schemas** passed to `agent({schema})` use `additionalProperties: false` and list every property in `required` unless intentionally optional.
- **Optional external tools degrade gracefully:** `cargo-semver-checks`, `cargo-mutants`, `gh`, `semgrep` — absent tool ⇒ skip that axis, log it, never fail the review.
- **The gate phase reuses the CI-aware gate work** (`docs/superpowers/specs/2026-06-23-ci-aware-gate-design.md`) — that plan is a prerequisite. This plan references the gate, it does not re-specify it.
- **No Claude attribution** in commit messages. Write as the user.
- **Agent `model` override:** lenses/verify honor the model the scout chose (`sonnet`/`opus`); scout itself runs on `haiku`. Default-omit elsewhere.

### Syntax verification command (used by every workflow-JS task)

`node --check` parses `.js` as CommonJS and chokes on `export`/top-level `await`. Verify ES-module syntax by checking a `.mjs` copy:

```bash
cp workflows/rust-review.js /tmp/rr-check.mjs && node --check /tmp/rr-check.mjs && echo "SYNTAX OK" && rm /tmp/rr-check.mjs
```

---

## File Structure

- `workflows/rust-review.js` — **NEW.** The elastic engine. One file: meta + shared schemas + prompt builders + the phase pipeline. ~300 lines; acceptable as one file because the phases share schemas and helpers and must be read together.
- `agents/rust-reviewer.md` — **MODIFY.** Repurpose as per-lens worker.
- `skills/rust-review/SKILL.md` — **MODIFY.** Lens catalog, confidence tiers, verification protocol, tool-grounding, verdict-by-Confirmed, workflow entry point.
- `workflows/rust-audit.js` — **MODIFY.** Review dimension → nested `workflow('rust-review', {...})`.
- `CLAUDE.md` — **MODIFY.** Routing table row.
- `MAP.md` — **MODIFY.** Document workflow, lenses, levers, single-pass retirement.

---

## Task 1: Scaffold the workflow — meta, shared schemas, Scout phase

**Files:**
- Create: `workflows/rust-review.js`

**Interfaces:**
- Produces: the `rust-review` workflow name; `SCOUT_SCHEMA`, `FINDING_ITEM`, `FINDINGS_SCHEMA`, `GATE_SCHEMA`, `VERDICT_SCHEMA` (defined here, consumed by later tasks); scout result object `{baseRef, sizeBucket, lenses[], maxRounds, verifyVotes, lensModel, isLibrary, securitySensitive, intent, churn[], notes}`.

- [ ] **Step 1: Create the file with meta, schemas, and the Scout phase**

```javascript
export const meta = {
  name: 'rust-review',
  description: 'Elastic deep review of a Rust diff — scout-scaled lens fan-out, loop-until-dry, tool-grounded seed findings, adversarial + self-verification, synthesized into one Confirmed/Suspected report with a verdict.',
  whenToUse: 'The single review path for any Rust diff/PR before commit or merge. Scales depth to the diff automatically — small diffs run cheap, large diffs run the full fan-out.',
  phases: [
    { title: 'Scout', detail: 'resolve the diff base, classify size/categories, pick lenses + rigor', model: 'haiku' },
    { title: 'Gate', detail: 'CI-aware mechanical gate + tool-grounded seed findings' },
    { title: 'Lenses', detail: 'parallel per-lens review with context expansion; loop-until-dry' },
    { title: 'Verify', detail: 'adversarial refutation + self-verification of each finding' },
    { title: 'Synthesize', detail: 'calibrate severities, completeness critic, one report' },
  ],
}

// ---- args ----
const baseArg = (args && typeof args === 'object' && args.base) ? String(args.base) : ''
const intentArg = (args && typeof args === 'object' && args.intent) ? String(args.intent) : ''
const postComments = !!(args && typeof args === 'object' && args.comment)

// ---- catalog ----
const ALL_LENSES = ['safety', 'errors', 'ownership', 'concurrency', 'performance', 'api-idioms', 'tests', 'intent']

// ---- shared schemas ----
const FINDING_ITEM = {
  type: 'object',
  additionalProperties: false,
  required: ['severity', 'title', 'file', 'line', 'why', 'fix', 'blastRadius', 'source'],
  properties: {
    severity: { type: 'string', enum: ['Critical', 'High', 'Medium', 'Low', 'Info'] },
    title: { type: 'string', description: 'one-line what is wrong' },
    file: { type: 'string', description: 'path; empty string if not applicable' },
    line: { type: 'integer', description: '1-based line; 0 if not applicable' },
    why: { type: 'string', description: 'why it matters' },
    fix: { type: 'string', description: 'direction of the fix' },
    blastRadius: { type: 'string', description: 'callers affected / breaking-change note; empty if n/a' },
    source: { type: 'string', description: 'lens name or tool name that produced this' },
  },
}

const SCOUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['baseRef', 'sizeBucket', 'lenses', 'maxRounds', 'verifyVotes', 'lensModel', 'isLibrary', 'securitySensitive', 'intent', 'churn', 'notes'],
  properties: {
    baseRef: { type: 'string', description: 'git ref the diff was computed against; empty if none resolved' },
    sizeBucket: { type: 'string', enum: ['small', 'medium', 'large'] },
    lenses: { type: 'array', items: { type: 'string' }, description: 'subset of the lens catalog to run' },
    maxRounds: { type: 'integer', description: 'loop-until-dry cap: 1 for small, 2 for medium, 3 for large' },
    verifyVotes: { type: 'integer', description: 'skeptic votes for CRITICAL/HIGH findings (1 or 3); default-tier findings always get 1' },
    lensModel: { type: 'string', enum: ['sonnet', 'opus'], description: 'model for lens + verify agents' },
    isLibrary: { type: 'boolean', description: 'true if a published library crate (→ semver-checks)' },
    securitySensitive: { type: 'boolean' },
    intent: { type: 'string', description: 'what the change should do, from the brief/args; empty if unknown' },
    churn: { type: 'array', items: { type: 'string' }, description: 'hot/often-changed files to scrutinize; may be empty' },
    notes: { type: 'string', description: 'one line on what was detected' },
  },
}

const GATE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['status', 'provenance', 'failedChecks', 'seedFindings', 'notes'],
  properties: {
    status: { type: 'string', enum: ['pass', 'fail', 'unknown'] },
    provenance: { type: 'string', description: 'e.g. "build/test/clippy/fmt via CI #123; audit/deny local"' },
    failedChecks: { type: 'array', items: { type: 'string' } },
    seedFindings: { type: 'array', items: FINDING_ITEM },
    notes: { type: 'string' },
  },
}

const FINDINGS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['lens', 'findings'],
  properties: {
    lens: { type: 'string' },
    findings: { type: 'array', items: FINDING_ITEM },
  },
}

const VERDICT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['refuted', 'citedLineMatches', 'reachable', 'reason'],
  properties: {
    refuted: { type: 'boolean', description: 'true if the finding does not hold up' },
    citedLineMatches: { type: 'boolean', description: 'true if the cited file:line actually contains what the finding claims' },
    reachable: { type: 'boolean', description: 'true if the path is reachable in production (not test/example-only)' },
    reason: { type: 'string' },
  },
}

// ================= Scout =================
phase('Scout')
const scout = await agent(
  `You are scouting a Rust diff to plan an elastic review. Use shell + read only — do NOT review yet.

1. Resolve the diff base. ${baseArg
    ? `Use \`${baseArg}\`.`
    : 'Try in order until one resolves: `git merge-base HEAD origin/main`, `git merge-base HEAD main`, `HEAD~1`. If the tree has uncommitted changes, target those.'}
2. Inspect \`git diff --stat <base>...HEAD\` (and \`git status --porcelain\`). Set sizeBucket:
   small = a few files / < ~80 changed lines; large = many files / > ~400 lines or a public-API or unsafe-heavy change; medium otherwise.
3. lenses: choose from ${JSON.stringify(ALL_LENSES)}.
   - small: only the touched categories (minimum 2; always include 'safety' and the dominant category).
   - medium: the categories plausibly in play.
   - large: all of them.
   Decide what is "in play" from the diff: unsafe → ownership+safety; async/threads → concurrency; SQL/untrusted input → safety; loops/collections → performance; changed \`pub\` surface → api-idioms; new/changed tests → tests; always consider 'intent'.
4. maxRounds: small=1, medium=2, large=3. verifyVotes: small/medium=1, large=3. lensModel: small=sonnet, medium=sonnet, large=opus.
5. isLibrary: true if this crate is a published library (has \`[lib]\`/is named in a workspace as a lib and looks publishable) — best effort.
6. securitySensitive: true if the diff touches auth, crypto, input parsing, unsafe, FFI, or dependencies.
7. intent: ${intentArg ? `the caller provided: "${intentArg}". Refine it from the diff if needed.` : 'infer the change\'s purpose from the diff and any PR/commit messages; empty string if unclear.'}
8. churn: list up to 5 files in the diff that git shows as frequently changed (\`git log --oneline -n 50 -- <file> | wc -l\` is a rough proxy) — these get extra scrutiny. May be empty.`,
  { label: 'scout', schema: SCOUT_SCHEMA, model: 'haiku', effort: 'low' },
)

// Fail-safe defaults if scout was skipped or died.
const plan = {
  baseRef: scout?.baseRef ?? '',
  sizeBucket: scout?.sizeBucket ?? 'medium',
  lenses: (scout?.lenses?.length ? scout.lenses : ALL_LENSES),
  maxRounds: scout?.maxRounds ?? 2,
  verifyVotes: scout?.verifyVotes ?? 1,
  lensModel: scout?.lensModel ?? 'sonnet',
  isLibrary: scout?.isLibrary ?? false,
  securitySensitive: scout?.securitySensitive ?? true,
  intent: scout?.intent ?? intentArg,
  churn: scout?.churn ?? [],
}
log(scout?.notes ?? 'scout produced no result — assuming medium bucket, all lenses')

// Temporary terminal return for this task — replaced in Task 2.
return JSON.stringify(plan, null, 2)
```

- [ ] **Step 2: Verify ES-module syntax**

Run:
```bash
cp workflows/rust-review.js /tmp/rr-check.mjs && node --check /tmp/rr-check.mjs && echo "SYNTAX OK" && rm /tmp/rr-check.mjs
```
Expected: `SYNTAX OK`

- [ ] **Step 3: Verify meta is a pure literal and phases match**

Run:
```bash
rg -n "phase\('(Scout|Gate|Lenses|Verify|Synthesize)'\)" workflows/rust-review.js
rg -n "title: '(Scout|Gate|Lenses|Verify|Synthesize)'" workflows/rust-review.js
```
Expected: the `phase('Scout')` call is present and `Scout` appears in `meta.phases`. (Gate/Lenses/Verify/Synthesize titles exist in meta now; their `phase()` calls arrive in later tasks.)

- [ ] **Step 4: Commit**

```bash
git add workflows/rust-review.js
git commit -m "feat(rust-review): scaffold elastic review workflow with scout phase"
```

---

## Task 2: Gate phase — CI-aware gate + tool-grounded seed findings

**Files:**
- Modify: `workflows/rust-review.js`

**Interfaces:**
- Consumes: `plan` (Task 1), `GATE_SCHEMA`, `FINDING_ITEM`.
- Produces: `gate` result `{status, provenance, failedChecks[], seedFindings[], notes}`. An early `return` on `status === 'fail'`.

- [ ] **Step 1: Replace the temporary `return` with the Gate phase**

Delete the `// Temporary terminal return for this task` line and its `return JSON.stringify(...)` and insert:

```javascript
// ================= Gate + tool grounding =================
phase('Gate')
const gate = await agent(
  `You are establishing the mechanical gate for a Rust review, CI-aware, and collecting tool-grounded seed findings. Diff base: ${plan.baseRef ? `\`${plan.baseRef}\`` : 'uncommitted changes / most recent commit'}.

GATE (CI-aware, per the rust-review skill — load it):
1. Detect a PR + CI: \`gh pr checks --json name,state,bucket,link\` for the current branch. If gh is missing/unauthenticated/offline or no PR is found, fall through to the local gate.
2. For build/test/clippy/fmt: if a conclusive green required CI check covers it, treat it as PASSED and record provenance "via CI #<n>"; if any such check FAILED, set status=fail and list it in failedChecks. If pending/absent, run it locally (\`cargo fmt --check\`, \`cargo clippy --all-targets -- -D warnings\`, \`cargo test\`).
3. Security tools (\`cargo audit\`, \`cargo deny check\`) always run locally if installed (cheap, usually absent from CI). A vulnerability with a fix is a fail.
4. status = fail if any of fmt/clippy/test/build is red (CI or local); pass if all green; unknown if you could not establish it.

SEED FINDINGS (tool grounding — beyond the gate, scoped to the changed crates):
5. \`cargo clippy --all-targets -- -W clippy::pedantic -W clippy::nursery\` — turn each NEW pedantic/nursery diagnostic on changed lines into a seed finding (severity Low/Medium, source "clippy-pedantic"). Do not fail the gate on these.
${plan.isLibrary ? '6. This is a library: run `cargo semver-checks check-release` if installed; each reported break is a seed finding (severity High, source "semver-checks"). If not installed, log and skip.' : '6. Not a library — skip semver-checks.'}

Set provenance to a one-line summary like "clippy/test via CI #123; fmt/audit/deny local". Put gate failures in failedChecks (NOT seedFindings). Seed findings are clippy-pedantic / semver only.`,
  { label: 'gate', schema: GATE_SCHEMA, phase: 'Gate', effort: 'medium' },
)

const gateStatus = gate?.status ?? 'unknown'
const gateProvenance = gate?.provenance ?? 'gate not established'
const seedFindings = (gate?.seedFindings ?? []).map(f => ({ ...f, source: f.source || 'tool' }))
log(`Gate: ${gateStatus} — ${gateProvenance}${gate?.failedChecks?.length ? ` · failed: ${gate.failedChecks.join(', ')}` : ''}`)

if (gateStatus === 'fail') {
  return [
    `## Verdict`,
    `⛔ Block — mechanical gate is red.`,
    ``,
    `## Gate`,
    gateProvenance,
    gate.failedChecks?.length ? `\nFailed checks:\n${gate.failedChecks.map(c => `- ${c}`).join('\n')}` : '',
    ``,
    `Fix the gate before a semantic review is worthwhile.`,
  ].join('\n')
}

// Temporary terminal return — replaced in Task 3.
return JSON.stringify({ plan, gateProvenance, seedFindings }, null, 2)
```

- [ ] **Step 2: Verify ES-module syntax**

Run: `cp workflows/rust-review.js /tmp/rr-check.mjs && node --check /tmp/rr-check.mjs && echo "SYNTAX OK" && rm /tmp/rr-check.mjs`
Expected: `SYNTAX OK`

- [ ] **Step 3: Verify the early Block path and grounding are present**

Run:
```bash
rg -n "gateStatus === 'fail'|clippy::pedantic|semver-checks|gh pr checks" workflows/rust-review.js
```
Expected: all four matches present.

- [ ] **Step 4: Commit**

```bash
git add workflows/rust-review.js
git commit -m "feat(rust-review): CI-aware gate phase with tool-grounded seed findings"
```

---

## Task 3: Lenses phase — single-round fan-out (no loop yet)

**Files:**
- Modify: `workflows/rust-review.js`

**Interfaces:**
- Consumes: `plan`, `seedFindings`, `FINDINGS_SCHEMA`, `ALL_LENSES`.
- Produces: `lensPrompt(lens, priorSummary)` builder; `allFindings[]` (raw lens findings, one round).

- [ ] **Step 1: Replace the temporary `return` with the lens prompt builder + a single fan-out round**

Delete the Task-2 temporary `return JSON.stringify(...)` and insert:

```javascript
// ================= Lenses =================
const LENS_BRIEF = {
  safety: 'safety / injection / secrets: unwrap/expect/panic on reachable paths, unsafe without SAFETY, SQL/command injection, path traversal, hardcoded secrets, unbounded deserialization.',
  errors: 'error handling: recoverable failures handled with panic/unwrap, dropped #[must_use]/error values, Result-vs-panic, typed-error-vs-anyhow at API boundaries.',
  ownership: 'ownership & lifetimes: needless clone to satisfy the borrow checker, String where &str/impl AsRef suffices, Vec<T> where &[T] works, explicit lifetimes where elision applies.',
  concurrency: 'concurrency / async: blocking calls inside async, lock held across .await, unbounded channels, inconsistent lock order (deadlock), missing Send/Sync.',
  performance: 'performance: allocation in hot loops, to_string/to_owned where a borrow works, Vec::new+push where size is known, N+1 / repeated work in loops.',
  'api-idioms': 'API & idioms & docs: library returning Box<dyn Error>/anyhow, giant functions / deep nesting, wildcard match on a business enum, pub item without ///, #[allow] without justification, #![deny(warnings)] in source.',
  tests: 'tests & coverage QUALITY (not just presence): do new tests assert real behavior and error paths, or are they vacuous (assert!(true), no assertions)? New error path/branch with no test; bug fix with no regression test.',
  intent: 'intent / spec conformance: does the change actually do what it is supposed to do? Compare the diff against the stated intent; flag correct-looking code with wrong behavior, missed requirements, off-by-one against the spec.',
}

function lensPrompt(lens, priorSummary) {
  return `You are the **${lens}** review lens for a Rust diff. Review ONLY this slice; ignore everything else (other lenses cover it). Load the rust-review skill for the rubric and the rust-navigation skill for context expansion.

SLICE: ${LENS_BRIEF[lens] || lens}

Diff base: ${plan.baseRef ? `\`${plan.baseRef}\`` : 'uncommitted changes / most recent commit'}. Review with \`git diff ${plan.baseRef ? `--merge-base ${plan.baseRef}` : 'HEAD'} -- '*.rs'\`.
${plan.intent ? `INTENT (what the change should do): ${plan.intent}` : ''}
${plan.churn?.length ? `HOT FILES (scrutinize harder): ${plan.churn.join(', ')}` : ''}

CONTEXT EXPANSION (required): for each finding, trace callers / impls / error paths of the changed symbols (Grep/Glob + LSP) before judging — do not read the diff in isolation. If a finding depends on code outside the diff, say so in \`why\`.
BLAST-RADIUS (required): for each changed PUBLIC symbol you touch, note how many callers are affected and set a breaking-change flag in \`blastRadius\`.
CONFIDENCE: report everything you suspect, located. Do NOT self-censor borderline findings — verification happens downstream. Each finding needs file:line (use file:"" line:0 only when truly not locatable).
${plan.tests === undefined ? '' : ''}${lens === 'tests' && plan.sizeBucket === 'large' ? 'If `cargo mutants` is installed, you MAY run it time-boxed on the changed files to find weak tests; skip silently if absent.' : ''}

ALREADY-FOUND (do not repeat; look for what these MISSED):
${priorSummary}

Return {lens, findings[]}.`
}

phase('Lenses')
const round1 = (await parallel(plan.lenses.map(lens => () =>
  agent(lensPrompt(lens, 'none yet'), { label: `lens:${lens}`, agentType: 'craft:rust-reviewer', phase: 'Lenses', schema: FINDINGS_SCHEMA, model: plan.lensModel }),
))).filter(Boolean)

const allFindings = round1.flatMap(r => (r.findings || []).map(f => ({ ...f, source: f.source || r.lens })))
log(`Lenses round 1: ${allFindings.length} raw findings from ${round1.length} lenses`)

// Temporary terminal return — replaced in Task 4.
return JSON.stringify({ gateProvenance, seed: seedFindings.length, lensFindings: allFindings.length }, null, 2)
```

- [ ] **Step 2: Verify ES-module syntax**

Run: `cp workflows/rust-review.js /tmp/rr-check.mjs && node --check /tmp/rr-check.mjs && echo "SYNTAX OK" && rm /tmp/rr-check.mjs`
Expected: `SYNTAX OK`

- [ ] **Step 3: Verify the lens fan-out uses the per-lens agent**

Run: `rg -n "agentType: 'craft:rust-reviewer'|lensPrompt|parallel\(plan.lenses" workflows/rust-review.js`
Expected: all three present.

- [ ] **Step 4: Commit**

```bash
git add workflows/rust-review.js
git commit -m "feat(rust-review): per-lens fan-out with context expansion and blast-radius"
```

---

## Task 4: Loop-until-dry + dedup barrier

**Files:**
- Modify: `workflows/rust-review.js`

**Interfaces:**
- Consumes: `lensPrompt`, `plan.maxRounds`, `seedFindings`, `allFindings` (round 1).
- Produces: `key(f)` normalizer; deduped `pool[]` (seed + all lens rounds).

- [ ] **Step 1: Replace the round-1 block and its temporary return with the loop**

Replace everything from `phase('Lenses')` through the Task-3 temporary `return` with:

```javascript
function key(f) {
  return `${(f.file || '').toLowerCase()}:${f.line || 0}:${(f.title || '').toLowerCase().replace(/\s+/g, ' ').trim()}`
}

phase('Lenses')
const seen = new Set()
const pool = []
// Seed findings (from the gate) enter the pool first and seed the dedup set.
for (const f of seedFindings) {
  const k = key(f)
  if (!seen.has(k)) { seen.add(k); pool.push(f) }
}

let dry = false
for (let round = 1; round <= plan.maxRounds && !dry; round++) {
  const priorSummary = pool.length
    ? pool.map(f => `${f.file || '?'}:${f.line || 0} ${f.title}`).join('\n')
    : 'none yet'
  const results = (await parallel(plan.lenses.map(lens => () =>
    agent(lensPrompt(lens, priorSummary), { label: `lens:${lens} r${round}`, agentType: 'craft:rust-reviewer', phase: 'Lenses', schema: FINDINGS_SCHEMA, model: plan.lensModel }),
  ))).filter(Boolean)
  const fresh = []
  for (const r of results) {
    for (const f0 of (r.findings || [])) {
      const f = { ...f0, source: f0.source || r.lens }
      const k = key(f)
      if (!seen.has(k)) { seen.add(k); fresh.push(f) }
    }
  }
  pool.push(...fresh)
  log(`Lenses round ${round}: +${fresh.length} new (pool ${pool.length})`)
  if (!fresh.length) dry = true
}

if (!pool.length) {
  return [`## Verdict`, `✅ Approve — gate ${gateStatus}; no findings across ${plan.lenses.length} lenses.`, ``, `## Gate`, gateProvenance].join('\n')
}

// Temporary terminal return — replaced in Task 5.
return JSON.stringify({ gateProvenance, pool: pool.length }, null, 2)
```

- [ ] **Step 2: Verify ES-module syntax**

Run: `cp workflows/rust-review.js /tmp/rr-check.mjs && node --check /tmp/rr-check.mjs && echo "SYNTAX OK" && rm /tmp/rr-check.mjs`
Expected: `SYNTAX OK`

- [ ] **Step 3: Verify loop + dedup present**

Run: `rg -n "round <= plan.maxRounds|function key\(f\)|seen.has\(k\)|if \(!fresh.length\) dry = true" workflows/rust-review.js`
Expected: all four present.

- [ ] **Step 4: Commit**

```bash
git add workflows/rust-review.js
git commit -m "feat(rust-review): loop-until-dry rounds with cross-round dedup"
```

---

## Task 5: Verify phase — adversarial refutation + self-verification

**Files:**
- Modify: `workflows/rust-review.js`

**Interfaces:**
- Consumes: `pool[]`, `plan.verifyVotes`, `plan.lensModel`, `VERDICT_SCHEMA`.
- Produces: reusable `async verifyPool(items) → {confirmed, suspected, dropped}`; `let confirmed[]` / `let suspected[]` (each item a `FINDING_ITEM` plus `{tier}`, extended by the Task 6 critic follow-up).

- [ ] **Step 1: Replace the Task-4 temporary return with the Verify phase**

```javascript
// ================= Verify =================
phase('Verify')
function verifyPrompt(f, idx) {
  return `You are skeptic #${idx + 1} trying to REFUTE a Rust review finding. Default to refuted=true when uncertain — only let real findings through.

FINDING: [${f.severity}] ${f.title}
  at ${f.file || '?'}:${f.line || 0}
  why: ${f.why}
  source: ${f.source}

Open the cited file and check:
1. citedLineMatches: does ${f.file || '?'}:${f.line || 0} actually contain what the finding claims? (If the citation is wrong/hallucinated → citedLineMatches=false.)
2. reachable: is this code reachable in production, or is it test/example/dead code? (Test-only → reachable=false.)
3. refuted: taking 1 and 2 together plus your judgement, does the finding NOT hold up?

Return {refuted, citedLineMatches, reachable, reason}.`
}

// Reusable: verify a pool of findings → {confirmed, suspected, dropped}.
// Called here for the lens pool, and again in Task 6 for the critic's follow-up findings.
async function verifyPool(items) {
  const judged = await parallel(items.map(f => () => {
    const isHigh = f.severity === 'Critical' || f.severity === 'High'
    const votes = isHigh ? Math.max(1, plan.verifyVotes) : 1
    return parallel(Array.from({ length: votes }, (_unused, i) => () =>
      agent(verifyPrompt(f, i), { label: `verify:${f.file || '?'}:${f.line || 0}#${i + 1}`, phase: 'Verify', schema: VERDICT_SCHEMA, model: plan.lensModel }),
    )).then(vs => {
      const v = vs.filter(Boolean)
      if (!v.length) return { ...f, tier: 'suspected' } // verification died → don't drop, demote
      const half = v.length / 2
      const lineOk = v.filter(x => x.citedLineMatches).length >= Math.ceil(half)
      const reach = v.filter(x => x.reachable).length >= Math.ceil(half)
      const refutes = v.filter(x => x.refuted).length
      let tier
      if (!lineOk) tier = 'refuted'            // hallucinated citation
      else if (refutes > half) tier = 'refuted'
      else if (reach && refutes === 0) tier = 'confirmed'
      else tier = 'suspected'
      return { ...f, tier }
    })
  }))
  const vp = judged.filter(Boolean)
  return {
    confirmed: vp.filter(f => f.tier === 'confirmed'),
    suspected: vp.filter(f => f.tier === 'suspected'),
    dropped: vp.filter(f => f.tier === 'refuted').length,
  }
}

// `let` so the Task 6 completeness critic can extend these with follow-up findings.
let { confirmed, suspected, dropped } = await verifyPool(pool)
log(`Verify: ${confirmed.length} confirmed · ${suspected.length} suspected · ${dropped} refuted`)

// Temporary terminal return — replaced in Task 6.
return JSON.stringify({ gateProvenance, confirmed: confirmed.length, suspected: suspected.length }, null, 2)
```

- [ ] **Step 2: Verify ES-module syntax**

Run: `cp workflows/rust-review.js /tmp/rr-check.mjs && node --check /tmp/rr-check.mjs && echo "SYNTAX OK" && rm /tmp/rr-check.mjs`
Expected: `SYNTAX OK`

- [ ] **Step 3: Verify the refute/self-verify logic**

Run: `rg -n "citedLineMatches|reachable|tier = 'refuted'|tier = 'confirmed'|tier = 'suspected'" workflows/rust-review.js`
Expected: all branches present.

- [ ] **Step 4: Commit**

```bash
git add workflows/rust-review.js
git commit -m "feat(rust-review): adversarial + self-verification with Confirmed/Suspected tiers"
```

---

## Task 6: Synthesize phase — calibrate, completeness critic, report, optional PR comments

**Files:**
- Modify: `workflows/rust-review.js`

**Interfaces:**
- Consumes: `confirmed[]`, `suspected[]` (mutable `let` from Task 5), `gateProvenance`, `plan`, `postComments`; and for the critic follow-up: `ALL_LENSES`, `lensPrompt`, `pool`, `seen`, `key`, `verifyPool`, `budget`.
- Produces: the workflow's final return value — one markdown report string.

- [ ] **Step 1: Replace the Task-5 temporary return with the Synthesize phase**

```javascript
// ================= Synthesize =================
phase('Synthesize')

// Completeness critic WITH bounded follow-up (large bucket, budget-gated).
// The critic names lenses that should have run but didn't; we re-run those once,
// dedup against everything already seen, verify them through verifyPool, and merge
// the survivors into confirmed/suspected. Bounded: one extra round, only lenses from
// the catalog not yet run, and only while the budget allows.
const CRITIC_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['missingLenses', 'notes'],
  properties: {
    missingLenses: { type: 'array', items: { type: 'string' }, description: 'lenses from the candidate list that should also run; empty if coverage is complete' },
    notes: { type: 'string', description: 'one line on anything else likely missed, or "coverage complete"' },
  },
}

let criticNotes = ''
if (plan.sizeBucket === 'large' && (!budget.total || budget.remaining() > 90000)) {
  const candidates = ALL_LENSES.filter(l => !plan.lenses.includes(l))
  const critic = await agent(
    `You are a completeness critic for a Rust review of the diff (base ${plan.baseRef || 'HEAD'}).
Lenses already run: ${plan.lenses.join(', ')}. Confirmed: ${confirmed.length}, Suspected: ${suspected.length}.
Name any review lens that was NOT run but SHOULD be, given what the diff touches — choose ONLY from: ${JSON.stringify(candidates)}.
Also note in one line anything else likely missed (a changed file no finding touched, a claim left unverified). If coverage is complete, return missingLenses: [] and notes: "coverage complete".`,
    { label: 'critic', phase: 'Synthesize', schema: CRITIC_SCHEMA, effort: 'low' },
  )
  criticNotes = critic?.notes ?? ''
  const followups = (critic?.missingLenses ?? []).filter(l => candidates.includes(l))
  if (followups.length && (!budget.total || budget.remaining() > 60000)) {
    log(`Completeness critic → follow-up lenses: ${followups.join(', ')}`)
    const priorSummary = `Earlier lenses already produced ${pool.length} findings — do NOT repeat them; surface only what your lens would add.`
    const extra = (await parallel(followups.map(lens => () =>
      agent(lensPrompt(lens, priorSummary), { label: `lens:${lens} (critic)`, agentType: 'craft:rust-reviewer', phase: 'Synthesize', schema: FINDINGS_SCHEMA, model: plan.lensModel }),
    ))).filter(Boolean).flatMap(r => r.findings || [])
    const fresh = extra.filter(f => { const k = key(f); if (seen.has(k)) return false; seen.add(k); return true })
    if (fresh.length) {
      const v = await verifyPool(fresh)
      confirmed = confirmed.concat(v.confirmed)
      suspected = suspected.concat(v.suspected)
      log(`Critic follow-up: +${v.confirmed.length} confirmed · +${v.suspected.length} suspected · ${v.dropped} refuted`)
    }
  }
}

const report = await agent(
  `You are consolidating a Rust review into ONE markdown report. Do NOT invent findings — only use what is given.

VERDICT RULE: the verdict is driven ONLY by Confirmed findings.
- ⛔ Block if any Confirmed Critical or High.
- ⚠️ Warning if Confirmed Medium only.
- ✅ Approve if no Confirmed Critical/High/Medium.
Suspected findings NEVER change the verdict — they are surfaced for the author.

CALIBRATE severities across the Confirmed set so the same kind of issue is not Critical in one place and Medium in another; adjust outliers and say so in one line if you do.

Produce, in order:
1. \`## Verdict\` — one line (emoji + reason).
2. \`## Gate\` — ${JSON.stringify(gateProvenance)}.
3. \`## Confirmed\` — findings by severity (Critical first), each as \`severity · file:line · what · why · fix\` and a blast-radius note when present.
4. \`## Suspected (needs confirmation)\` — same format; omit the section if empty.
5. \`## Fix first\` — the few highest-leverage Confirmed items.
${criticNotes && criticNotes.trim() && criticNotes.trim() !== 'coverage complete' ? `6. \`## Coverage gaps\` — surface verbatim: ${JSON.stringify(criticNotes)}` : ''}

CONFIRMED (JSON): ${JSON.stringify(confirmed, null, 2)}

SUSPECTED (JSON): ${JSON.stringify(suspected, null, 2)}`,
  { label: 'synthesis', phase: 'Synthesize', effort: 'medium' },
)

// Optional: post Confirmed findings as inline PR comments (lever D, best-effort).
if (postComments && confirmed.length) {
  await agent(
    `Post these Confirmed Rust-review findings as inline comments on the current branch's PR using \`gh\`. If gh is missing/unauthenticated or there is no PR, do nothing and report that — never fail.
For each finding with a real file:line, add a review comment "[severity] why — fix" anchored to that file:line. Findings:
${JSON.stringify(confirmed.map(f => ({ file: f.file, line: f.line, severity: f.severity, why: f.why, fix: f.fix })), null, 2)}`,
    { label: 'pr-comments', phase: 'Synthesize', effort: 'low' },
  )
}

return report
```

- [ ] **Step 2: Verify ES-module syntax**

Run: `cp workflows/rust-review.js /tmp/rr-check.mjs && node --check /tmp/rr-check.mjs && echo "SYNTAX OK" && rm /tmp/rr-check.mjs`
Expected: `SYNTAX OK`

- [ ] **Step 3: Verify the full phase set and verdict rule**

Run:
```bash
rg -n "phase\('(Scout|Gate|Lenses|Verify|Synthesize)'\)" workflows/rust-review.js | wc -l
rg -n "driven ONLY by Confirmed|Completeness critic WITH bounded follow-up|follow-up lenses|confirmed = confirmed.concat|postComments && confirmed.length" workflows/rust-review.js
```
Expected: the count is `5`; all matches present (including the critic follow-up that re-runs missing lenses and merges them via `verifyPool`).

- [ ] **Step 4: Verify no forbidden API and no nested workflow()**

Run:
```bash
rg -n "Date\.now|Math\.random|new Date|workflow\(" workflows/rust-review.js || echo "CLEAN"
```
Expected: `CLEAN` (this workflow must not call `workflow()`, and must use none of the forbidden time/random APIs).

- [ ] **Step 5: Commit**

```bash
git add workflows/rust-review.js
git commit -m "feat(rust-review): calibrated synthesis, completeness critic, optional PR comments"
```

---

## Task 7: Repurpose `rust-reviewer` as the per-lens worker

**Files:**
- Modify: `agents/rust-reviewer.md`

**Interfaces:**
- Consumes: lens-scoped briefs from `workflows/rust-review.js` (Task 3 `lensPrompt`).
- Produces: the agent now natively understands lens scoping, context expansion, blast-radius, and Confirmed/Suspected tiers.

- [ ] **Step 1: Replace the Workflow + Output sections**

Replace the body below the frontmatter (everything from `You are a senior Rust reviewer.` to the end) with:

```markdown
You are a senior Rust reviewer. You judge changes; you do not rewrite them. You apply the
`rust-review` skill's rubric — load it for the severity checklist, confidence tiers, and verdict
criteria. Use the `rust-navigation` skill for context expansion (callers, impls, call hierarchy).

You are usually dispatched by the `rust-review` workflow as **one lens** — review only the slice
your brief names and ignore the rest; other lens instances cover the other slices. If your brief
gives no lens, review the whole diff against the full rubric.

## Workflow

1. **Scope to your lens.** Read the slice your brief defines. Get the diff with
   `git diff --merge-base main -- '*.rs'` (or the base ref / `git diff HEAD` your brief gives).

2. **Expand context before judging.** For each changed symbol in scope, trace its callers, impls,
   and error paths (Grep/Glob + LSP via `rust-navigation`) — do not read the diff in isolation. If
   a finding depends on code outside the diff, say so.

3. **Blast-radius.** For each changed **public** symbol you touch, note how many callers are
   affected and whether the change is breaking.

4. **Apply the rubric** for your slice, walking CRITICAL → HIGH → MEDIUM tiers.

5. **Report everything you suspect — do not self-censor.** Borderline findings are surfaced, not
   dropped; downstream verification decides Confirmed vs Suspected. Each finding cites
   `severity · file:line · what · why · fix`. Use an empty location only when truly not locatable.

When NOT run as a lens (a manual whole-diff review), also run the mechanical gate CI-aware (per the
rust-review skill) and issue an Approve/Warning/Block verdict yourself.

## Output

Return findings as structured data when a schema is supplied (the workflow forces this). Otherwise
emit:

```
## Findings
⛔ Critical · src/db.rs:42 · SQL built by string interpolation · injection risk · use sqlx bind params
⚠️ Medium   · src/cache.rs:88 · format! in hot loop · per-iteration alloc · reuse a buffer

## Verdict
Block — 1 Critical must be fixed before merge.   # only when doing a whole-diff review
```

Be precise; the value is in catching real issues. A finding without a location isn't actionable.
```

- [ ] **Step 2: Verify the frontmatter is intact and the new behavior is documented**

Run:
```bash
rg -n "^name: rust-reviewer|^tools:|context expansion|Blast-radius|do not self-censor" agents/rust-reviewer.md
```
Expected: name + tools frontmatter present; the three new behaviors present.

- [ ] **Step 3: Commit**

```bash
git add agents/rust-reviewer.md
git commit -m "refactor(rust-reviewer): per-lens worker — context expansion, blast-radius, no self-censorship"
```

---

## Task 8: Update the `rust-review` skill — lenses, tiers, verification, workflow entry point

**Files:**
- Modify: `skills/rust-review/SKILL.md`

**Interfaces:**
- Consumes: nothing (rubric of record).
- Produces: the lens catalog, confidence tiers, verification protocol, and verdict-by-Confirmed that the workflow and agent reference.

- [ ] **Step 1: Add the entry-point note under the title**

After the line `The rubric for reviewing Rust changes: run the mechanical gate first ...`, add:

```markdown

**The review entry point is the `rust-review` workflow** (`workflows/rust-review.js`): it scout-scales
depth to the diff, fans out the lenses below, grounds findings in tool output, and adversarially
verifies each one. This skill is the rubric the workflow and the `rust-reviewer` lens worker apply.
```

- [ ] **Step 2: Add the lens catalog, confidence tiers, and verification protocol before `## Step 3 — Verdict`**

Insert this section immediately before `## Step 3 — Verdict`:

```markdown
## Review lenses

The workflow fans the rubric out into independent lenses, each reviewing ONE slice blind to the
others (higher recall than one broad pass):

| Lens | Slice | Owning skill for the fix |
|---|---|---|
| safety | injection / secrets / unsafe / untrusted-input limits | `rust-security`, `rust-unsafe` |
| errors | Result-vs-panic, dropped errors, typed-vs-anyhow | `rust-errors` |
| ownership | needless clone, `&str`/`&[T]`, lifetimes | `rust-ownership` |
| concurrency | blocking-in-async, lock-across-await, deadlock, Send/Sync | `rust-concurrency` |
| performance | hot-loop allocation, N+1, needless owning | `rust-performance` |
| api-idioms | typed errors, giant fns, wildcard match, missing docs, `#![deny(warnings)]` | `rust-idioms` |
| tests | test *quality* not just presence; missing regression/error-path tests | `rust-testing` |
| intent | does the change do what the brief/spec says? | `specs` |

Each lens expands context (callers/impls/error paths via `rust-navigation`) and emits blast-radius
for changed public symbols.

## Confidence tiers — surface, don't censor

- **Confirmed** — located and survived verification; drives the verdict.
- **Suspected** — borderline or unverified; surfaced for the author, **never** changes the verdict.

Report everything you suspect. Borderline findings go to Suspected, not the bin.

## Tool grounding (seed findings)

Beyond the gate, the workflow runs real tools scoped to the diff and feeds their output in as seed
findings (each still verified): `cargo clippy -W clippy::pedantic -W clippy::nursery`, and for
published libraries `cargo semver-checks check-release`. Optional tools degrade gracefully when
absent.

## Verification protocol

Every finding (lens or seed) is checked before it can be Confirmed:

- **Adversarial:** skeptics try to REFUTE it (default to refuted when uncertain). One skeptic by
  default; three-vote consensus for Critical/High.
- **Self-verification (anti-hallucination):** re-read the cited `file:line` — does the code
  actually say what the finding claims, and is the path reachable in production (not test/example)?
  A wrong citation or unreachable path drops or demotes the finding.
```

- [ ] **Step 3: Make the verdict driven by Confirmed**

Replace the verdict table rows in `## Step 3 — Verdict`:

```markdown
| **Approve** ✅ | gate green, no **Confirmed** CRITICAL/HIGH/MEDIUM |
| **Warning** ⚠️ | gate green, **Confirmed** MEDIUM only — Suspected items listed but don't block |
| **Block** ⛔ | gate red, or any **Confirmed** CRITICAL/HIGH |
```

- [ ] **Step 4: Verify the additions**

Run:
```bash
rg -n "Review lenses|Confidence tiers|Self-verification|review entry point|Confirmed\*\* CRITICAL" skills/rust-review/SKILL.md
```
Expected: all sections present.

- [ ] **Step 5: Commit**

```bash
git add skills/rust-review/SKILL.md
git commit -m "docs(rust-review): lens catalog, confidence tiers, verification protocol, verdict-by-Confirmed"
```

---

## Task 9: Wire `rust-audit` review dimension to the nested workflow

**Files:**
- Modify: `workflows/rust-audit.js:71-88` (the review task in the `tasks` array)

**Interfaces:**
- Consumes: the `rust-review` workflow (Tasks 1-6), `baseRef`, `FINDINGS_SCHEMA` shape of `rust-audit`.
- Produces: the audit's review dimension result, now sourced from the deep workflow.

- [ ] **Step 1: Replace the review task thunk**

In `workflows/rust-audit.js`, replace the first element of the `tasks` array (the `review:diff` agent thunk) with a nested workflow call. Find:

```javascript
  () => agent(
    `Review the Rust diff for mergeability using the rust-review rubric (load the rust-review skill). ${baseRef
      ? `Diff base: \`${baseRef}\`.`
      : 'There is no clean base ref — review uncommitted changes, or the most recent commit if the tree is clean.'} Return your verdict and findings.`,
    { label: 'review:diff', agentType: 'craft:rust-reviewer', phase: 'Audit', schema: FINDINGS_SCHEMA },
  ).then(r => (r ? { ...r, dimension: 'review' } : null)),
```

Replace with:

```javascript
  // Review dimension delegates to the elastic deep-review workflow (nested, one level).
  () => workflow('rust-review', baseRef ? { base: baseRef } : {})
    .then(report => ({
      dimension: 'review',
      verdict: /⛔|Block/.test(report || '') ? 'Block' : /⚠️|Warning/.test(report || '') ? 'Warning' : 'Approve',
      summary: 'Elastic deep review — see findings below.',
      findings: [{ severity: 'Info', title: 'Deep review report', location: '', detail: String(report || 'no report').slice(0, 4000) }],
    }))
    .catch(() => null),
```

- [ ] **Step 2: Verify the nesting and that rust-audit still parses**

Run:
```bash
rg -n "workflow\('rust-review'" workflows/rust-audit.js
cp workflows/rust-audit.js /tmp/ra-check.mjs && node --check /tmp/ra-check.mjs && echo "SYNTAX OK" && rm /tmp/ra-check.mjs
```
Expected: the nested call present; `SYNTAX OK`.

- [ ] **Step 3: Commit**

```bash
git add workflows/rust-audit.js
git commit -m "feat(rust-audit): delegate the review dimension to the rust-review workflow"
```

---

## Task 10: Routing + map docs

**Files:**
- Modify: `CLAUDE.md` (the review-routing table)
- Modify: `MAP.md` (workflows / agents sections)

**Interfaces:**
- Consumes: the finished workflow.
- Produces: documentation pointing reviews at the workflow.

- [ ] **Step 1: Update the `CLAUDE.md` review-routing table**

In `CLAUDE.md`, change the default-review row to point at the workflow. Replace:

```markdown
| Review a diff / change before commit or merge (default) | `rust-reviewer` |
```

with:

```markdown
| Review a diff / change before commit or merge (default) | `rust-review` workflow (background) |
```

And add a sentence after the table:

```markdown
The default review now runs the `rust-review` **workflow** (multi-agent, launched in the
background, verdict reported on completion) — it scales depth to the diff. The single-pass
`rust-reviewer` agent remains for an ad-hoc, non-workflow review when you explicitly want one.
```

- [ ] **Step 2: Update `MAP.md`**

In `MAP.md`, under the Agents section note that `rust-reviewer` is now the per-lens worker, and under Workflows add a `rust-review` row. Add to the workflows list:

```markdown
- `rust-review` — the elastic deep review engine: scout-scaled lens fan-out, loop-until-dry,
  tool-grounded seed findings (clippy pedantic/nursery, semver-checks), adversarial +
  self-verification, Confirmed/Suspected report. The single review path; `rust-reviewer` is its
  per-lens worker (single-pass whole-diff orchestration retired).
```

- [ ] **Step 3: Verify**

Run:
```bash
rg -n "rust-review.*workflow|per-lens worker" CLAUDE.md MAP.md
```
Expected: matches in both files.

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md MAP.md
git commit -m "docs: route default review to the rust-review workflow; document the engine"
```

---

## Self-Review

**1. Spec coverage:**
- Scout elasticity (size buckets, lenses, rounds, votes, model) → Task 1. ✓
- CI-aware gate + tool grounding (lever A: clippy pedantic/nursery, semver-checks) → Task 2. ✓
- Lens fan-out incl. tests-quality + intent lenses (lever B), context expansion, blast-radius (lever D) → Tasks 3, 7. `cargo mutants` (large bucket) is in the `tests` lens brief (Task 3). ✓
- Loop-until-dry + dedup → Task 4. ✓
- Adversarial + self-verification, Confirmed/Suspected (lever C) → Task 5. ✓
- Calibration + completeness critic + synthesis + optional inline PR comments (levers C, D) → Task 6. ✓
- Repurpose rust-reviewer → Task 7. ✓
- SKILL: lenses, tiers, verification, tool-grounding, verdict-by-Confirmed, entry point → Task 8. ✓
- rust-audit nested delegation → Task 9. ✓
- CLAUDE.md routing + MAP.md → Task 10. ✓
- Gate composition with the CI-aware spec → Task 2 references it; gate plan is the prerequisite. ✓

**2. Placeholder scan:** No "TBD/handle edge cases/similar to Task N". Every workflow task ships complete JS; the agent/skill tasks ship complete prose. ✓

**3. Type consistency:** `FINDING_ITEM` is the one finding shape used by `FINDINGS_SCHEMA`, `GATE_SCHEMA.seedFindings`, and the verify/synthesis pools. `key(f)` uses `file`/`line`/`title` — all present on `FINDING_ITEM`. `plan.*` fields match `SCOUT_SCHEMA`. `VERDICT_SCHEMA` fields (`refuted`/`citedLineMatches`/`reachable`) match the decision logic in Task 5. The `tier` field is added in Task 5 and read in Task 6. ✓
```
