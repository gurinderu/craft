export const meta = {
  name: 'rust-audit',
  description: 'Full Rust crate audit — per-crate review, inter-crate contracts, architecture, crate decomposition, security, Miri, semver, build-matrix, deps, unused-crate detection (verified), and test/doc health in parallel, synthesized into one report',
  whenToUse: 'Before a release or a big merge, when you want the comprehensive full review — every craft dimension run at once and consolidated into a single verdict. Pass {base} to fix the diff base; {mutants:true} to include the slow mutation pass.',
  phases: [
    { title: 'Scout', detail: 'detect the diff base, unsafe code, and the workspace crates + dependency edges', model: 'haiku' },
    { title: 'Audit', detail: 'parallel per-crate review + per-edge contracts + architecture + crate-decomposition + security + Miri + semver/build-matrix/deps/unused-crates/tests-cov' },
    { title: 'Verify', detail: 'adversarially verify unused-crate candidates before reporting' },
    { title: 'Synthesize', detail: 'merge every dimension into one severity-ranked report' },
  ],
}

// Optional args: {base: "origin/main"} fixes the diff base; {mutants: true} opts into the slow
// mutation-testing pass in the tests-cov dimension.
const baseArg = (args && typeof args === 'object' && args.base) ? String(args.base) : ''
const runMutants = !!(args && typeof args === 'object' && args.mutants)

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
    dimension: { type: 'string', description: 'dimension label, e.g. review:<crate> | contract:<from>→<to> | architecture | security | miri | crate-decomposition | semver | build-matrix | deps | unused-crates | tests-cov' },
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

// Verdict for one unused-crate candidate. The verifier's job is to REFUTE (prove the crate IS
// used); confirmedUnused=true means it survived that and is safe to remove.
const UNUSED_VERDICT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['confirmedUnused', 'evidence', 'removal'],
  properties: {
    confirmedUnused: { type: 'boolean', description: 'true ONLY if genuinely unused after trying to refute; default false when uncertain' },
    evidence: { type: 'string', description: 'what was checked — use sites, cfg/feature gates, macros, re-exports, build.rs, dev/bench/example usage, bin/published status' },
    removal: { type: 'string', description: 'concrete removal direction if confirmed unused; empty otherwise' },
  },
}

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
    tasks.push(() => workflow('rust-review', { base: baseRef, path: c.path, _via: 'rust-audit' })
      .then(report => reviewResult(`review:${c.name}`, report))
      .catch(() => null))
    dispatched.push(`review:${c.name}`)
  }
} else {
  tasks.push(() => workflow('rust-review', baseRef ? { base: baseRef, _via: 'rust-audit' }
                                                   : { _via: 'rust-audit' })
    .then(report => reviewResult('review', report))
    .catch(() => null))
  dispatched.push('review')
}

// Contracts dimension (feature B) — one focused review per TOUCHED intra-workspace edge. An edge
// is touched when its caller or callee is a changed crate; with no base, every edge is touched.
const changedNames = new Set(changedCrates.map(c => c.name))
const touchedEdges = edges.filter(e => !baseRef || changedNames.has(e.from) || changedNames.has(e.to))
if (touchedEdges.length) {
  // The agent `label` uses an ASCII `->` (display-safe); the `dimension` and the matching
  // `dispatched` entry use the Unicode `→` (U+2192). Keep those two in sync — the NOT-RUN
  // bookkeeping compares `dispatched` against `dimension`; do NOT "unify" them to the label's `->`.
  for (const e of touchedEdges) {
    tasks.push(() => agent(
      `Review the call contract on the workspace dependency edge \`${e.from}\` → \`${e.to}\`: does \`${e.from}\` use \`${e.to}\`'s PUBLIC API the way its contract intends? Check signatures and types at the boundary, error and panic contracts, documented invariants and trait laws, and the semver/breaking-change compatibility of \`${e.to}\`'s public surface against \`${e.from}\`'s usage. Load the rust-review skill (the api-design pass), rust-errors (error contracts), and rust-traits (trait laws) for the rubric. Return a verdict and findings.\n\nObservability: the rust-audit workflow records this run — do NOT write your own record.`,
      { label: `contract:${e.from}->${e.to}`, agentType: 'craft:rust-reviewer', phase: 'Audit', schema: FINDINGS_SCHEMA, model: 'opus' },
    ).then(r => (r ? { ...r, dimension: `contract:${e.from}→${e.to}` } : null)))
    dispatched.push(`contract:${e.from}→${e.to}`)
  }
} else {
  log('No intra-workspace dependency edges to review — skipping the contracts dimension.')
}

// Crate-decomposition dimension (feature C) — whole-project; runs even on a single crate.
tasks.push(() => agent(
  `Judge this Rust workspace's crate boundaries and recommend where code should be EXTRACTED into its own crate, or where an over-split crate should be MERGED back. Load the rust-ecosystem skill and its crate-extraction.md rubric, and build on the workspace dependency graph (\`cargo metadata\`). For EACH recommendation give: the DRIVER (reuse / compile parallelism / dependency inversion / trust boundary / independent semver / test isolation / god-crate split — or, for a merge, "single consumer, no boundary reason"), the BOUNDARY (which module or code), and the HOW. Recommend only — do NOT move code. Return a verdict (Healthy / Concerns / At-risk) and findings.`,
  { label: 'crate-decomposition', phase: 'Audit', schema: FINDINGS_SCHEMA, effort: 'medium' },
).then(r => (r ? { ...r, dimension: 'crate-decomposition' } : null)))
dispatched.push('crate-decomposition')

tasks.push(() => agent(
  `Audit the architecture of this whole Rust project against the rust-architecture-review rubric (load the rust-architecture-review skill). Build the crate/module dependency graph and judge the structure in BOTH directions — too little (layer leaks, god modules) and too much (ghost abstractions, over-layering). Return your health rating and findings.\n\nObservability: the rust-audit workflow records this run — do NOT write your own record.`,
  { label: 'architecture', agentType: 'craft:rust-architecture-reviewer', phase: 'Audit', schema: FINDINGS_SCHEMA },
).then(r => (r ? { ...r, dimension: 'architecture' } : null)))
dispatched.push('architecture')

tasks.push(() => agent(
  `Run the Rust security toolchain (cargo-audit, cargo-deny, cargo-geiger, semgrep — whatever is available) against the rust-security rubric (load the rust-security skill). Consolidate into a severity-ranked verdict and findings.\n\nObservability: the rust-audit workflow records this run — do NOT write your own record.`,
  { label: 'security', agentType: 'craft:rust-security-scanner', phase: 'Audit', schema: FINDINGS_SCHEMA, model: 'opus' },
).then(r => (r ? { ...r, dimension: 'security' } : null)))
dispatched.push('security')

if (hasUnsafe) {
  tasks.push(() => agent(
    `This workspace contains unsafe code. Run its tests under Miri and report any undefined behavior against the rust-unsafe rubric (load the rust-unsafe skill). Return a verdict (Clean / UB-found) and findings.\n\nObservability: the rust-audit workflow records this run — do NOT write your own record.`,
    { label: 'miri', agentType: 'craft:rust-miri', phase: 'Audit', schema: FINDINGS_SCHEMA, model: 'opus' },
  ).then(r => (r ? { ...r, dimension: 'miri' } : null)))
  dispatched.push('miri')
} else {
  log('No unsafe code detected — skipping Miri.')
}

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
  `Audit dependency HYGIENE (distinct from security vulns/licenses). Run \`cargo tree -d\` (duplicate/conflicting versions that bloat the build and binary) and \`cargo outdated\` (out-of-date deps). Do NOT check unused dependencies here — the \`unused-crates\` dimension owns that (with verification). Skip any tool that is not installed with a note — do NOT fail. Load the rust-ecosystem skill (dependency weight/hygiene). Report duplicates and notably out-of-date deps as findings.`,
  { label: 'deps', phase: 'Audit', schema: FINDINGS_SCHEMA, effort: 'low' },
).then(r => (r ? { ...r, dimension: 'deps' } : null)))
dispatched.push('deps')

// Unused-crates dimension — detect, then ADVERSARIALLY VERIFY, two classes of dead weight:
//   (a) orphan workspace members — a workspace crate no other member depends on, that is not a
//       binary and not a published library;
//   (b) unused dependencies — deps declared in a Cargo.toml but never used (cargo machete/udeps).
// Both detectors are false-positive-prone (cfg/feature-gated, macro-only, re-exported, build.rs,
// dev/bench/example-only usage), so every candidate is verified before it reaches the report: a
// verifier tries HARD to prove the crate IS used and only the survivors are kept. Self-contained
// find→verify pipeline inside one thunk so it composes with the flat `parallel(tasks)` fan-out.
tasks.push(async () => {
  const found = await agent(
    `Find UNUSED crates in this Rust workspace, in two classes:
(a) ORPHAN workspace members — from \`cargo metadata --format-version 1\`, workspace members that NO other workspace member depends on (any dependency kind), EXCLUDING binaries (a [[bin]] target or src/main.rs) and published libraries (Cargo.toml \`publish\` is not false / it is meant for crates.io).
(b) UNUSED dependencies — run \`cargo machete\` (or \`cargo +nightly udeps\` if machete is absent) to list dependencies declared in a Cargo.toml but not used.
Skip a tool that is not installed with a note — do NOT fail; if nothing runs and the graph is empty, return verdict "Approve" with an empty findings list.
Load the rust-ecosystem skill (dependency / crate hygiene).
These are CANDIDATES, not confirmed — they will be verified downstream. Return one finding per candidate: title = "orphan-member: <crate>" or "unused-dep: <dep> in <crate>", location = the owning manifest path, detail = why the graph/tool thinks it is unused. Use severity Info (verification sets the real severity).`,
    { label: 'unused-crates:find', phase: 'Audit', schema: FINDINGS_SCHEMA, effort: 'low' },
  )
  if (!found) return null
  const candidates = (Array.isArray(found.findings) ? found.findings : [])
    .filter(f => /^(orphan-member|unused-dep):/.test(f.title || ''))
  if (!candidates.length) return { ...found, dimension: 'unused-crates', _verification: { candidates: 0, confirmed: 0 } }
  // Verify each candidate: prove it is USED. Default to "used" (drop it) when uncertain —
  // recommending deletion of live code is the costly error here.
  const verdicts = await parallel(candidates.map((c, i) => () =>
    agent(
      `A detector flagged a crate/dependency as UNUSED. Try HARD to REFUTE that — prove it IS used — before accepting it. Candidate: ${JSON.stringify(c)}.
Check the usages machete/udeps and the dependency graph miss: \`use\`/path references; cfg-gated and feature-gated usage; macro-only and re-exported (\`pub use\`) usage; build.rs / [build-dependencies]; [dev-dependencies] exercised only in tests, benches, or examples; and for an orphan member whether it is actually a bin, an example/bench/xtask, or consumed/published outside this workspace. Grep the source to confirm.
Set confirmedUnused=true ONLY if it is genuinely unused and safe to remove; default to false when uncertain.`,
      { label: `unused-crates:verify#${i + 1}`, phase: 'Verify', schema: UNUSED_VERDICT_SCHEMA, model: 'opus' },
    ).then(v => ({ c, v })),
  ))
  const confirmed = verdicts.filter(Boolean).filter(x => x.v?.confirmedUnused).map(x => ({
    severity: 'Medium',
    title: x.c.title,
    location: x.c.location || '',
    detail: `${x.v.evidence || ''}${x.v.removal ? `\nRemove: ${x.v.removal}` : ''}`.trim() || (x.c.detail || ''),
  }))
  return {
    dimension: 'unused-crates',
    verdict: confirmed.length ? 'Warning' : 'Approve',
    summary: `${candidates.length} candidate(s) flagged; ${confirmed.length} verified unused after trying to refute each (unverified dropped as likely false positives).`,
    findings: confirmed.length ? confirmed : [{ severity: 'Info', title: 'No verified unused crates', location: '', detail: `${candidates.length} candidate(s) flagged, none survived verification.` }],
    _verification: { candidates: candidates.length, confirmed: confirmed.length },
  }
})
dispatched.push('unused-crates')

tasks.push(() => agent(
  `Assess test effectiveness and docs. Run \`cargo llvm-cov --summary-only\` (overall coverage + worst-covered files) if \`cargo-llvm-cov\` is installed.${runMutants ? ' Run \`cargo mutants --timeout 60\`, time-boxed, to surface weak spots (it is slow).' : ' Do NOT run cargo mutants (not requested via {mutants:true}).'} Build docs cleanly: \`cargo doc --no-deps\` (flag broken intra-doc links) and run doctests (\`cargo test --doc\`). Skip any tool that is not installed with a note — do NOT fail. Load the rust-testing skill (coverage/mutation/doctests) and rust-idioms (rustdoc). Report low-coverage hotspots, surviving mutants, broken doc links, and failing doctests as findings.`,
  { label: 'tests-cov', phase: 'Audit', schema: FINDINGS_SCHEMA, effort: 'low' },
).then(r => (r ? { ...r, dimension: 'tests-cov' } : null)))
dispatched.push('tests-cov')

const results = (await parallel(tasks)).filter(Boolean)

// NOT RUN = a dispatched dimension that produced no result (its agent failed). Two intentional
// skips avoid NOT-RUN by never being pushed to `dispatched`: contracts (no touched edges) and
// Miri (no unsafe). The four tool dimensions (semver/build-matrix/deps/tests-cov) ARE pushed
// unconditionally but avoid NOT-RUN differently — their agent always returns a result (verdict
// Approve + a skip note) when the required tool is absent.
const ran = new Set(results.map(r => r.dimension))
const notRun = dispatched.filter(d => !ran.has(d))
if (notRun.length) log(`No result from: ${notRun.join(', ')} — flagged NOT RUN in the report.`)

const stripped = results.map(stripInternal)

phase('Synthesize')
const report = await agent(
  `You are consolidating a Rust audit. Below are JSON results from independent review agents. Dimensions come in families: \`review:<crate>\` (one per crate reviewed), \`contract:<from>→<to>\` (one per inter-crate dependency edge), \`crate-decomposition\` (extract/merge recommendations), \`architecture\`, \`security\`, \`miri\`, and the tool dimensions \`semver\`/\`build-matrix\`/\`deps\`/\`unused-crates\` (verified orphan workspace members + unused dependencies)/\`tests-cov\`. Produce ONE markdown report — do not invent findings, only merge what is given:

1. An **overall verdict** line — the worst case across all dimensions. If any dimension did not run, mark the audit INCOMPLETE.
2. A **dimension → verdict** table with one row per dimension present (list each \`review:<crate>\` and \`contract:<from>→<to>\` separately). Add a row for every dimension under NOT RUN below with verdict \`NOT RUN\` — its agent failed, so do not treat its absence as a pass.
3. **Findings by severity** (Critical first), each tagged with its dimension and location, plus a one-line fix direction.
4. A short **"Fix first"** list — the few highest-leverage items across all dimensions.
5. A **"Crate boundaries"** note: summarise the \`crate-decomposition\` extract/merge recommendations (driver + boundary), if any.
6. If a \`review:*\` dimension's summary names a **gate provenance** (CI vs local), surface it in one line under the verdict.

NOT RUN (no result — agent failed or was skipped): ${notRun.length ? notRun.join(', ') : 'none'}

RESULTS:
${JSON.stringify(stripped, null, 2)}`,
  // Synthesis is merge/dedup/rank of given verdicts — moderate reasoning, not a deep judgement call.
  { label: 'synthesis', effort: 'medium' },
)

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
  dimensions: stripped.map(r => {
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
