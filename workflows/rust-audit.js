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
4. baseRef = the ref you actually used (empty string if none resolved).
5. crates = workspace members from \`cargo metadata --no-deps --format-version 1\` — each as {name, path} where path is the crate's manifest directory relative to the repo root. Empty array if \`cargo metadata\` is unavailable.
6. changedCrates = the subset of \`crates\` whose directory contains a \`.rs\` file listed by \`git diff --name-only <base>...HEAD\` (or \`git status --porcelain\` for uncommitted work). Empty if no base or no changed \`.rs\`.
7. edges = intra-workspace dependency edges from \`cargo metadata --format-version 1\`: {from, to} where BOTH \`from\` and \`to\` are workspace members and \`from\` depends on \`to\`. Empty array if \`cargo metadata\` is unavailable.`,
  // Scout is pure mechanics (git refs + grep) — run it cheap: Haiku at low effort.
  { label: 'scout', schema: SCOUT_SCHEMA, model: 'haiku', effort: 'low' },
)
// scout is null if the agent was skipped or died — fall back to safe defaults rather than crash.
const baseRef = scout?.baseRef ?? ''
const hasUnsafe = scout?.hasUnsafe ?? true // fail-safe: run Miri when detection didn't resolve
const crates = Array.isArray(scout?.crates) ? scout.crates : []
const changedCrates = Array.isArray(scout?.changedCrates) ? scout.changedCrates : []
const edges = Array.isArray(scout?.edges) ? scout.edges : []
log(scout?.notes ?? 'scout produced no result — assuming unsafe present, no base ref')

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
