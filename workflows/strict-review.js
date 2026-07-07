export const meta = {
  name: 'strict-review',
  description: 'Adversarial multi-phase diff review with bounded verifier fan-out — scout-scaled lenses, throttled batches with retries, strict-majority verification, verified coverage gaps. Subscription-friendly: steady request rate, no burst.',
  whenToUse: 'Deep adversarial review of any diff (language-agnostic) when running on a rate-limited subscription. For Rust diffs prefer the rust-review workflow; use this for mixed/other codebases or when the money-path lenses matter.',
  phases: [
    { title: 'Prep', detail: 'scout the diff (size, lens subset) + warm up the codebase-memory index', model: 'haiku' },
    { title: 'Review', detail: 'scout-picked finder lenses, throttled batches with retries; two-tier dedup (mechanical + thresholded semantic clusterer)' },
    { title: 'Verify', detail: '1 combined verifier per finding, 3-lens panel for critical/high; throttled + retries + budget guard' },
    { title: 'Coverage', detail: 'completeness critic; its gaps are verified through the same pipeline' },
  ],
}

// ---- args ----
const diffBase = (args && typeof args === 'object' && args.diffBase) ? String(args.diffBase) : ''
const intentArg = (args && typeof args === 'object' && args.intent) ? String(args.intent) : ''
const viaArg = (args && typeof args === 'object' && args._via) ? String(args._via) : ''   // set by a parent workflow
const BATCH = (args && typeof args === 'object' && args.batch) ? Math.max(1, Number(args.batch)) : 4
const RETRY_BATCH = 2                 // retry rounds run even quieter than the main pass
const MAX_RETRY_ROUNDS = (args && typeof args === 'object' && args.maxRetries != null) ? Math.max(0, Number(args.maxRetries)) : 2
const BUDGET_FLOOR = 40_000           // stop spawning agents below this many remaining tokens

// ---- schemas ----
const FINDINGS = {
  type: 'object',
  additionalProperties: false,
  required: ['findings'],
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['title', 'file', 'line', 'severity', 'description', 'fix'],
        properties: {
          title: { type: 'string' },
          file: { type: 'string' },
          line: { type: 'number' },
          severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low'] },
          description: { type: 'string' },
          fix: { type: 'string' },
        },
      },
    },
  },
}
const VERDICT = {
  type: 'object',
  additionalProperties: false,
  required: ['refuted', 'reasoning', 'severity'],
  properties: {
    refuted: { type: 'boolean' },
    reasoning: { type: 'string' },
    severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low', 'not-an-issue'] },
  },
}
const SCOUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['baseRef', 'sizeBucket', 'lenses', 'notes'],
  properties: {
    baseRef: { type: 'string', description: 'git ref the diff was computed against; empty if none resolved' },
    sizeBucket: { type: 'string', enum: ['small', 'medium', 'large'] },
    lenses: { type: 'array', items: { type: 'string' }, description: 'subset of the lens catalog to run' },
    notes: { type: 'string' },
  },
}
const WARMUP_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['indexed', 'notes'],
  properties: {
    indexed: { type: 'boolean', description: 'true if the codebase-memory index exists and covers the diff base' },
    notes: { type: 'string' },
  },
}

const SEV_RANK = { critical: 0, high: 1, medium: 2, low: 3 }
const isEscalated = f => f.lens !== 'complexity' && (f.severity === 'critical' || f.severity === 'high')

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
function indexProjection(r) {
  return {
    schemaVersion: r.schemaVersion, runtime: r.runtime ?? null, ts: r.ts, kind: r.kind, name: r.name,
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
    { label: 'log-run', phase: 'Coverage', model: 'haiku', effort: 'low' },
  )
}
// strict-review uses lowercase severities internally; the store schema is capitalized.
const capSeverity = f => ({ ...f, severity: f.severity ? f.severity[0].toUpperCase() + f.severity.slice(1) : f.severity })

// ---- lens catalog ----
const LENS_BRIEF = {
  correctness: 'logic and spec conformance: does the change do what it is supposed to? Wrong behavior behind correct-looking code, off-by-one, inverted conditions, missed requirements, broken invariants.',
  security: 'security: injection, authz/authn gaps, tenant isolation breaks, secrets in code, unsafe deserialization, path traversal, SSRF, untrusted input reaching sinks.',
  money: 'money-path invariants: float arithmetic on amounts, lost cents in splits/rounding, missing idempotency on payment operations, double-charge/double-credit windows, currency mixups, ledger imbalance.',
  concurrency: 'concurrency: races on shared state, check-then-act windows, missing transactions/locks, lock ordering, blocking calls in async contexts, unbounded queues.',
  errors: 'error handling: swallowed errors, panic/crash on recoverable failures, missing rollback/cleanup on the error path, error messages leaking internals.',
  performance: 'performance: N+1 queries, work inside hot loops, unbounded memory growth, missing pagination/limits, accidental O(n^2).',
  complexity: 'complexity metrics from the codebase-memory graph (metrics-or-nothing; skipped when the repo is not indexed).',
}
const ALL_LENSES = Object.keys(LENS_BRIEF)

function finderPrompt(lens) {
  const base = diffBase ? `\`${diffBase}\`` : 'resolve it yourself: merge-base with origin/main, then main, then HEAD~1; target uncommitted changes if the tree is dirty'
  if (lens === 'complexity') {
    return `You are the complexity review lens, grounded in the codebase-memory knowledge graph.
Use ToolSearch to load the codebase-memory MCP tools (list_projects, index_status, detect_changes, search_graph, query_graph).

Step 0 — availability gate: call list_projects / index_status for this repository. If the project is NOT indexed, or the index predates the diff base, return {"findings": []} immediately. Never estimate complexity by eye; this lens is metrics-or-nothing.
Step 1: detect_changes (diff base: ${base}) to get the functions touched by the diff and their impact radius.
Step 2: for each touched function, read its complexity properties from the graph: cognitive, complexity (cyclomatic), loop_depth, transitive_loop_depth, linear_scan_in_loop, alloc_in_loop, recursion_in_loop, unguarded_recursion, param_count. One query_graph call can fetch them all.
Step 3: report ONLY findings grounded in those numbers, quoting the metric values in the description. Calibrate severity by whether THIS diff introduced or worsened the metric, not by pre-existing debt:
- diff introduces/deepens transitive_loop_depth >= 3 on a caller-reachable path -> high
- diff adds linear_scan_in_loop (hidden O(n^2)) or alloc_in_loop on a hot path -> medium..high
- diff adds unguarded_recursion or recursion_in_loop -> high
- diff sharply raises cognitive complexity of a function -> medium
- pre-existing debt merely touched by the diff -> low, mention briefly
Each finding: exact file, line, metric values, and a concrete fix (extract, hoist the scan, use a map, cap recursion).

Return {findings: []-shaped JSON}.`
  }
  return `You are the **${lens}** review lens for a diff. Review ONLY this slice; ignore everything else (other lenses cover it).

SLICE: ${LENS_BRIEF[lens]}
Diff base: ${base}.
${intentArg ? `INTENT (what the change should do): ${intentArg}` : ''}
CONTEXT EXPANSION (required): for each finding, read the surrounding code and trace callers of the changed symbols before judging — do not read the diff in isolation.
CONFIDENCE: report everything you suspect, located to file:line. Do NOT self-censor borderline findings — adversarial verification happens downstream.

Return {findings: []-shaped JSON}.`
}

// ---- throttled runner: batches of `BATCH`, retry rounds of `RETRY_BATCH`, budget guard ----
// Returns the jobs that never produced a result. Each job: {prompt, label, schema, effort, onResult}.
async function runThrottled(jobs, tag, phaseTitle) {
  let pending = jobs
  let done = 0
  for (let round = 0; round <= MAX_RETRY_ROUNDS && pending.length; round++) {
    const size = round === 0 ? BATCH : RETRY_BATCH
    if (round > 0) log(`${tag} retry round ${round}: ${pending.length} failed calls, batches of ${size}`)
    const failed = []
    for (let i = 0; i < pending.length; i += size) {
      if (budget.total && budget.remaining() < BUDGET_FLOOR) {
        const skipped = pending.length - i + failed.length
        log(`Budget guard: ~${Math.round(budget.remaining() / 1000)}k tokens left -> stopping ${tag}, ${skipped} calls skipped`)
        return pending.slice(i).concat(failed)
      }
      const batch = pending.slice(i, i + size)
      const res = await parallel(batch.map(j => () =>
        agent(j.prompt, { label: (round ? `retry${round}:` : '') + j.label, phase: phaseTitle, schema: j.schema, effort: j.effort })))
      res.forEach((v, k) => {
        if (v) { batch[k].onResult(v); done++ } else failed.push(batch[k])
      })
      log(`${tag}: ${done}/${jobs.length} calls done`)
    }
    pending = failed
  }
  return pending
}

// ================= Prep: scout + index warm-up (2 agents, parallel) =================
phase('Prep')
const [scout, warmup] = await parallel([
  () => agent(
    `You are scouting a diff to plan an adversarial review. Use shell + read only — do NOT review yet.
1. Resolve the diff base. ${diffBase ? `Use \`${diffBase}\`.` : 'Try in order: `git merge-base HEAD origin/main`, `git merge-base HEAD main`, `HEAD~1`. If the tree has uncommitted changes, target those.'}
2. Inspect \`git diff --stat\`. sizeBucket: small = a few files / < ~80 changed lines; large = many files / > ~400 lines or auth/money/concurrency-heavy; medium otherwise.
3. lenses: choose from ${JSON.stringify(ALL_LENSES)}.
   - small: only the touched categories (minimum 2; always include 'correctness').
   - medium: the categories plausibly in play.
   - large: all of them.
   Decide "in play" from the diff: payments/amounts/ledger -> money; async/threads/locks/transactions -> concurrency; input parsing/auth/tenancy -> security; loops/queries -> performance; always consider 'correctness' and 'errors'. Include 'complexity' whenever the diff is medium/large (it self-skips if the repo is not indexed).`,
    { label: 'scout', schema: SCOUT_SCHEMA, model: 'haiku', effort: 'low' },
  ),
  () => agent(
    `You are warming up the codebase-memory index for a review. Use ToolSearch to load the codebase-memory MCP tools.
1. Check list_projects / index_status for this repository.
2. If the project is not indexed or the index is stale relative to the current HEAD, run index_repository with mode=fast on the repo root and wait for it.
3. Return indexed=true only if a usable index exists when you are done. If the MCP server is unavailable, return indexed=false — never error.`,
    { label: 'index-warmup', schema: WARMUP_SCHEMA, effort: 'low' },
  ),
])

const plan = {
  baseRef: scout?.baseRef ?? diffBase,
  sizeBucket: scout?.sizeBucket ?? 'medium',
  lenses: (scout?.lenses?.length ? scout.lenses.filter(l => ALL_LENSES.includes(l)) : ALL_LENSES),
}
if (!(warmup?.indexed)) {
  plan.lenses = plan.lenses.filter(l => l !== 'complexity')
  log(`codebase-memory index unavailable (${warmup?.notes ?? 'warm-up died'}) -> complexity lens dropped`)
}
log(`Scout: ${plan.sizeBucket} diff -> lenses: ${plan.lenses.join(', ')} · ${scout?.notes ?? 'scout died, running all lenses'}`)

// ================= Review: throttled finder lenses =================
phase('Review')
const lensResults = new Map()
const deadLensJobs = await runThrottled(
  plan.lenses.map(lens => ({
    prompt: finderPrompt(lens),
    label: `review:${lens}`,
    schema: FINDINGS,
    effort: 'medium',
    onResult: r => lensResults.set(lens, r),
  })),
  'Review', 'Review',
)
const deadLenses = deadLensJobs.map(j => j.label.replace(/^.*review:/, ''))
if (deadLenses.length) log(`WARNING: finder lens(es) returned nothing: ${deadLenses.join(', ')}`)

const all = plan.lenses.flatMap(lens => {
  const r = lensResults.get(lens)
  return r ? r.findings.map(x => ({ ...x, lens })) : []
})

// ---- dedup, tier 1 (mechanical): neighbor line-buckets + title-token similarity ----
// Merging requires BOTH nearby lines (|Δ| <= 5, buckets k-1..k+1 so bucket borders don't split)
// AND similar titles — proximity alone never merges, so two distinct issues in one window
// survive as two findings. Under-merge costs one cheap verify agent; over-merge silently
// loses a finding — stay conservative.
const normTokens = t => new Set(String(t || '').toLowerCase().replace(/[^a-z0-9а-яё]+/gi, ' ').split(' ').filter(w => w.length > 2))
function titleSimilar(a, b) {
  const A = normTokens(a), B = normTokens(b)
  if (!A.size || !B.size) return false
  let inter = 0
  for (const w of A) if (B.has(w)) inter++
  return inter / (A.size + B.size - inter) > 0.5
}
const buckets = new Map()   // `${file}:${bucket}` -> entries in that bucket
const merged = []
for (const f of all) {
  const b = Math.floor(f.line / 10)
  let hit = null
  for (const nb of [b - 1, b, b + 1]) {
    for (const e of (buckets.get(`${f.file}:${nb}`) || [])) {
      if (Math.abs(e.line - f.line) <= 5 && titleSimilar(e.title, f.title)) { hit = e; break }
    }
    if (hit) break
  }
  if (hit) {
    if (!hit.sources.includes(f.lens)) hit.sources.push(f.lens)
    if (SEV_RANK[f.severity] < SEV_RANK[hit.severity]) {
      Object.assign(hit, { title: f.title, line: f.line, severity: f.severity, description: f.description, fix: f.fix, lens: f.lens })
    }
    continue
  }
  const entry = { ...f, sources: [f.lens] }
  merged.push(entry)
  const key = `${f.file}:${b}`
  if (!buckets.has(key)) buckets.set(key, [])
  buckets.get(key).push(entry)
}
let kept = merged.sort((a, b) => SEV_RANK[a.severity] - SEV_RANK[b.severity])
log(`Review: ${all.length} raw findings -> ${kept.length} after mechanical dedup`)

// ---- dedup, tier 2 (semantic, thresholded): one haiku clusterer for cross-vocabulary duplicates ----
// Catches what token overlap can't: different lenses describing one defect in different words
// ("TOCTOU at debit" vs "race on balance update"). Runs only on large pools where duplicates
// are likely; merges keep BOTH formulations so an over-eager merge degrades to a verbose
// description instead of a lost finding.
const DEDUP_THRESHOLD = 15
if (kept.length > DEDUP_THRESHOLD && (!budget.total || budget.remaining() > BUDGET_FLOOR)) {
  const CLUSTERS_SCHEMA = {
    type: 'object',
    additionalProperties: false,
    required: ['clusters'],
    properties: {
      clusters: {
        type: 'array',
        items: { type: 'array', items: { type: 'number' }, description: 'indices of findings that are the SAME defect' },
        description: 'only groups of 2+; singletons are omitted; empty if no duplicates',
      },
    },
  }
  const clusterer = await agent(
    `You are deduplicating review findings. Below is a numbered list. Return clusters of indices that describe THE SAME underlying defect — same root cause, one fix would resolve all of them — even when phrased in different vocabulary or cited at nearby-but-different lines (e.g. a check-site vs a write-site of one race).
Merge ONLY when confident the fix is literally the same change. Two different problems in the same function are NOT a cluster. When in doubt, do not merge. Return {"clusters": []} if there are no duplicates.

FINDINGS:
${kept.map((f, i) => `${i}. [${f.severity}] ${f.title} @ ${f.file}:${f.line} (lenses: ${f.sources.join(',')}) — ${f.description}`).join('\n')}`,
    { label: 'dedup-semantic', phase: 'Review', schema: CLUSTERS_SCHEMA, model: 'haiku', effort: 'low' },
  )
  const drop = new Set()
  for (const cluster of (clusterer?.clusters ?? [])) {
    const idxs = [...new Set(cluster)]
      .filter(i => Number.isInteger(i) && i >= 0 && i < kept.length && !drop.has(i))
      .sort((x, y) => SEV_RANK[kept[x].severity] - SEV_RANK[kept[y].severity])
    if (idxs.length < 2) continue
    const head = kept[idxs[0]]
    for (const i of idxs.slice(1)) {
      const dup = kept[i]
      for (const s of dup.sources) if (!head.sources.includes(s)) head.sources.push(s)
      head.description += `\n[merged duplicate] ${dup.title} @ ${dup.file}:${dup.line}: ${dup.description}`
      drop.add(i)
    }
  }
  if (drop.size) {
    kept = kept.filter((f, i) => !drop.has(i))
    log(`Semantic dedup: merged ${drop.size} duplicate(s) -> ${kept.length} findings`)
  } else {
    log('Semantic dedup: no cross-vocabulary duplicates found')
  }
}

// ================= Verify =================
phase('Verify')
const COMBINED_INSTR = `You are an adversarial verifier. Try to REFUTE this finding. Check ALL THREE dimensions in one pass:
1. code — is the claim factually true in the code as written? Read the actual code; do not trust the description.
2. exploit — construct a concrete end-to-end scenario that triggers the issue. If you cannot, that counts against the finding.
3. severity — calibrate real impact for the multi-tenant money-path, and confirm the issue is in scope for THIS diff.
Return refuted=true if ANY dimension fails. Default to refuted=true when uncertain. Return the calibrated severity.`
const COMBINED_METRIC_INSTR = `You are an adversarial verifier for a METRIC-BACKED complexity finding.
Use ToolSearch to load the codebase-memory MCP tools. Check ALL THREE dimensions:
1. metric — re-read the metric values yourself via query_graph; refute if they don't match the claim or the index is unavailable.
2. attribution — confirm THIS diff introduced or worsened the metric (compare against detect_changes); pre-existing debt misattributed to the diff -> refute or downgrade.
3. severity — calibrate real impact: is the function on a hot / caller-reachable path (trace_path), or dead-end cold code?
Return refuted=true if ANY dimension fails; default to refuted=true when uncertain.`
const PANEL_LENSES = [
  ['code', 'Verify ONLY the factual claim against the code as written. Read the code yourself; refute if the description misstates it.'],
  ['exploit', 'Try to construct a concrete end-to-end exploit/trigger scenario. Refute if no realistic path exists.'],
  ['severity', 'Calibrate real-world severity for the multi-tenant money-path and check the issue is in scope for this diff. Refute if severity is inflated or out of scope.'],
]

// Builds verify jobs for a set of findings, writing votes into `sink[idx]`.
// Single combined verifier (effort low) for medium/low; 3-lens panel (effort high)
// for critical/high; metric-aware single verifier for complexity findings.
function buildVerifyJobs(findings, sink) {
  const jobs = []
  findings.forEach((f, idx) => {
    const ctx = `FINDING [${f.severity}] ${f.title} @ ${f.file}:${f.line}\n` +
      `Independently reported by lenses: ${(f.sources || [f.lens]).join(', ')}\n${f.description}\nProposed fix: ${f.fix}`
    const push = (lens, instr, effort, tagged) => jobs.push({
      prompt: `${instr}\n\n${ctx}`,
      label: `verify${tagged ? `[${lens}]` : ''}:${f.file}:${f.line}`,
      schema: VERDICT,
      effort,
      onResult: v => sink[idx].push({ lens, ...v }),
    })
    if (f.lens === 'complexity') push('metric', COMBINED_METRIC_INSTR, 'low', true)
    else if (isEscalated(f)) for (const [lens, instr] of PANEL_LENSES) push(lens, instr, 'high', true)
    else push('combined', COMBINED_INSTR, 'low', false)
  })
  return jobs
}

// Strict majority of received votes must NOT refute. One formula covers the single
// verifier (1 vote: confirmed = !refuted), the full panel (refutes <= 1 of 3), and a
// degraded panel (a tie or a lone surviving refuter never confirms).
function judge(findings, sink) {
  const calibrate = (f, votes) => {
    const sevs = votes.filter(v => !v.refuted && v.severity !== 'not-an-issue')
      .map(v => v.severity).sort((a, b) => SEV_RANK[a] - SEV_RANK[b])
    return sevs.length ? sevs[Math.floor(sevs.length / 2)] : f.severity
  }
  const judged = findings.map((f, idx) => {
    const votes = sink[idx]
    const refutes = votes.filter(v => v.refuted).length
    const confirmed = votes.length > 0 && refutes * 2 < votes.length
    return { ...f, confirmed, votes, severity: confirmed ? calibrate(f, votes) : f.severity }
  })
  return {
    confirmed: judged.filter(v => v.confirmed),
    refuted: judged.filter(v => !v.confirmed && v.votes.length > 0),
    suspected: judged.filter(v => v.votes.length === 0),
  }
}

const votes = kept.map(() => [])
const verifyJobs = buildVerifyJobs(kept, votes)
log(`Verify plan: ${kept.length} findings -> ${verifyJobs.length} checks (${kept.filter(isEscalated).length} escalated to 3-lens panel), throttled to ${BATCH} concurrent`)
const unverifiedJobs = await runThrottled(verifyJobs, 'Verify', 'Verify')
if (unverifiedJobs.length) log(`WARNING: ${unverifiedJobs.length} checks got no verdict after retries`)

let { confirmed, refuted, suspected } = judge(kept, votes)
log(`Verify done: ${confirmed.length} confirmed, ${refuted.length} refuted, ${suspected.length} suspected (no verdict)`)

// ================= Coverage: critic, then verify its gaps through the same pipeline =================
phase('Coverage')
const CRITIC_PROMPT = `You are a completeness critic for an adversarial diff review (diff base: ${plan.baseRef || 'HEAD'}).
Ask: what is MISSING — a changed file no finding touched, a category of bug not checked, a dimension left uncovered?
Report each gap as a concrete located finding (file:line of the suspicious spot, severity, description, fix).
CONFIRMED findings (do not repeat them): ${JSON.stringify(confirmed.map(f => `${f.title} @ ${f.file}:${f.line}`))}
REFUTED claims (do NOT re-report these — they were adversarially disproven): ${JSON.stringify(refuted.map(f => `${f.title} @ ${f.file}:${f.line}`))}
Dead lenses this run (their dimension is UNCOVERED — look there first): ${JSON.stringify(deadLenses)}
If coverage is complete, return {"findings": []}.`
let critic = await agent(CRITIC_PROMPT, { label: 'coverage-critic', phase: 'Coverage', schema: FINDINGS, effort: 'high' })
if (!critic) {
  log('Coverage critic failed, retrying once')
  critic = await agent(CRITIC_PROMPT, { label: 'coverage-critic-retry', phase: 'Coverage', schema: FINDINGS, effort: 'high' })
}

// Critic findings do not bypass verification — they ride the same throttled pipeline.
const gaps = (critic?.findings ?? []).map(f => ({ ...f, lens: 'coverage', sources: ['coverage'] }))
let refutedGaps = 0
if (gaps.length && (!budget.total || budget.remaining() > BUDGET_FLOOR)) {
  log(`Coverage critic raised ${gaps.length} gap(s) -> verifying through the same pipeline`)
  const gapVotes = gaps.map(() => [])
  await runThrottled(buildVerifyJobs(gaps, gapVotes), 'Coverage-verify', 'Coverage')
  const g = judge(gaps, gapVotes)
  confirmed = confirmed.concat(g.confirmed)
  suspected = suspected.concat(g.suspected)
  refutedGaps = g.refuted.length
  log(`Coverage gaps: +${g.confirmed.length} confirmed · +${g.suspected.length} suspected · ${g.refuted.length} refuted`)
} else if (gaps.length) {
  log(`Budget too low to verify ${gaps.length} coverage gap(s) -> reported as suspected`)
  suspected = suspected.concat(gaps.map(f => ({ ...f, confirmed: false, votes: [] })))
}

const verdict = confirmed.some(f => f.severity === 'critical' || f.severity === 'high') ? 'Block'
  : confirmed.some(f => f.severity === 'medium') ? 'Warning' : 'Approve'
log(`Verdict: ${verdict} — ${confirmed.length} confirmed, ${suspected.length} suspected`)

// ---- run record ----
const candidates = kept.length + gaps.length
const refutedTotal = refuted.length + refutedGaps
await logRun({
  schemaVersion: 1,
  runtime: 'claude-code',
  kind: 'workflow',
  name: 'strict-review',
  nested: !!viaArg,
  via: viaArg || null,
  verdict,
  findings: summarizeFindings(confirmed.concat(suspected).map(capSeverity)),
  scout: { size: plan.sizeBucket, lenses: plan.lenses, indexed: !!(warmup?.indexed), batch: BATCH },
  dimensions: plan.lenses.map(l => {
    const s = summarizeFindings(confirmed.filter(f => (f.sources || []).includes(l)).map(capSeverity))
    return { dimension: l, verdict: '', findingCount: s.total, bySeverity: s.bySeverity }
  }),
  verification: { candidates, confirmed: confirmed.length, refuteRate: candidates ? Math.round((refutedTotal / candidates) * 100) / 100 : 0 },
  notRun: deadLenses,
  outputTokens: budget.spent(),
})

return {
  verdict,
  confirmed: confirmed.map(({ votes: v, ...f }) => ({ ...f, votes: v.length, refutes: v.filter(x => x.refuted).length })),
  suspected: suspected.map(({ votes: v, ...f }) => f),
  scout: { size: plan.sizeBucket, lenses: plan.lenses, deadLenses },
}
