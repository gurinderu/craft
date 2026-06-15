# Addressing Findings Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the fix-side counterpart to craft's review side — a `addressing-findings` skill (the systematic fix loop) plus a `triage-findings` workflow (validate findings → ordered fix plan, no edits).

**Architecture:** A lean `skills/addressing-findings/SKILL.md` owns the 8-step fix loop and delegates: generic feedback method → `superpowers:receiving-code-review`, "how to fix X" → topic skills, parallel fan-out → `superpowers:dispatching-parallel-agents` / `subagent-driven-development`. Three sibling sub-files (`schema.md`, `rust.md`, `github.md`) hold the details (progressive disclosure, matching the `rust-review/api-design.md` pattern). `workflows/triage-findings.js` is self-contained and symmetric to `rust-audit.js`: it ingests findings from locator args, validates each in parallel against a pinned ref, then a barrier phase dedups / conflict-checks / orders and renders a `superpowers:writing-plans`-format plan + a durable triage ledger. Three existing files are updated (slim `rust-review`, add rows to `MAP.md` and `README.md`).

**Tech Stack:** Markdown skills (craft conventions), one ESM workflow script (the `agent()`/`parallel()`/`phase()`/`log()` harness used by `rust-audit.js`), `gh` CLI for GitHub.

**Source spec:** `docs/superpowers/specs/2026-06-15-addressing-findings-design.md`

**Before you start:** work on a branch — `git checkout -b feat/addressing-findings` (we are on `main`). Commit messages are plain, with **no** Claude attribution (per repo CLAUDE.md).

---

### Task 1: Skill entry — `skills/addressing-findings/SKILL.md`

**Files:**
- Create: `skills/addressing-findings/SKILL.md`

- [ ] **Step 1: Write the SKILL.md**

Create `skills/addressing-findings/SKILL.md` with exactly this content:

````markdown
---
name: addressing-findings
description: Systematic fix loop for review findings — gather findings from craft review agents / rust-audit reports and GitHub PR comments, normalize to one schema, triage each against the code (accept/reject/defer/needs-decision/conflict), order them, fix (delegating how-to-fix to topic skills), verify each, re-review until green, and close the loop on GitHub. The generic feedback discipline lives in superpowers:receiving-code-review; this owns the craft-flavoured, Rust-aware process. Use after a review or audit produces findings, when working through PR comments, or when deciding what to fix first. Triggers: address review comments, fix the findings, work through the review, triage findings, PR comments, act on the verdict, what to fix first, resolve review threads, rust-audit report.
---

# Addressing Findings

The fix counterpart to `rust-review`: take a set of review findings and work them to green —
gather, normalize, triage, order, fix, verify, re-review, close the loop. The generic feedback
discipline (don't implement a wrong suggestion, no performative agreement, evidence before
"done") lives in `superpowers:receiving-code-review` and `superpowers:verification-before-completion`;
this skill owns the concrete, Rust-aware process and points at the topic skills for *how* to fix
each thing.

## When to use

- After a review / `rust-audit` produces findings, or you're working through PR comments.
- Deciding what to fix first and proving each fix landed.
- **Not** for *doing* the review (→ `rust-review`) or *running* the agents (→ `rust-audit`).

## The fix loop

`⫲` marks a step that **fans out across subagents** (→ "Parallelism via subagents").

```
1. Gather  ⫲ — collect findings from both sources, one subagent per source in parallel:
               • craft: a rust-reviewer verdict / a rust-audit report
               • GitHub: gh pr view / gh api → inline thread comments     (→ github.md)
2. Normalize — to the unified schema; tag source; compute stable_id        (→ schema.md)
3. Triage  ⫲ — per finding, validated against a pinned ref, one subagent per finding:
               accept / reject / defer / needs-decision / conflict (+ reasoning)
               (generic feedback discipline → superpowers:receiving-code-review)
4. Order     — accepted only: blocking → simple → complex; group by file to cut churn
               (the grouping is what makes step 5 parallelisable — independent groups)
5. Fix     ⫲ — independent file-groups fixed concurrently, one subagent per group
               (superpowers:subagent-driven-development; worktree isolation when groups
               could touch shared files). Within a group, serial. "How to fix" → topic
               skills; a bug → regression test first, RED→GREEN                (→ rust.md)
6. Verify    — per fix: the rust-review "what proves what" proof table         (→ rust.md)
               (+ superpowers:verification-before-completion)
7. Re-review ⫲ — re-dispatch the review agents in parallel (as rust-audit does); new
               findings re-enter the loop; the ledger dedups; repeat until green (→ rust.md)
8. Close loop— (GitHub) draft replies (what was fixed / why rejected + commit), post &
               resolve ONLY after explicit user OK; map reply→thread via thread_id (→ github.md)
```

**Scaling:** small batch → steps 2–4 inline. Large batch (a fat `rust-audit` report, a
many-comment PR) → dispatch the `triage-findings` workflow, apply its plan via
`superpowers:executing-plans`, then run the re-review loop.

## Triage outcomes

Validate each finding against the code (pinned to the ref it was generated against), then:

| Verdict | Meaning | Where it goes |
|---|---|---|
| `accept` | real, in scope | into the plan |
| `reject` | wrong / not a real problem | ledger + drafted pushback (→ `superpowers:receiving-code-review`) |
| `defer` | valid but out of scope now | ledger (stays deferred across runs) |
| `needs-decision` | valid but needs a product/spec call, **or** has no resolvable location | → `specs` |
| `conflict` | contradicts another finding | both surfaced for a human; never silently pick one |

**Locationless findings** (file- or PR-level comments) get an explicit lane: resolve a concrete
location during triage, else route to `needs-decision` — never drop them silently.

## Stable id & the triage ledger

Every finding gets a **stable id** = `source::location::title` (a composite key — deterministic,
readable). A **triage ledger** records the verdict + reason for each finding keyed by stable id.
This one mechanism gives: **idempotent re-runs** (already-`reject`/`defer`/`needs-decision`
findings aren't re-litigated), **re-review identity** (tell "same finding" from "new" so "loop
until green" measures progress, not churn), and **deferred tracking** (deferred findings stay
visible). Schema details → [schema.md](schema.md).

## Parallelism via subagents

Fanning out independent work is owned by `superpowers:dispatching-parallel-agents` (ad-hoc
fan-out) and `superpowers:subagent-driven-development` (independent plan tasks) — cite them, don't
restate. Where each applies:

- **Gather (1)** — independent sources → one subagent per source.
- **Triage (3)** — each finding judged independently → one subagent per finding (the core
  fan-out). The dedup/conflict/order step afterwards needs all results together, so it does
  **not** parallelise.
- **Fix (5)** — the plan is grouped by file so **independent groups run concurrently**, one
  subagent per group, via `superpowers:subagent-driven-development`; worktree isolation only when
  groups could touch shared files. Within a group, serial.
- **Re-review (7)** — review agents run in parallel, as `rust-audit` orchestrates them.

## Rust wiring

Which agents to re-dispatch, the fix-to-skill routing, and the "what proves what" proof table →
[rust.md](rust.md).

## Closing the loop on GitHub

Reading PR threads, and drafting/posting/resolving replies (only after explicit user OK) →
[github.md](github.md).

## Boundaries

- *How* to fix a specific problem → topic skills (`rust-errors`, `rust-ownership`,
  `rust-concurrency`, `rust-security`, …).
- *How* to write the missing test → `rust-testing`; the RED→GREEN mechanic →
  `superpowers:test-driven-development` (cite, don't restate).
- Generic feedback discipline → `superpowers:receiving-code-review`; proof →
  `superpowers:verification-before-completion`; plan formalization/execution →
  `superpowers:writing-plans` / `executing-plans`; parallel fan-out →
  `superpowers:dispatching-parallel-agents` / `subagent-driven-development`.
- Findings needing product/spec input → `specs`.
- This skill does **not** rewrite for the reviewer and does **not** duplicate the `rust-review`
  rubric or its proof table — it cites them.
````

- [ ] **Step 2: Verify the file is well-formed**

Run:
```bash
head -3 skills/addressing-findings/SKILL.md | grep -q "^name: addressing-findings" && \
grep -q "Triggers:" skills/addressing-findings/SKILL.md && \
grep -q "The fix loop" skills/addressing-findings/SKILL.md && \
grep -q "Parallelism via subagents" skills/addressing-findings/SKILL.md && \
grep -Eq "\[schema.md\]\(schema.md\)" skills/addressing-findings/SKILL.md && \
grep -Eq "\[rust.md\]\(rust.md\)" skills/addressing-findings/SKILL.md && \
grep -Eq "\[github.md\]\(github.md\)" skills/addressing-findings/SKILL.md && echo OK
```
Expected: `OK`

- [ ] **Step 3: Commit**

```bash
git add skills/addressing-findings/SKILL.md
git commit -m "feat(addressing-findings): add the fix-loop skill entry"
```

---

### Task 2: Sub-file — `schema.md`

**Files:**
- Create: `skills/addressing-findings/schema.md`

- [ ] **Step 1: Write schema.md**

Create `skills/addressing-findings/schema.md` with exactly this content:

````markdown
# Unified finding schema

One schema for both sources. The first four fields reuse `rust-audit`'s finding fields
(`workflows/rust-audit.js`) so a `rust-audit` report maps onto this schema **mechanically**; the
rest are what the fix side needs.

```
{
  stable_id,      // source::location::title — durable identity (dedup, ledger, idempotent re-runs)
  source,         // "rust-audit" | "rust-reviewer" | "rust-security-scanner" | "github-pr" | ...
  severity,       // Critical | High | Medium | Low | Info   (same vocabulary as rust-audit)
  title,          // short "what"
  location,       // "file:line" | "crate/module" | "PR-level" | "" (may be absent)
  detail,         // "why"
  proposed_fix,   // optional — the fix direction from the source, if any
  thread_id,      // optional — GitHub review thread id (for loop closure)
}
```

After triage each finding carries a **compact** result (kept small so the ordering/plan step
doesn't blow up on a large PR):

```
{ stable_id, verdict, reason, fix_pointer }
// verdict ∈ accept | reject | defer | needs-decision   (conflict is assigned later, when all
//   findings are visible together)
// fix_pointer = owning topic skill + one-line direction (NOT the full proof text); empty unless accept
```

## Per-source mapping

**craft agent / `rust-audit` report** — each report finding already has
`severity · title · location · detail`; copy them verbatim. `source` = `rust-audit` (or the
specific agent, e.g. `rust-reviewer`). `proposed_fix` / `thread_id` empty.

**GitHub PR inline comment** — from `gh api .../pulls/<pr>/comments`:
`title` = a short summary of the comment, `location` = `<path>:<line>` (`path` + `line`/
`original_line` from the comment), `detail` = the comment body, `thread_id` = the comment/thread
id, `severity` = best estimate, `source` = `github-pr`. Skip outdated/resolved threads.

## Triage ledger

A persisted artifact (e.g. `triage-ledger.json` next to the plan) — one entry per finding keyed
by `stable_id` with its final verdict + one-line reason. Read it at the start of a re-run so
already-`reject`/`defer`/`needs-decision` findings are carried, not re-litigated, and so the
re-review loop can tell a recurring finding from a new one.
````

- [ ] **Step 2: Verify**

Run:
```bash
grep -q "stable_id" skills/addressing-findings/schema.md && \
grep -q "Per-source mapping" skills/addressing-findings/schema.md && \
grep -q "Triage ledger" skills/addressing-findings/schema.md && echo OK
```
Expected: `OK`

- [ ] **Step 3: Commit**

```bash
git add skills/addressing-findings/schema.md
git commit -m "docs(addressing-findings): add the unified finding schema sub-file"
```

---

### Task 3: Sub-file — `rust.md`

**Files:**
- Create: `skills/addressing-findings/rust.md`

- [ ] **Step 1: Write rust.md**

Create `skills/addressing-findings/rust.md` with exactly this content:

````markdown
# Rust wiring

The Rust-specific half of the fix loop: who to re-dispatch, where each fix lives, and what proves
a fix landed.

## Fix → owning skill (step 5)

This skill flags *that* something needs fixing; the owning topic skill says *how*. The routing
mirrors the `rust-review` severity checklist:

| Finding area | Owning skill |
|---|---|
| safety / injection / secrets / untrusted input | `rust-security` |
| `unsafe` / missing `// SAFETY:` | `rust-unsafe` |
| Result-vs-panic, typed-error-vs-`anyhow` | `rust-errors` |
| `.clone()` / `&str`-vs-`String` / lifetimes | `rust-ownership` |
| blocking-in-async / lock-across-`.await` / deadlock / `Send`+`Sync` | `rust-concurrency` |
| allocation / hot-path / N+1 | `rust-performance` |
| code smell / naming / wildcard match / missing `///` | `rust-idioms` |
| missing tests | `rust-testing` |

A **bug fix** starts by finding the root cause before touching code (→
`superpowers:systematic-debugging`; the Rust toolbox → `debugging`), then a regression test:
write it, watch it fail (RED), fix, watch it pass (GREEN). The TDD mechanic →
`superpowers:test-driven-development`; the Rust test tooling → `rust-testing`. (Cite them —
don't restate.)

## Verify (step 6)

Prove each fix with the matching command from the `rust-review` "Proving a claim — what proves
what" table — do not re-derive it here, cite it: `rust-review` SKILL.md, the "Proving a claim"
section. The discipline (no "done" without a fresh run you read this session) →
`superpowers:verification-before-completion`.

## Re-review (step 7)

Re-dispatch the craft review agents on the post-fix diff (a **fresh** agent each time — they carry
no memory of the prior round):

- `craft:rust-reviewer` — the gate + the rubric.
- `craft:rust-security-scanner` — when the change touched deps / `unsafe` / input handling.
- `craft:rust-miri` — when the change touched `unsafe`.
- or re-run the `rust-audit` workflow for all of them at once.

Feed the new findings back into the loop. The triage ledger (keyed by `stable_id`) dedups
recurring findings from genuinely new ones, so "loop until green" terminates on progress, not
churn.
````

- [ ] **Step 2: Verify**

Run:
```bash
grep -q "Fix → owning skill" skills/addressing-findings/rust.md && \
grep -q "craft:rust-reviewer" skills/addressing-findings/rust.md && \
grep -q "what proves" skills/addressing-findings/rust.md && echo OK
```
Expected: `OK`

- [ ] **Step 3: Commit**

```bash
git add skills/addressing-findings/rust.md
git commit -m "docs(addressing-findings): add the Rust wiring sub-file"
```

---

### Task 4: Sub-file — `github.md`

**Files:**
- Create: `skills/addressing-findings/github.md`

- [ ] **Step 1: Write github.md**

Create `skills/addressing-findings/github.md` with exactly this content:

````markdown
# GitHub loop

Reading PR review comments (step 1) and closing the threads after the fix lands (step 8). All
outward writes (replies, resolution) happen **only after explicit user approval** — prepare
drafts, show them, wait for "ok".

## Gather PR comments (step 1)

```bash
# resolve the repo
gh repo view --json owner,name
# all review (inline) comments on the PR, paginated
gh api repos/{owner}/{repo}/pulls/<PR>/comments --paginate
```

Each item → one finding (→ [schema.md](schema.md), "Per-source mapping"). Key fields per comment:
`path`, `line`/`original_line`, `body`, `id`, `in_reply_to_id`, and the thread's resolved state.
Skip outdated/resolved threads.

## Close the loop (step 8)

After the fix is committed and re-review is green:

1. For each addressed thread, draft a reply: **what was fixed** + the **commit sha**, or **why it
   was rejected** (from the ledger reason).
2. Show all drafts to the user. **Do not post anything until the user explicitly approves.**
3. On approval, post each reply and resolve its thread:

```bash
# reply to a review comment thread
gh api repos/{owner}/{repo}/pulls/<PR>/comments \
  --method POST -f body="<reply>" -F in_reply_to=<comment_id>

# resolve the thread (GraphQL — needs the review thread node id, not the REST comment id)
gh api graphql -f query='
  mutation($id: ID!) {
    resolveReviewThread(input: {threadId: $id}) { thread { isResolved } }
  }' -f id=<thread_node_id>
```

Map each reply back to its thread via the `thread_id` carried on the finding through the fix.
````

- [ ] **Step 2: Verify**

Run:
```bash
grep -q "Gather PR comments" skills/addressing-findings/github.md && \
grep -q "resolveReviewThread" skills/addressing-findings/github.md && \
grep -q "explicit" skills/addressing-findings/github.md && echo OK
```
Expected: `OK`

- [ ] **Step 3: Commit**

```bash
git add skills/addressing-findings/github.md
git commit -m "docs(addressing-findings): add the GitHub loop sub-file"
```

---

### Task 5: Workflow — `workflows/triage-findings.js`

**Files:**
- Create: `workflows/triage-findings.js`

- [ ] **Step 1: Write the workflow**

Create `workflows/triage-findings.js` with exactly this content:

```javascript
export const meta = {
  name: 'triage-findings',
  description: 'Triage review findings (craft agents + GitHub PR comments) into one ordered, validated fix plan — no edits',
  whenToUse: 'After a review or rust-audit produces many findings, or a PR has many inline comments, and you want them validated against the code, deduped, conflict-checked, and turned into an ordered fix plan.',
  phases: [
    { title: 'Gather', detail: 'pull raw findings from the requested sources (rust-audit report, reviewer verdict, GitHub PR threads)' },
    { title: 'Validate', detail: 'judge each finding against the code at a pinned ref: accept / reject / defer / needs-decision' },
    { title: 'Plan', detail: 'dedup, detect conflicts, group by file, order, render a writing-plans-format fix plan + triage ledger' },
  ],
}

// Locator args (not payload): pr (GitHub PR number), report (path to a rust-audit report or saved
// verdict), base (ref to pin validation against), priorLedger (array of prior {stable_id, verdict,
// reason} for idempotent re-runs). At least one of pr/report must be given.
const pr = (args && args.pr) ? String(args.pr) : ''
const report = (args && args.report) ? String(args.report) : ''
const base = (args && args.base) ? String(args.base) : ''
const priorLedger = (args && Array.isArray(args.priorLedger)) ? args.priorLedger : []

const RAW_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['source', 'findings'],
  properties: {
    source: { type: 'string', description: 'rust-audit | rust-reviewer | github-pr' },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['severity', 'title', 'location', 'detail', 'proposed_fix', 'thread_id'],
        properties: {
          severity: { type: 'string', description: 'Critical | High | Medium | Low | Info' },
          title: { type: 'string' },
          location: { type: 'string', description: 'file:line, crate/module, PR-level, or empty if none' },
          detail: { type: 'string', description: 'why it is a problem' },
          proposed_fix: { type: 'string', description: 'fix direction from the source, empty if none' },
          thread_id: { type: 'string', description: 'GitHub review thread id, empty if not from a PR' },
        },
      },
    },
  },
}

const VALIDATION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['stable_id', 'verdict', 'reason', 'fix_pointer'],
  properties: {
    stable_id: { type: 'string', description: 'composite identity: source::location::title' },
    verdict: { type: 'string', description: 'accept | reject | defer | needs-decision' },
    reason: { type: 'string', description: 'one line justifying the verdict against the code' },
    fix_pointer: { type: 'string', description: 'owning craft skill + one-line fix direction; empty unless accept' },
  },
}

const PLAN_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['plan_markdown', 'ledger', 'summary'],
  properties: {
    plan_markdown: { type: 'string', description: 'the fix plan in superpowers:writing-plans format (accepted findings only)' },
    ledger: {
      type: 'array',
      description: 'every finding keyed by stable_id with its final verdict',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['stable_id', 'verdict', 'reason'],
        properties: {
          stable_id: { type: 'string' },
          verdict: { type: 'string', description: 'accept | reject | defer | needs-decision | conflict' },
          reason: { type: 'string' },
        },
      },
    },
    summary: { type: 'string', description: 'human-readable rundown of reject/defer/needs-decision/conflict' },
  },
}

// ---- Gather --------------------------------------------------------------
phase('Gather')
if (!pr && !report) {
  throw new Error('triage-findings needs a source: pass args.pr (GitHub PR number) and/or args.report (path to a rust-audit report).')
}

const gatherTasks = []
if (report) {
  gatherTasks.push(() => agent(
    `Read the review report at \`${report}\`. Extract every finding into the schema. Set source to "rust-audit" (or "rust-reviewer" for a single reviewer verdict). Copy severity/title/location/detail verbatim; leave proposed_fix and thread_id empty unless present.`,
    { label: 'gather:report', phase: 'Gather', schema: RAW_SCHEMA },
  ))
}
if (pr) {
  gatherTasks.push(() => agent(
    `Gather inline review comments from GitHub PR #${pr}. Resolve the repo with \`gh repo view --json owner,name\`, then \`gh api repos/{owner}/{repo}/pulls/${pr}/comments --paginate\`. For each UNRESOLVED, non-outdated review comment make one finding: title = short summary, location = \`<path>:<line>\` (path + line/original_line), detail = the comment body, thread_id = the comment/thread id, severity = your best estimate (Critical|High|Medium|Low|Info), proposed_fix = empty. Set source = "github-pr".`,
    { label: 'gather:pr', phase: 'Gather', schema: RAW_SCHEMA },
  ))
}

const gathered = (await parallel(gatherTasks)).filter(Boolean)
const raw = gathered.flatMap(g => g.findings.map(f => ({ ...f, source: g.source })))
log(`Gathered ${raw.length} raw finding(s) from ${gathered.length} source(s).`)

// stable composite id; reused for dedup, ledger, and idempotent re-runs
const idOf = f => `${f.source}::${f.location || 'no-loc'}::${f.title}`
const priorById = new Map(priorLedger.map(e => [e.stable_id, e]))

// ---- Validate ------------------------------------------------------------
phase('Validate')
const pin = base
  ? `Validate against ref \`${base}\` (the ref the findings were generated against), not the live working tree.`
  : 'Validate against the currently checked-out tree.'

const validations = (await parallel(raw.map(f => () => {
  const id = idOf(f)
  const prior = priorById.get(id)
  // Idempotent re-run: keep a prior non-accept verdict rather than re-litigating it.
  if (prior && prior.verdict !== 'accept') {
    return Promise.resolve({ stable_id: id, verdict: prior.verdict, reason: `carried from prior run: ${prior.reason}`, fix_pointer: '' })
  }
  return agent(
    `Judge ONE review finding against the actual code. ${pin}

Finding (source: ${f.source}):
- severity: ${f.severity}
- location: ${f.location || '(none given)'}
- what: ${f.title}
- why: ${f.detail}
${f.proposed_fix ? `- proposed fix: ${f.proposed_fix}` : ''}

Read the cited code, then decide ONE verdict:
- accept — a real, in-scope problem. fix_pointer = owning craft skill (rust-errors/rust-ownership/rust-concurrency/rust-security/rust-performance/rust-idioms/rust-testing/rust-unsafe) + a one-line fix direction.
- reject — not a real problem / wrong; explain why (this becomes reviewer pushback).
- defer — real but out of scope now; say why.
- needs-decision — valid but needs a product/spec decision, OR the finding has no resolvable location; say what is needed.

stable_id MUST be exactly: ${id}
Keep reason to one line. fix_pointer empty unless verdict is accept.`,
    { label: `validate:${(f.location || f.title).slice(0, 40)}`, phase: 'Validate', schema: VALIDATION_SCHEMA },
  )
}))).filter(Boolean)

const accepted = validations.filter(v => v.verdict === 'accept')
log(`Validated ${validations.length}: ${accepted.length} accept, ${validations.length - accepted.length} other.`)

// ---- Plan ----------------------------------------------------------------
phase('Plan')
// Re-attach each accepted validation's raw finding so the planner has location/detail.
const rawById = new Map(raw.map(f => [idOf(f), f]))
const acceptedEnriched = accepted.map(v => ({ ...v, finding: rawById.get(v.stable_id) || null }))

const plan = await agent(
  `Turn validated review findings into ONE fix plan. Do not invent findings; only organise what is given.

1. Dedup by stable_id (merge findings at the same location with the same fix).
2. Detect conflicts — two findings demanding opposite changes. Mark each such finding verdict "conflict" in the ledger, DO NOT put it in the plan, and surface both in the summary for a human to decide.
3. Group the remaining accepted findings by file; order groups blocking (Critical/High) → simple → complex.
4. Render plan_markdown in the superpowers:writing-plans format: one task per file-group, bite-sized checkbox steps, each step naming the file and the owning craft skill; a bug fix starts with a RED→GREEN regression test. Mark independent file-groups as parallelisable (one subagent per group).
5. ledger = EVERY finding (accept/reject/defer/needs-decision/conflict) keyed by stable_id with verdict + one-line reason. summary = human-readable rundown of everything not in the plan.

ACCEPTED (with their findings):
${JSON.stringify(acceptedEnriched, null, 2)}

ALL VERDICTS (include reject/defer/needs-decision in the ledger):
${JSON.stringify(validations, null, 2)}`,
  { label: 'plan', phase: 'Plan', schema: PLAN_SCHEMA },
)

return plan
```

- [ ] **Step 2: Syntax-check the workflow**

The harness wraps the script body in an async function, so the file legally uses top-level
`await` **and** top-level `return` (as `rust-audit.js` does) — a plain `node --check` would
false-fail on the `return`. Check with the same wrapping the harness uses (strip `export`, wrap
the body in an async IIFE):
```bash
{ echo '(async () => {'; sed 's/^export const meta/const meta/' workflows/triage-findings.js; echo '})()'; } > /tmp/tf-check.mjs && node --check /tmp/tf-check.mjs && rm /tmp/tf-check.mjs && echo SYNTAX_OK
```
Expected: `SYNTAX_OK` (verified during planning against this exact workflow and cross-checked on `rust-audit.js`)

- [ ] **Step 3: Verify the meta shape**

Run:
```bash
grep -q "name: 'triage-findings'" workflows/triage-findings.js && \
grep -c "phase('" workflows/triage-findings.js   # expect 3
```
Expected: first grep matches (exit 0); count is `3`.

- [ ] **Step 4: Commit**

```bash
git add workflows/triage-findings.js
git commit -m "feat(triage-findings): add the triage→fix-plan workflow"
```

---

### Task 6: Slim `rust-review` to point at `addressing-findings`

**Files:**
- Modify: `skills/rust-review/SKILL.md` (the "Requesting a review & acting on the verdict" section)

- [ ] **Step 1: Replace the "Act on the verdict" block with a pointer**

In `skills/rust-review/SKILL.md`, find this block:

```markdown
Act on the verdict:

- **Block** → fix before doing anything else.
- **Warning** → judge; fix or consciously accept with a reason.
- **Approve** → proceed — but still confirm green yourself (→ "Proving a claim" below).
- **Wrong finding** → push back with reasoning; don't implement a wrong suggestion just because it was raised.

Order multi-item feedback blocking → simple → complex, and test each. *How* to act on the comments without performing (verify-before-implement, no performative agreement, reasoned pushback) → `superpowers:receiving-code-review`.
```

Replace it with:

```markdown
**Acting on the verdict** — working a set of findings to green (triage accept/reject/defer/needs-decision, order blocking → simple → complex, fix, verify, re-review, close the loop on GitHub) is its own discipline → `addressing-findings`; for a large batch it dispatches the `triage-findings` workflow. The generic "act without performing" method (verify-before-implement, no performative agreement, reasoned pushback) → `superpowers:receiving-code-review`.
```

- [ ] **Step 2: Verify the re-point landed and the old block is gone**

Run:
```bash
grep -q "Acting on the verdict" skills/rust-review/SKILL.md && \
grep -q "addressing-findings" skills/rust-review/SKILL.md && \
! grep -q "Block.*→ fix before doing anything else" skills/rust-review/SKILL.md && echo OK
```
Expected: `OK`

- [ ] **Step 3: Commit**

```bash
git add skills/rust-review/SKILL.md
git commit -m "refactor(rust-review): point acting-on-the-verdict at addressing-findings"
```

---

### Task 7: Add rows to `MAP.md`

**Files:**
- Modify: `MAP.md` (Cross-cutting skills table + Workflows table)

- [ ] **Step 1: Add the skill row to the "Cross-cutting skills" table**

In `MAP.md`, in the "Cross-cutting skills (language-agnostic)" table, add this row (after the
`codebase-onboarding` row):

```markdown
| `addressing-findings` | ✅ | the fix loop for review findings: gather (craft agents + GitHub PR comments) → normalize → triage (accept/reject/defer/needs-decision/conflict) → order → fix → verify → re-review → close the GitHub loop; scales to the `triage-findings` workflow | the review *rubric* → `rust-review`; *running* the agents → `rust-audit`; generic feedback method → `superpowers:receiving-code-review`; *how* to fix → topic skills |
```

- [ ] **Step 2: Add the workflow row to the "Workflows" table**

In `MAP.md`, in the Workflows table (the one with the `rust-audit` row), add:

```markdown
| `triage-findings` | gather → validate (parallel, per finding) → plan (barrier) | one ordered fix plan (writing-plans format) + triage ledger; no edits |
```

- [ ] **Step 3: Verify**

Run:
```bash
grep -q "addressing-findings" MAP.md && grep -q "triage-findings" MAP.md && echo OK
```
Expected: `OK`

- [ ] **Step 4: Commit**

```bash
git add MAP.md
git commit -m "docs(map): add addressing-findings skill and triage-findings workflow"
```

---

### Task 8: Add rows to `README.md`

**Files:**
- Modify: `README.md` (the Contents table)

- [ ] **Step 1: Add the skill row**

In `README.md`'s Contents table, after the `craft:debugging` / `craft:refactoring` /
`craft:codebase-onboarding` skill rows, add:

```markdown
| skill | `craft:addressing-findings` | The fix loop for review findings — gather (craft agents + GitHub PR comments), normalize, triage (accept/reject/defer/needs-decision/conflict), order, fix (delegating how-to-fix to topic skills), verify, re-review, close the GitHub loop; scales to the `triage-findings` workflow |
```

- [ ] **Step 2: Add the workflow row**

In `README.md`'s Contents table, after the `rust-audit` workflow row, add:

```markdown
| workflow | `triage-findings` | Validates review findings (craft agents + GitHub PR comments) in parallel, dedups/conflict-checks, and renders one ordered fix plan (writing-plans format) + a triage ledger — no edits |
```

- [ ] **Step 3: Verify**

Run:
```bash
grep -q "craft:addressing-findings" README.md && grep -q "triage-findings" README.md && echo OK
```
Expected: `OK`

- [ ] **Step 4: Commit**

```bash
git add README.md
git commit -m "docs(readme): list addressing-findings skill and triage-findings workflow"
```

---

## Final validation (after all tasks)

- [ ] **Structural sweep** — every new/changed file is present and cross-linked:

```bash
ls skills/addressing-findings/{SKILL.md,schema.md,rust.md,github.md} workflows/triage-findings.js && \
grep -q "addressing-findings" skills/rust-review/SKILL.md && \
grep -q "addressing-findings" MAP.md README.md && echo ALL_PRESENT
```
Expected: the five paths list, then `ALL_PRESENT`.

- [ ] **Optional smoke run (user opt-in, billed)** — the workflow spawns subagents, so run it only
  with the user's go-ahead, against a real source:
  `Workflow({ scriptPath: "workflows/triage-findings.js", args: { report: "<path-to-a-rust-audit-report>" } })`
  Confirm it returns `{ plan_markdown, ledger, summary }` and the plan lists only accepted findings.

- [ ] **Dogfood (optional)** — run a `craft:rust-reviewer` over this branch's diff and feed any
  findings through the new `addressing-findings` loop.
