export const meta = {
  name: 'rust-audit',
  description: 'Full Rust crate audit — review, architecture, security, and Miri in parallel, synthesized into one report',
  whenToUse: 'Before a release or a big merge, when you want every craft review agent run at once and consolidated into a single verdict.',
  phases: [
    { title: 'Scout', detail: 'detect the diff base and whether the workspace has unsafe code', model: 'haiku' },
    { title: 'Audit', detail: 'parallel rust-reviewer / rust-architecture-reviewer / rust-security-scanner / rust-miri' },
    { title: 'Synthesize', detail: 'merge the verdicts into one severity-ranked report' },
  ],
}

// Optional: pass {base: "origin/main"} as args to fix the diff base for the reviewer.
const baseArg = (args && typeof args === 'object' && args.base) ? String(args.base) : ''

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

const FINDINGS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['dimension', 'verdict', 'summary', 'findings'],
  properties: {
    dimension: { type: 'string', description: 'review | architecture | security | miri' },
    verdict: { type: 'string', description: 'Approve/Warning/Block, Healthy/Concerns/At-risk, or Clean/UB-found' },
    summary: { type: 'string', description: 'one-paragraph bottom line' },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['severity', 'title', 'location', 'detail'],
        properties: {
          severity: { type: 'string', description: 'Critical | High | Medium | Low | Info' },
          title: { type: 'string' },
          location: { type: 'string', description: 'file:line or crate/module, empty if not applicable' },
          detail: { type: 'string', description: 'what is wrong and the direction of the fix' },
        },
      },
    },
  },
}

phase('Scout')
const scout = await agent(
  `You are scouting a Rust workspace to plan an audit. Use shell commands only — do NOT review anything yet.

1. Determine the diff base. ${baseArg
    ? `Use \`${baseArg}\` as the base ref.`
    : 'Try in order until one resolves: `git merge-base HEAD origin/main`, `git merge-base HEAD main`, `HEAD~1`.'}
2. hasDiff = true if \`git diff --name-only <base>...HEAD\` lists any \`.rs\` file, OR \`git status --porcelain\` shows uncommitted \`.rs\` changes.
3. hasUnsafe = true if \`grep -rnE "\\bunsafe\\b" --include=*.rs .\` finds any match (a rough check is fine; ignore obvious comment-only hits if cheap to do).
4. baseRef = the ref you actually used (empty string if none resolved).`,
  // Scout is pure mechanics (git refs + grep) — run it cheap: Haiku at low effort.
  { label: 'scout', schema: SCOUT_SCHEMA, model: 'haiku', effort: 'low' },
)
// scout is null if the agent was skipped or died — fall back to safe defaults rather than crash.
const baseRef = scout?.baseRef ?? ''
const hasUnsafe = scout?.hasUnsafe ?? true // fail-safe: run Miri when detection didn't resolve
log(scout?.notes ?? 'scout produced no result — assuming unsafe present, no base ref')

phase('Audit')
const tasks = [
  () => agent(
    `Review the Rust diff for mergeability using the rust-review rubric (load the rust-review skill). ${baseRef
      ? `Diff base: \`${baseRef}\`.`
      : 'There is no clean base ref — review uncommitted changes, or the most recent commit if the tree is clean.'} Establish the gate CI-aware (consume green required CI checks; never silently skip a check) and state its provenance (CI vs local) in your summary. Return your verdict and findings.`,
    { label: 'review:diff', agentType: 'craft:rust-reviewer', phase: 'Audit', schema: FINDINGS_SCHEMA },
  ).then(r => (r ? { ...r, dimension: 'review' } : null)),

  () => agent(
    `Audit the architecture of this whole Rust project against the rust-architecture-review rubric (load the rust-architecture-review skill). Build the crate/module dependency graph and judge the structure in BOTH directions — too little (layer leaks, god modules) and too much (ghost abstractions, over-layering). Return your health rating and findings.`,
    { label: 'architecture', agentType: 'craft:rust-architecture-reviewer', phase: 'Audit', schema: FINDINGS_SCHEMA },
  ).then(r => (r ? { ...r, dimension: 'architecture' } : null)),

  () => agent(
    `Run the Rust security toolchain (cargo-audit, cargo-deny, cargo-geiger, semgrep — whatever is available) against the rust-security rubric (load the rust-security skill). Consolidate into a severity-ranked verdict and findings.`,
    { label: 'security', agentType: 'craft:rust-security-scanner', phase: 'Audit', schema: FINDINGS_SCHEMA },
  ).then(r => (r ? { ...r, dimension: 'security' } : null)),
]

if (hasUnsafe) {
  tasks.push(
    () => agent(
      `This workspace contains unsafe code. Run its tests under Miri and report any undefined behavior against the rust-unsafe rubric (load the rust-unsafe skill). Return a verdict (Clean / UB-found) and findings.`,
      { label: 'miri', agentType: 'craft:rust-miri', phase: 'Audit', schema: FINDINGS_SCHEMA },
    ).then(r => (r ? { ...r, dimension: 'miri' } : null)),
  )
} else {
  log('No unsafe code detected — skipping Miri.')
}

const results = (await parallel(tasks)).filter(Boolean)

// Dimensions we dispatched but got no result for (agent skipped or died). Miri is excluded when
// there's no unsafe code — that's an intentional skip, not a failure, so it never lands here.
const expectedDimensions = ['review', 'architecture', 'security', ...(hasUnsafe ? ['miri'] : [])]
const ran = new Set(results.map(r => r.dimension))
const notRun = expectedDimensions.filter(d => !ran.has(d))
if (notRun.length) log(`No result from: ${notRun.join(', ')} — flagged NOT RUN in the report.`)

phase('Synthesize')
const report = await agent(
  `You are consolidating a Rust audit. Below are JSON results from independent review agents. Produce ONE markdown report — do not invent findings, only merge what is given:

1. An **overall verdict** line — the worst case across all dimensions. If any dimension did not run, mark the audit INCOMPLETE.
2. A **dimension → verdict** table. Add a row for every dimension under NOT RUN below with verdict \`NOT RUN\` — its agent failed or was skipped, so do not treat its absence as a pass.
3. **Findings by severity** (Critical first), each tagged with its dimension and location, plus a one-line fix direction.
4. A short **"Fix first"** list — the few highest-leverage items.
5. If the review dimension's summary names a **gate provenance** (CI vs local), surface it in one line under the verdict so a reader knows whether the mechanical gate was consumed from CI or run locally.

NOT RUN (no result — agent failed or was skipped): ${notRun.length ? notRun.join(', ') : 'none'}

RESULTS:
${JSON.stringify(results, null, 2)}`,
  // Synthesis is merge/dedup/rank of given verdicts — moderate reasoning, not a deep judgement call.
  { label: 'synthesis', effort: 'medium' },
)

return report
