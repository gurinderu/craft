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
// `args` may arrive as a parsed object or as a JSON string depending on the harness — normalize.
let argv = {}
if (args && typeof args === 'object') argv = args
else if (typeof args === 'string' && args.trim()) { try { argv = JSON.parse(args) } catch { argv = {} } }

const pr = argv.pr ? String(argv.pr) : ''
const report = argv.report ? String(argv.report) : ''
const base = argv.base ? String(argv.base) : ''
const priorLedger = Array.isArray(argv.priorLedger) ? argv.priorLedger : []

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
  // Idempotent re-run: carry a prior *settled* verdict rather than re-litigating it. `accept` is
  // re-validated (the code may have changed since); `conflict` is a cross-finding judgement, so it
  // is re-derived fresh in the Plan phase rather than carried as a stale solo verdict.
  if (prior && ['reject', 'defer', 'needs-decision'].includes(prior.verdict)) {
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
  `Turn validated review findings into ONE fix plan. Do not invent findings; only organise what is given. Ignore any ACCEPTED entry whose \`finding\` is null (a data glitch) — leave it out of the plan and note it in the summary.

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
