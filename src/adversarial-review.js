import { normalizeArgs } from '../lib/workflow-args.mjs'
import { parsePriorDecisions, priorDecisionsRefusedSection } from '../lib/prior-decisions.mjs'
import { MEMORY_RECALL_SCHEMA, memoryRecord, skippedMemory, withPassed, withDerived, mergeRecall, readLaunch, recallDecisions } from '../lib/memory-recall.mjs'
import { summarizeFindings, refuteRate, repoRefusal } from '../lib/run-record.mjs'
import { quietly, checkpointPrompt, makeRunLogger, telemetryLossNoter } from '../lib/run-logging.mjs'
import { makeThrottledRunner } from '../lib/throttled-runner.mjs'
import { DEPENDENCY_SOURCE_HOW } from '../lib/dependency-source.mjs'
import { noChangedFilesMessage, materialUncovered, nothingToReviewMessage } from '../lib/review-coverage.mjs'
import { makeLimitStop, stopAtLimit } from '../lib/usage-limit.mjs'
import { limitStopAdvice } from '../lib/limit-report.mjs'
import { honestVerdict } from '../lib/honest-verdict.mjs'
import { judgeVotes } from '../lib/adversarial-judge.mjs'
import { MATCH_JUDGE_SCHEMA } from '../lib/prior-decision-match.mjs'
import { SCOPE_CHECK_SCHEMA, scopeCheckPrompt } from '../lib/prior-decision-scope.mjs'
import { contradictionRecord, contradictionSection } from '../lib/memory-contradiction.mjs'
import { applyPriorDecisions } from '../lib/prior-decision-apply.mjs'
import { RULE_JUDGE_SCHEMA } from '../lib/project-rule-judge.mjs'
import { applyProjectRules } from '../lib/project-rule-apply.mjs'

export const meta = {
  name: 'adversarial-review',
  description: 'Adversarial multi-phase diff review with bounded verifier fan-out — scout-scaled lenses, throttled batches with retries, strict-majority verification, verified coverage gaps. A run whose scout, lenses or coverage critic died reports its verdict as INCOMPLETE with a not-run list, never as a clean approval; unjudged individual checks are recorded as advisory instead. Subscription-friendly: steady request rate, no burst.',
  whenToUse: 'Deep adversarial, language-agnostic review of any diff — mixed / non-Rust-Nix codebases, or when money-path (payments/ledger) invariants matter, or on a rate-limited subscription (steady request rate). For a Rust or Nix diff prefer the `review` workflow (auto-detects language). Distinct from `review --strict`, which is the harsh maintainability-block mode of the generic engine. It reviews ONLY the checkout the session runs in: there is no `repo` argument, and passing one is refused with nothing run (use `review` with repo= instead). priorDecisions — ONLY inside an object argument, {priorDecisions: [<recalled decision, question and rule records>]}; as a string (key=value or JSON text) it is refused, nothing of it applied — applies the same rules as review: a matching finding below critical/high whose scope is unchanged since the commit of the decision is returned under rejectedBefore, marked, outside the verdict; one an active question (a deferred finding) answers comes back under knownDeferred by the same rules; one a judge puts under an active project rule (a stance on a whole class of findings), unless critical, comes back under coveredByRule, outside the verdict, and what the rules could not decide (a critical raised, no judge verdict) under ruleNotices; refusals come back as priorDecisionsNotApplied. The engine itself always recalls the active decisions, questions and project rules for the paths of the diff through the craft:memory skill; priorDecisions is optional and ADDS to that recall, never replaces it (merged by id, the recalled record kept on a clash; an empty list adds nothing; a passed record may leave out id when it carries kind, title and scope, the id then derived from them by the memory skill rule), and the source comes back as memory {source, count, why, passed?, added?}. It posts nothing to a PR: to post findings there run review with comment — never post findings by hand (they would lack the marker that ties a later rejection to its finding).',
  phases: [
    { title: 'Prep', detail: 'scout the diff (size, lens subset) + warm up the codebase-memory index', model: 'haiku' },
    { title: 'Review', detail: 'scout-picked finder lenses, throttled batches with retries; two-tier dedup (mechanical + thresholded semantic clusterer)' },
    { title: 'Verify', detail: '1 combined verifier per finding, 3-lens panel for critical/high; throttled + retries + budget guard' },
    { title: 'Coverage', detail: 'completeness critic; its gaps are verified through the same pipeline' },
  ],
}

export async function __run() {
// ---- args ----
// ---- args ----
// Three plausible spellings arrive here — a real object, a JSON string, and the `key=value` form the
// skill's own invocation line advertises — and only the first used to work. The other two fell
// through every `typeof args === 'object'` guard, so every option reverted to its default and the
// run reviewed whatever the session was sitting in, then reported a confident verdict for a diff
// nobody asked about. Shared with every other engine (lib/workflow-args.mjs).
const A = normalizeArgs(args, log)
// The project's recalled prior decisions, read before anything can return, so a malformed argument
// is named on every return path (the rules: lib/prior-decisions.mjs).
// Set by a parent workflow that already recalled for this run: no recall here; `_memory` is why it found
// none, `_memoryParts` how its list splits into its recall's records and its launcher's.
const recalledByLauncher = A['_recalled'] === true
const launch = readLaunch(A['priorDecisions'], recalledByLauncher, A['_memory'], A['_memoryParts'], parsePriorDecisions)
let priorDecisionsIn = launch.prior
for (const r of priorDecisionsIn.refused) log(`WARNING: priorDecisions: ${r}`)
// Where the decisions came from (recalled by this engine, by its launcher, or none) and what the launcher
// passed beside them; every returned object names it.
let memory = launch.memory
/** What a returned object adds: the memory source, and what of priorDecisions was not applied. */
const priorRefusedResult = () => ({
  memory,
  ...(priorDecisionsIn.refused.length ? { priorDecisionsNotApplied: priorDecisionsIn.refused } : {}),
})
/** @param {string} key @returns {string} the argument as a string, '' when absent or falsy */
const stringArg = key => A[key] ? String(A[key]) : ''

const diffBase = stringArg('diffBase')
const intentArg = stringArg('intent')
const viaArg = stringArg('_via')   // set by a parent workflow
// Where craft itself lives, so the logger can find lib/craft-log-run.mjs. It selects NO repository:
// this engine has no `repo` argument (see the refusal above) and always reviews the checkout the
// session runs in. As an installed plugin CLAUDE_PLUGIN_ROOT is
// set for us; launched by scriptPath from a checkout it is NOT, and the fallback would resolve
// against the reviewed repo — where the script is not. Pass craftRoot then.
const craftRootArg = stringArg('craftRoot')
/** @returns {number} */
const batchArg = () => A['batch'] ? Math.max(1, Number(A['batch'])) : 4
const BATCH = batchArg()
const RETRY_BATCH = 2                 // retry rounds run even quieter than the main pass
/** @returns {number} */
const maxRetriesArg = () => A['maxRetries'] != null ? Math.max(0, Number(A['maxRetries'])) : 2
const MAX_RETRY_ROUNDS = maxRetriesArg()
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
        required: ['title', 'file', 'line', 'severity', 'description', 'fix', 'whereChecked'],
        properties: {
          title: { type: 'string' },
          file: { type: 'string' },
          line: { type: 'number' },
          severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low'] },
          description: { type: 'string' },
          fix: { type: 'string' },
          whereChecked: { type: 'string', description: 'OFF-SITE EVIDENCE: the file:line you actually opened to establish a load-bearing premise living OUTSIDE the cited line — a dependency\'s behaviour, reachability from an entry point, the absence of a guard in a caller, what a sibling path does. Comma-separate several. Empty string ONLY when the finding rests on no off-site claim at all' },
        },
      },
    },
  },
}
const VERDICT = {
  type: 'object',
  additionalProperties: false,
  required: ['refuted', 'reasoning', 'severity', 'premiseSupported'],
  properties: {
    refuted: { type: 'boolean' },
    premiseSupported: { type: 'boolean', description: 'true if the load-bearing premise is self-contained at the cited line or actually shown by the code at whereChecked; false if it is an off-site claim with no evidence that checks out. Unsupported is NOT the same as refuted — set refuted on its own merits' },
    reasoning: { type: 'string' },
    severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low', 'not-an-issue'] },
  },
}
const SCOUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['head', 'baseRef', 'sizeBucket', 'lenses', 'changedFiles', 'notes'],
  properties: {
    head: { type: 'string', description: '`git rev-parse --short HEAD`, run FIRST, before anything reads the diff; empty if not a git repo' },
    baseRef: { type: 'string', description: 'git ref the diff was computed against; empty if none resolved' },
    sizeBucket: { type: 'string', enum: ['small', 'medium', 'large'] },
    lenses: { type: 'array', items: { type: 'string' }, description: 'subset of the lens catalog to run' },
    changedFiles: { type: 'array', items: { type: 'string' }, description: 'EVERY path the diff touches, verbatim from `git diff --name-only` against the resolved base — repo-relative, no truncation, no globbing. An empty array means the diff genuinely resolved to no files; it is read as "nothing was reviewed", so never return [] as a shortcut' },
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

// Deterministic re-read of the diff's file list, used only to gate the inert-only green exit.
// `fileCount` comes from `wc -l`, `files` from the same command's output: the two disagreeing is
// how the cross-check's OWN truncation is caught, so both are required.
const CROSSCHECK_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['ok', 'fileCount', 'files'],
  properties: {
    ok: { type: 'boolean', description: 'true only if git ran and files holds every path it printed, complete and verbatim' },
    fileCount: { type: 'integer', description: 'the number printed by `git diff --name-only <base> | wc -l`' },
    files: { type: 'array', items: { type: 'string' }, description: 'every path from `git diff --name-only <base>`, verbatim, untruncated' },
  },
}

// What each schema'd agent hands back when it returns at all. `agent()` resolves to `null` when the
// agent was skipped or died, so every read below goes through `Typedef | null`. The shapes are the
// schemas' — model output, so the guards that re-check a field at runtime stay where they are.
/**
 * @typedef {{ title: string, file: string, line: number, severity: string, description: string, fix: string, whereChecked: string }} RawFinding
 * @typedef {{ findings: RawFinding[] }} FindingsResult
 * @typedef {{ refuted: boolean, premiseSupported: boolean, reasoning: string, severity: string }} VerdictResult
 * @typedef {{ head: string, baseRef: string, sizeBucket: 'small' | 'medium' | 'large', lenses: string[], changedFiles: string[], notes: string }} ScoutResult
 * @typedef {{ indexed: boolean, notes: string }} WarmupResult
 * @typedef {{ ok: boolean, fileCount: number, files: string[] }} CrosscheckResult
 * @typedef {{ clusters: number[][] }} ClustersResult
 * @typedef {RawFinding & { lens: string, sources: string[] }} LensFinding  a finding tagged with the lens(es) that raised it
 */

/** @param {unknown} f @returns {f is string} a non-blank path from a model-returned file list */
const isPath = f => typeof f === 'string' && f.trim() !== ''

const SEV_RANK = { critical: 0, high: 1, medium: 2, low: 3 }
const isEscalated = (/** @type {{ lens?: string, severity: string }} */ f) => f.lens !== 'complexity' && (f.severity === 'critical' || f.severity === 'high')

// The craft release that produced a run. Recorded on the run record and index line so an
// aggregate can be filtered to ONE engine version: without it, runs from every rubric the store
// has ever seen blend together. MUST match `.claude-plugin/plugin.json` — `lib/check-workflows.mjs`
// fails the build if it drifts. The build lifts this line verbatim into the engine's banner.
const CRAFT_VERSION = '0.35.0' // x-release-please-version

// ---- the one write path (shared with every other record-filing engine): lib/run-logging.mjs ----

// A lost record NEVER fails the run: killing a review over a bookkeeping write would teach everyone
// to ignore the very marker this exists to raise. It is reported instead — in the notRun notes a
// human actually reads, because an empty store is otherwise indistinguishable from "never run".
/** @type {string[]} */
const telemetryLost = []
// "lost" is asserted per line, not stamped on every line: the record landing while its run DIRECTORY
// was refused is a different fact, and calling it a lost record is the same conflation the other
// three engines dropped — the one that teaches a reader to skip the marker. A line that says the
// record itself landed keeps its own wording.
const telemetryNotes = () => telemetryLost.map(l => (
  /^the run directory \(the record itself landed\)/.test(l)
    ? `⚠️ telemetry: ${l} — the record for this run is in the store; what the directory held may not be.`
    : `⚠️ telemetry lost: ${l} — this run may be missing or incomplete in the run store. Read this verdict, not the store, for what it did.`))

// ---- the start checkpoint: the head the run read, observed by code ----
// ONE phase slice, written after the scout and before any lens or the memory recall reads the diff. The logger
// stamps the slice's `head` and tracked dirtiness from git; `startHead` is the head the scout saw first. The
// record is filed with `finalize`, which folds this slice and files `reviewedHead`/`reviewedDirty` only when the
// two name one commit (lib/craft-log-run.mjs, reviewedTree) — the rule craft:review's checkpoints go through, so a
// push verdict is keyed to the commit this run read, never to one committed while it ran (realm @nick/craft, node #299).
const CHECKPOINT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['runDir'],
  properties: {
    runDir: { type: 'string', description: 'the runDir the script printed; empty string if it failed' },
    error: { type: 'string', description: 'when runDir is empty, the failing line verbatim; empty otherwise' },
  },
}
let runDir = ''
/** @param {string} phaseTitle @param {Record<string, unknown>} payloadIn @param {ScoutResult | null} scoutIn  its `head` is the start head */
async function startCheckpoint(phaseTitle, payloadIn, scoutIn) {
  const payload = { kind: 'workflow', name: 'adversarial-review', craftVersion: CRAFT_VERSION, ...payloadIn, phase: phaseTitle, startHead: scoutIn?.head ?? '' }
  const res = /** @type {{ runDir?: string, error?: string, __threw?: string } | null} */ (await quietly(agent)(
    checkpointPrompt({ payload, craftRoot: craftRootArg, phase: phaseTitle }),
    { label: `checkpoint:${phaseTitle}`, phase: 'Prep', schema: CHECKPOINT_SCHEMA, model: 'haiku', effort: 'low' },
  ))
  if (res?.runDir) {
    runDir = res.runDir
    return
  }
  telemetryLossNoter(telemetryLost, log)(`phase checkpoint '${phaseTitle}'`, res?.__threw || res?.error || 'the logger agent returned no runDir', false)
}

// The shared run-record writer (lib/run-logging.mjs), bound to this engine's phase and loss note. `finalize`, not
// `write`: it folds the start checkpoint, when one landed, into the record (see startCheckpoint above).
const logRun = makeRunLogger({
  call: quietly(agent), phase: 'Coverage', target: () => ({ craftRoot: craftRootArg, command: 'finalize', dir: runDir }),
  noteLoss: telemetryLossNoter(telemetryLost, log),
})
// adversarial-review uses lowercase severities internally; the store schema is capitalized.
/** @template {{ severity: string }} F @param {F} f */
const capSeverity = f => ({ ...f, severity: f.severity ? f.severity.charAt(0).toUpperCase() + f.severity.slice(1) : f.severity })

// The fields every run record of this engine opens with, in the order the store has always seen them.
const recordHead = () => ({
  schemaVersion: 1, runtime: 'claude-code', craftVersion: CRAFT_VERSION, kind: 'workflow', name: 'adversarial-review',
  nested: !!viaArg, via: viaArg || null,
  // What the recall step brought, or why none (realm @nick/craft, node #40).
  memory: memoryRecord(memory),
})

// ---- lens catalog ----
/** @type {Record<string, string>} */
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

/** @param {string} lens */
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
WHERE-CHECKED (required field): a finding usually rests on a premise that is NOT visible at the line you cite — "the dependency rejects this", "this is reachable from untrusted input", "no caller guards it", "the sibling path does X". Pin every such premise to a \`file:line\` you ACTUALLY OPENED, dependency sources included, and put them in \`whereChecked\`. An off-site premise you did not open is not admissible: open it, or drop the claim and report only what the cited line shows. Use "" only when the finding needs no off-site premise. ${DEPENDENCY_SOURCE_HOW}
CONFIDENCE: report everything you suspect, located to file:line. Do NOT self-censor borderline findings — adversarial verification happens downstream.

Return {findings: []-shaped JSON}.`
}

// ---- throttled runner (lib/throttled-runner.mjs) ----
// The runner reports its own leftovers into `notRun`; callers that report them their own way (the
// finder lenses, which mark one BLOCKING entry per dead dimension) pass `reportUnjudged: false`.

// How to find a pinned dependency's source, shared with the other prompts that demand opening it.

// ---- coverage honesty (lib/review-coverage.mjs) ----
// Only the LANGUAGE-AGNOSTIC half is used here. This engine declares no language profiles, so
// every material file is in scope for its lenses and there is no "matched no profile" gap to
// report; what it does share with review.js is the pair of guards that stop a run which looked at
// nothing from returning a bare Approve.

// ================= Prep: scout + index warm-up (2 agents, parallel) =================
// `repo` is NOT supported by this engine: every agent it dispatches runs git/cargo wherever the
// session sits. Accepting it silently is the failure this family exists to end — the caller names
// another repository, the engine reads its own, and the verdict looks entirely normal for the wrong
// code (measured 2026-09-17 on `review`, before `repo` reached that engine's argument list: 57
// agents, 2.04M tokens, nothing reviewed). Refuse before anything runs, and name what does work.
// The comment above used to promise this argument while nothing read it (realm @nick/craft, #65).
// MOVED here from the argument block, and the move IS the fix. Refused up there it returned before
// `logRun` and its dependencies existed, so a repeatedly mis-dispatched engine filed no record at
// all — and `notRun` fragility ranking, which is the one place a repeated wrong dispatch would show
// up, never saw it. This is still before the first phase, so nothing has run when it refuses.
if (A['repo']) {
  const refused = repoRefusal({ engine: 'adversarial-review', repo: String(A['repo']), craftVersion: CRAFT_VERSION, outputTokens: budget.spent(), via: viaArg })
  await logRun(refused.record)
  return refused.report + priorDecisionsRefusedSection(priorDecisionsIn.refused)
}

/** @returns {string} the scout's instruction for resolving the diff base */
const scoutBaseStep = () => diffBase ? `Use \`${diffBase}\`.` : 'Try in order: `git merge-base HEAD origin/main`, `git merge-base HEAD main`, `HEAD~1`. If the tree has uncommitted changes, target those.'

phase('Prep')
const [scoutRaw, warmupRaw] = await parallel([
  () => agent(
    `You are scouting a diff to plan an adversarial review. Use shell + read only — do NOT review yet.
0. FIRST, before anything else: \`head\` = \`git rev-parse --short HEAD\` (empty string if not a git repo). It tells the logger which commit the run started on, so an empty \`head\` files no verdict for that commit.
1. Resolve the diff base. ${scoutBaseStep()}
2. Inspect \`git diff --stat\` and list every touched path with \`git diff --name-only\` (same base) into changedFiles — complete and verbatim. sizeBucket: small = a few files / < ~80 changed lines; large = many files / > ~400 lines or auth/money/concurrency-heavy; medium otherwise.
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
const scout = /** @type {ScoutResult | null} */ (scoutRaw)
const warmup = /** @type {WarmupResult | null} */ (warmupRaw)

/** @param {ScoutResult | null} scoutIn @returns {string[]} the scout's lenses that are in the catalog, or every lens */
const scoutLenses = scoutIn => (scoutIn?.lenses?.length ? scoutIn.lenses.filter((/** @type {string} */ l) => ALL_LENSES.includes(l)) : ALL_LENSES)
/**
 * The complexity lens is metrics-or-nothing: without a usable index it is dropped from the plan.
 * @param {{ lenses: string[] }} planIn @param {WarmupResult | null} warmupIn
 */
function dropComplexityUnlessIndexed(planIn, warmupIn) {
  if (!(warmupIn?.indexed)) {
    planIn.lenses = planIn.lenses.filter((/** @type {string} */ l) => l !== 'complexity')
    log(`codebase-memory index unavailable (${warmupIn?.notes ?? 'warm-up died'}) -> complexity lens dropped`)
  }
}
/** @param {ScoutResult | null} scoutIn @param {WarmupResult | null} warmupIn */
function planReview(scoutIn, warmupIn) {
  const planned = {
    baseRef: scoutIn?.baseRef ?? diffBase,
    sizeBucket: scoutIn?.sizeBucket ?? 'medium',
    lenses: scoutLenses(scoutIn),
  }
  dropComplexityUnlessIndexed(planned, warmupIn)
  log(`Scout: ${planned.sizeBucket} diff -> lenses: ${planned.lenses.join(', ')} · ${scoutIn?.notes ?? 'scout died, running all lenses'}`)
  return planned
}
const plan = planReview(scout, warmup)
/** @param {string[]} lenses @returns {{ size: string, lenses: string[], indexed: boolean, batch: number }} the record's `scout` field */
const scoutRecord = lenses => ({ size: plan.sizeBucket, lenses, indexed: !!(warmup?.indexed), batch: BATCH })

// ---- coverage guard: a run that looked at nothing must not report a green Approve ----
// The scout enumerates the diff; three outcomes have to be told apart, and only the third is a
// review. A dead scout is NOT an empty diff — it is an unknown one, so it opens `notRun` and the
// review proceeds over all lenses rather than short-circuiting to a verdict about nothing.
// A scout that came back WITHOUT a `changedFiles` array is the dead-scout case, not the empty-diff
// one: the list is unknown, not empty. Folding it into `!scout` also keeps the `: null` below from
// reaching `!changedFiles.length`, which threw a TypeError and aborted the run before any lens ran
// and before any run record was filed — the most permissive failure there is, an invisible one.
//
// Two things are recorded per entry, and they are not the same thing.
//   `label` goes in the RUN RECORD. `lib/analyze-runs.mjs` ranks `notRun` by EXACT STRING to
//   surface fragility that REPEATS across runs, so a label must be bare and aggregatable — no
//   counts, no lens lists, no file names. A note like "3 finder lens(es) never returned:
//   correctness, concurrency" is unique to its run and fills the ranking with count-1 rows,
//   sinking the real repeats. `lens:correctness` aggregates into `3× lens:correctness`.
//   `note` is the human sentence: it goes to the log and to the returned object, where it is read
//   once, by a person, about this run.
//   `incomplete` decides whether the entry downgrades the VERDICT. Not everything recorded here is
//   a coverage hole: a single verification check with no verdict, or coverage gaps skipped at the
//   budget floor, leave their findings reported as Suspected — already the honest label — and they
//   fire on routine runs. A marker that fires on every run stops being read, which is exactly what
//   would destroy it on the runs where a dimension really did go unreviewed. So those are recorded
//   (the fragility signal is kept) but advisory; only an unreviewed dimension downgrades. This is
//   the same line `review.js` draws: dead lenses and skipped critics mark INCOMPLETE, individual
//   unverified checks do not.
/** @type {{ label: string, note: string, incomplete: boolean }[]} */
const notRun = []
/** @type {(label: string, note: string, incomplete?: boolean) => number} */
const markNotRun = (label, note, incomplete = true) => notRun.push({ label, note, incomplete })
const notRunLabels = () => notRun.map(e => e.label)
const notRunNotes = () => notRun.map(e => e.note)
const notRunBlocking = () => notRun.filter(e => e.incomplete)
// The run's stop (realm @nick/craft, nodes #299, #300): the lens, verifier and critic dispatches go through
// `reviewAgent`, and so do the memory recall and the decision and rule judges: it dispatches nothing once
// one agent failed on the limit, or once a throttled pass (the finder lenses, verification, the gap
// verification), its retry rounds included, settled with every agent of it dead (node #300: the limit's
// usual shape, a bare null).
const advLimit = makeLimitStop(log)
const reviewAgent = stopAtLimit(agent, advLimit)
const runThrottledPass = makeThrottledRunner({
  agent: reviewAgent, parallel, log, markNotRun,
  batch: BATCH, retryBatch: RETRY_BATCH, maxRetryRounds: MAX_RETRY_ROUNDS,
  budget, budgetFloor: BUDGET_FLOOR,
})
/** One throttled pass as one round of the stop. @type {typeof runThrottledPass} */
const runThrottled = (jobs, tag, phaseTitle, opts) => advLimit.round(`the ${tag} pass`, () => runThrottledPass(jobs, tag, phaseTitle, opts))
/**
 * Files the record of a run that ended before any lens ran.
 * @param {string} verdictIn @param {string[]} labels  its notRun classes
 */
async function fileEarlyExit(verdictIn, labels) {
  await logRun({
    ...recordHead(),
    verdict: verdictIn, findings: summarizeFindings([]),
    scout: scoutRecord([]),
    dimensions: [], verification: { candidates: 0, confirmed: 0, refuteRate: 0 },
    notRun: labels, outputTokens: budget.spent(),
  })
}

/**
 * An INCOMPLETE early exit: logged, filed under its one notRun class, and returned with its message.
 * @param {string} verdictIn @param {string} label @param {string} msg
 */
async function incompleteExit(verdictIn, label, msg) {
  log(`INCOMPLETE — ${msg}`)
  await fileEarlyExit(verdictIn, [label])
  return { verdict: verdictIn, confirmed: [], suspected: [], notRun: [msg].concat(telemetryNotes()), scout: { size: plan.sizeBucket, lenses: [], deadLenses: [] }, ...priorRefusedResult() }
}

/** @returns {string} the cross-check's instruction for resolving the diff base */
const crossBaseStep = () => diffBase ? `The caller pinned it: use \`${diffBase}\`.` : 'Try in order: `git merge-base HEAD origin/main`, `git merge-base HEAD main`, `HEAD~1`. If the tree has uncommitted changes, target those.'

/**
 * Why the cross-check does not confirm the scout's all-inert list, or null when it does.
 * @param {CrosscheckResult | null} cross @param {string[]} changedFiles @returns {string | null}
 */
function inertDisagreement(cross, changedFiles) {
  const crossFiles = (cross?.ok && Array.isArray(cross.files)) ? cross.files.filter(isPath) : null
  // Read only where `crossFiles` is set, and that implies a live `cross`.
  const crossCount = cross?.fileCount
  if (!crossFiles) return 'the cross-check never returned a usable list'
  if (crossFiles.length !== crossCount) return `the cross-check list is incomplete (${crossFiles.length} paths vs ${crossCount} reported by git)`
  if (crossFiles.length !== changedFiles.length) return `git reports ${crossFiles.length} changed file(s), the scout reported ${changedFiles.length}`
  if (materialUncovered(crossFiles).length) return `git's list contains reviewable code the scout did not report: ${materialUncovered(crossFiles).join(', ')}`
  return null
}

// All inert (docs/assets/lockfiles/generated). Nothing ran AND nothing needed to — an honest
// green, deliberately not marked INCOMPLETE: a marker that fires on every README-only change
// stops being read on the diffs that do hide unreviewed code.
//
// But this is the ONE exit where a green rests entirely on the scout's file list, and that list
// comes from a model, not from `git`. A scout that truncated, globbed, or resolved the wrong base
// and happened to emit only docs and lockfiles would approve a real code diff. The script itself
// has no shell (the Workflow sandbox has no filesystem or Node API), so the deterministic route
// is a second, single-purpose agent that does nothing but transcribe `git diff --name-only`. It
// is cheap and only fires on this branch. The green is taken only if that independent list is
// complete by its own `wc -l`, agrees with the scout's size, and is itself entirely inert;
// anything else — including a dead cross-check — falls back to INCOMPLETE.
//
// The base is resolved INDEPENDENTLY, not taken from `plan.baseRef`. Pinning the cross-check to
// the scout's own base would leave the wrong-base case structurally invisible — both agents would
// diff the same wrong ref, agree perfectly, and the green would be granted. Resolving it again
// from the same deterministic ladder turns a wrong base into a differing file list, which the
// comparison below already catches. Only an explicit `diffBase` argument is passed through: there
// the base is the caller's, not the scout's, so there is nothing to cross-check.
//
// What this still does NOT catch: `fileCount` and `files` come from the same model in the same
// response, so the self-consistency arm is self-reported — a model that truncates the list AND
// lowers its own count to match defeats it. What that arm actually rules out is the ordinary
// failure (a list shortened while the count stays honest), not a coordinated one.
/** @param {string[]} changedFiles  the scout's list, every path inert */
async function inertExit(changedFiles) {
  const cross = /** @type {CrosscheckResult | null} */ (await agent(
    `You are cross-checking a diff's file list. Run shell only — do NOT review, summarise, or judge anything.
1. Resolve the diff base YOURSELF — do not take it from anyone else. ${crossBaseStep()}
2. Run \`git diff --name-only <base>\` and \`git diff --name-only <base> | wc -l\`.
3. Return every path VERBATIM in \`files\` — no truncation, no globbing, no sorting, no elision — and the \`wc -l\` number in \`fileCount\`.
4. Set ok=true ONLY if the git command succeeded and \`files\` holds every path it printed. If anything failed, or you had to shorten the list for any reason, set ok=false.`,
    { label: 'inert-crosscheck', phase: 'Prep', schema: CROSSCHECK_SCHEMA, model: 'haiku', effort: 'low' },
  ))
  const why = inertDisagreement(cross, changedFiles)
  if (why) {
    return await incompleteExit('INCOMPLETE (unconfirmed inert diff)', 'inert-diff-unconfirmed',
      `NOT REVIEWED — the scout said every changed file was inert (docs/assets/lockfiles/generated), but ${why}. The scout's file list is the only thing that green rested on, so it is not granted: no lens ran, and this is not an approval. Re-run, checking the diff base.`)
  }
  const msg = nothingToReviewMessage(changedFiles.length)
  log(msg)
  memory = skippedMemory(memory, 'nothing to review')
  await fileEarlyExit('Approve', [])
  return { verdict: 'Approve', confirmed: [], suspected: [], notRun: telemetryNotes(), summary: msg, scout: { size: plan.sizeBucket, lenses: [], deadLenses: [] }, ...priorRefusedResult() }
}

/**
 * Tells apart the scout's three outcomes: an unknown diff (opens notRun; the review proceeds), an
 * empty one and an all-inert one (both end the run here). Returns the early result, or null to review.
 * @param {ScoutResult | null} scoutIn
 */
async function coverageGuard(scoutIn) {
  const changedFiles = Array.isArray(scoutIn?.changedFiles) ? scoutIn.changedFiles.filter(isPath) : null
  if (!scoutIn || !changedFiles) {
    markNotRun('scout-dead', scoutIn
      ? 'the scout returned no file list — the diff was never enumerated, so what the lenses saw is unverified'
      : 'scout died — the diff was never enumerated, so what the lenses saw is unverified')
    return null
  }
  if (!changedFiles.length) {
    memory = skippedMemory(memory, 'nothing to review')
    return await incompleteExit('INCOMPLETE (empty diff)', 'empty-diff', noChangedFilesMessage())
  }
  if (!materialUncovered(changedFiles).length) return await inertExit(changedFiles)
  return null
}
const early = await coverageGuard(scout)
if (early) return early
await startCheckpoint('prep', { size: plan.sizeBucket, lenses: plan.lenses }, scout)
// ONE read-only agent recalls the decisions through the craft:memory skill for the diff's paths (realm
// @nick/craft, node #203); its answer is parsed like a passed list and the passed records merge into it.
async function recallMemory() {
  if (recalledByLauncher) return
  if (budget.total && budget.remaining() < BUDGET_FLOOR) {
    memory = withDerived(withPassed({ source: 'none', count: 0, why: `recall did not run — budget below the floor (~${Math.round(budget.remaining() / 1000)}k left)` }, priorDecisionsIn.decisions.length, priorDecisionsIn.decisions.length), priorDecisionsIn.decisions)
    return
  }
  const paths = Array.isArray(scout?.changedFiles) ? scout.changedFiles.filter(isPath) : []
  const r = await recallDecisions(p => reviewAgent(p, { label: 'memory-recall', phase: 'Prep', schema: MEMORY_RECALL_SCHEMA, effort: 'low' }), paths, plan.baseRef || '')
  const m = mergeRecall(r, A['priorDecisions'], parsePriorDecisions)
  priorDecisionsIn = m.prior
  memory = m.memory
  for (const x of m.recalledRefused) log(`WARNING: priorDecisions: ${x}`)
}
await recallMemory()

// ================= Review: throttled finder lenses =================
/**
 * Lenses whose answer came back and is not a review, marked not-run one entry per lens.
 * @param {string[]} lenses @param {Map<string, FindingsResult | null>} lensResults @returns {string[]}
 */
function markMalformedLenses(lenses, lensResults) {
  // A result is model output: the schema is enforced by the tool, but a lens that came back without a
  // findings array is a lens that did not review, not one that found nothing — and must not crash the run.
  // It is dead for every consumer of `deadLenses` (the all-dead check, the critic's prompt, the returned
  // scout), not only for `notRun`.
  const malformedLenses = lenses.filter((/** @type {string} */ lens) => {
    const r = lensResults.get(lens)
    return r != null && !Array.isArray(r.findings)
  })
  if (malformedLenses.length) {
    log(`WARNING: finder lens(es) answered without a findings array: ${malformedLenses.join(', ')}`)
    for (const l of malformedLenses) markNotRun(`lens:${l}`, `the ${l} finder lens returned no findings array — that dimension went unreviewed`)
  }
  return malformedLenses
}

/**
 * Runs the finder lenses throttled; returns every finding tagged with its lens, and the lenses that
 * did not review (died, or answered without a findings array).
 * @param {string[]} lenses
 */
async function runFinderLenses(lenses) {
  /** @type {Map<string, FindingsResult | null>} */
  const lensResults = new Map()
  const deadLensJobs = await runThrottled(
    lenses.map((/** @type {string} */ lens) => ({
      prompt: finderPrompt(lens),
      label: `review:${lens}`,
      schema: FINDINGS,
      effort: 'medium',
      onResult: (/** @type {unknown} */ r) => lensResults.set(lens, /** @type {FindingsResult | null} */ (r)),
    })),
    'Review', 'Review', { reportUnjudged: false },
  )
  const diedLenses = deadLensJobs.map(j => j.label.replace(/^.*review:/, ''))
  if (diedLenses.length) {
    log(`WARNING: finder lens(es) returned nothing: ${diedLenses.join(', ')}`)
    // One entry PER dead lens: `lens:correctness` is what aggregates across runs into
    // "3× lens:correctness", which is the whole point of ranking `notRun`.
    for (const l of diedLenses) markNotRun(`lens:${l}`, `the ${l} finder lens never returned — that dimension went unreviewed`)
  }
  const malformedLenses = markMalformedLenses(lenses, lensResults)
  /** @type {string[]} */
  const deadLensNames = [...new Set([...diedLenses, ...malformedLenses])]
  if (lenses.length && deadLensNames.length === lenses.length) markNotRun('all-lenses-dead', 'EVERY finder lens died — no lens looked at this diff at all')

  const lensFindings = lenses.flatMap((/** @type {string} */ lens) => {
    const r = lensResults.get(lens)
    return r && Array.isArray(r.findings) ? r.findings.map(x => ({ ...x, lens })) : []
  })
  return { deadLenses: deadLensNames, all: lensFindings }
}

phase('Review')
const { deadLenses, all } = await runFinderLenses(plan.lenses)

// ---- dedup, tier 1 (mechanical): neighbor line-buckets + title-token similarity ----
// Merging requires BOTH nearby lines (|Δ| <= 5, buckets k-1..k+1 so bucket borders don't split)
// AND similar titles — proximity alone never merges, so two distinct issues in one window
// survive as two findings. Under-merge costs one cheap verify agent; over-merge silently
// loses a finding — stay conservative.
const normTokens = (/** @type {unknown} */ t) => new Set(String(t || '').toLowerCase().replace(/[^a-z0-9\u0430-\u044f\u0451]+/gi, ' ').split(' ').filter(w => w.length > 2))
/** @param {unknown} a @param {unknown} b */
function titleSimilar(a, b) {
  const tokensA = normTokens(a), B = normTokens(b)
  if (!tokensA.size || !B.size) return false
  let inter = 0
  for (const w of tokensA) if (B.has(w)) inter++
  return inter / (tokensA.size + B.size - inter) > 0.5
}
/**
 * The first entry in bucket b-1, b or b+1 of the finding's file that lies within 5 lines and has a similar title.
 * @param {Map<string, LensFinding[]>} buckets @param {RawFinding} f @param {number} b @returns {LensFinding | null}
 */
function nearbySimilar(buckets, f, b) {
  for (const nb of [b - 1, b, b + 1]) {
    for (const e of (buckets.get(`${f.file}:${nb}`) || [])) {
      if (Math.abs(e.line - f.line) <= 5 && titleSimilar(e.title, f.title)) return e
    }
  }
  return null
}
/**
 * Folds a duplicate into the entry it hit: its lens joins the sources, and a more severe duplicate's wording wins.
 * @param {LensFinding} hit @param {RawFinding & { lens: string }} f
 */
function absorbDuplicate(hit, f) {
  if (!hit.sources.includes(f.lens)) hit.sources.push(f.lens)
  if (SEV_RANK[/** @type {keyof typeof SEV_RANK} */ (f.severity)] < SEV_RANK[/** @type {keyof typeof SEV_RANK} */ (hit.severity)]) {
    Object.assign(hit, { title: f.title, line: f.line, severity: f.severity, description: f.description, fix: f.fix, lens: f.lens })
  }
}
/** @param {(RawFinding & { lens: string })[]} findings @returns {LensFinding[]} the pool after mechanical dedup, most severe first */
function mechanicalDedup(findings) {
  /** @type {Map<string, LensFinding[]>} */
  const buckets = new Map()   // `${file}:${bucket}` -> entries in that bucket
  /** @type {LensFinding[]} */
  const merged = []
  for (const f of findings) {
    const b = Math.floor(f.line / 10)
    const hit = nearbySimilar(buckets, f, b)
    if (hit) {
      absorbDuplicate(hit, f)
      continue
    }
    const entry = { ...f, sources: [f.lens] }
    merged.push(entry)
    const key = `${f.file}:${b}`
    const bucket = buckets.get(key)
    if (bucket) bucket.push(entry)
    else buckets.set(key, [entry])
  }
  return merged.sort((a, b) => SEV_RANK[/** @type {keyof typeof SEV_RANK} */ (a.severity)] - SEV_RANK[/** @type {keyof typeof SEV_RANK} */ (b.severity)])
}
let kept = mechanicalDedup(all)
log(`Review: ${all.length} raw findings -> ${kept.length} after mechanical dedup`)

// ---- dedup, tier 2 (semantic, thresholded): one haiku clusterer for cross-vocabulary duplicates ----
// Catches what token overlap can't: different lenses describing one defect in different words
// ("TOCTOU at debit" vs "race on balance update"). Runs only on large pools where duplicates
// are likely; merges keep BOTH formulations so an over-eager merge degrades to a verbose
// description instead of a lost finding.
const DEDUP_THRESHOLD = 15
/** @returns {boolean} whether the budget still allows spawning agents (an unlimited one always does) */
const budgetAllows = () => !budget.total || budget.remaining() > BUDGET_FLOOR
/**
 * Merges each cluster's duplicates into its most severe member, keeping both formulations.
 * @param {LensFinding[]} keptIn @param {number[][]} clusters @returns {Set<number>} the indices merged away
 */
function mergeClusters(keptIn, clusters) {
  /** @type {Set<number>} */
  const drop = new Set()
  // Only ever called with an index the filter below has bounded to `kept`.
  const at = (/** @type {number} */ i) => /** @type {LensFinding} */ (keptIn[i])
  for (const cluster of clusters) {
    const idxs = [...new Set(Array.isArray(cluster) ? cluster : [])]
      .filter(i => Number.isInteger(i) && i >= 0 && i < keptIn.length && !drop.has(i))
      .sort((x, y) => SEV_RANK[/** @type {keyof typeof SEV_RANK} */ (at(x).severity)] - SEV_RANK[/** @type {keyof typeof SEV_RANK} */ (at(y).severity)])
    if (idxs.length < 2) continue
    const head = at(/** @type {number} */ (idxs[0]))
    for (const i of idxs.slice(1)) {
      mergeDuplicate(head, at(i))
      drop.add(i)
    }
  }
  return drop
}
/** @param {LensFinding} head @param {LensFinding} dup */
function mergeDuplicate(head, dup) {
  for (const s of dup.sources) if (!head.sources.includes(s)) head.sources.push(s)
  head.description += `\n[merged duplicate] ${dup.title} @ ${dup.file}:${dup.line}: ${dup.description}`
}
/** @param {LensFinding[]} keptIn @returns {Promise<LensFinding[]>} the pool after the semantic clusterer, or `kept` itself when it merged nothing */
async function semanticDedup(keptIn) {
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
  const clusterer = /** @type {ClustersResult | null} */ (await agent(
    `You are deduplicating review findings. Below is a numbered list. Return clusters of indices that describe THE SAME underlying defect — same root cause, one fix would resolve all of them — even when phrased in different vocabulary or cited at nearby-but-different lines (e.g. a check-site vs a write-site of one race).
Merge ONLY when confident the fix is literally the same change. Two different problems in the same function are NOT a cluster. When in doubt, do not merge. Return {"clusters": []} if there are no duplicates.

FINDINGS:
${keptIn.map((f, i) => `${i}. [${f.severity}] ${f.title} @ ${f.file}:${f.line} (lenses: ${f.sources.join(',')}) — ${f.description}`).join('\n')}`,
    { label: 'dedup-semantic', phase: 'Review', schema: CLUSTERS_SCHEMA, model: 'haiku', effort: 'low' },
  ))
  // Model output: a live clusterer whose `clusters` is not an array merged nothing — say so, never throw.
  const clusters = Array.isArray(clusterer?.clusters) ? clusterer.clusters : []
  if (clusterer && !Array.isArray(clusterer.clusters)) log('WARNING: semantic dedup returned clusters that are not an array — no semantic merge applied')
  const drop = mergeClusters(keptIn, clusters)
  if (!drop.size) {
    log('Semantic dedup: no cross-vocabulary duplicates found')
    return keptIn
  }
  const rest = keptIn.filter((_f, i) => !drop.has(i))
  log(`Semantic dedup: merged ${drop.size} duplicate(s) -> ${rest.length} findings`)
  return rest
}
if (kept.length > DEDUP_THRESHOLD && budgetAllows()) kept = await semanticDedup(kept)

// ================= Verify =================
phase('Verify')
const COMBINED_INSTR = `You are an adversarial verifier. Try to REFUTE this finding. Check ALL THREE dimensions in one pass:
1. code — is the claim factually true in the code as written? Read the actual code; do not trust the description.
2. exploit — construct a concrete end-to-end scenario that triggers the issue. If you cannot, that counts against the finding.
3. severity — calibrate real impact for the multi-tenant money-path, and confirm the issue is in scope for THIS diff.
Return refuted=true if ANY dimension fails. Default to refuted=true when uncertain. Return the calibrated severity.
Also set premiseSupported: identify the ONE claim that, if false, makes the finding evaporate. If it lives outside the cited line, OPEN the finding's whereChecked location and check it actually shows that; premiseSupported=false when the premise is off-site and whereChecked is empty, points elsewhere, or merely restates the cited line. Unsupported is NOT disproven — do not raise refuted for it; the field demotes the finding on its own.`
const COMBINED_METRIC_INSTR = `You are an adversarial verifier for a METRIC-BACKED complexity finding.
Use ToolSearch to load the codebase-memory MCP tools. Check ALL THREE dimensions:
1. metric — re-read the metric values yourself via query_graph; refute if they don't match the claim or the index is unavailable.
2. attribution — confirm THIS diff introduced or worsened the metric (compare against detect_changes); pre-existing debt misattributed to the diff -> refute or downgrade.
3. severity — calibrate real impact: is the function on a hot / caller-reachable path (trace_path), or dead-end cold code?
Return refuted=true if ANY dimension fails; default to refuted=true when uncertain.
Also set premiseSupported: true when you re-read the metric values yourself and they back the claim, false when the numbers came only from the finding's own description. Unsupported is NOT disproven — it demotes the finding without marking it refuted.`
/** @type {[string, string][]} */
const PANEL_LENSES = [
  ['code', 'Verify ONLY the factual claim against the code as written. Read the code yourself; refute if the description misstates it.'],
  ['exploit', 'Try to construct a concrete end-to-end exploit/trigger scenario. Refute if no realistic path exists.'],
  ['severity', 'Calibrate real-world severity for the multi-tenant money-path and check the issue is in scope for this diff. Refute if severity is inflated or out of scope.'],
]

// Builds verify jobs for a set of findings, writing votes into `sink[idx]`.
// Single combined verifier (effort low) for medium/low; 3-lens panel (effort high)
// for critical/high; metric-aware single verifier for complexity findings.
/**
 * @param {LensFinding[]} findings
 * @param {unknown[][]} sink  per-finding raw votes, one slot per finding
 */
function buildVerifyJobs(findings, sink) {
  /** @type {Parameters<typeof runThrottled>[0]} */
  const jobs = []
  // `sink` is built as one array per finding, so `idx` from `findings.forEach` always has a slot.
  const slot = (/** @type {number} */ idx) => /** @type {unknown[]} */ (sink[idx])
  findings.forEach((f, idx) => {
    const ctx = `FINDING [${f.severity}] ${f.title} @ ${f.file}:${f.line}\n` +
      `Independently reported by lenses: ${(f.sources || [f.lens]).join(', ')}\n${f.description}\nProposed fix: ${f.fix}\n` +
      `Off-site evidence claimed: ${f.whereChecked || '(none — the finding claims to be self-contained at the cited line)'}`
    /** @type {(lens: string, instr: string, effort: 'low' | 'high', tagged: boolean) => number} */
    const push = (lens, instr, effort, tagged) => jobs.push({
      prompt: `${instr}\n\n${ctx}`,
      label: `verify${tagged ? `[${lens}]` : ''}:${f.file}:${f.line}`,
      schema: VERDICT,
      effort,
      onResult: (/** @type {unknown} */ v) => slot(idx).push({ lens, .../** @type {VerdictResult | null} */ (v) }),
      // A check that never returned leaves a placeholder, so the judge can SEE the panel is short.
      // Without it a 3-lens panel that lost one member is indistinguishable from a 2-lens panel.
      onMissing: () => slot(idx).push({ lens, missing: true }),
    })
    if (f.lens === 'complexity') push('metric', COMBINED_METRIC_INSTR, 'low', true)
    else if (isEscalated(f)) for (const [lens, instr] of PANEL_LENSES) push(lens, instr, 'high', true)
    else push('combined', COMBINED_INSTR, 'low', false)
  })
  return jobs
}

/** @template {LensFinding} F @param {F[]} findings @param {Parameters<typeof judgeVotes>[1]} sink */
const judge = (findings, sink) => judgeVotes(findings, sink, SEV_RANK)

/** @type {unknown[][]} */
const votes = kept.map(() => [])
const verifyJobs = buildVerifyJobs(kept, votes)
log(`Verify plan: ${kept.length} findings -> ${verifyJobs.length} checks (${kept.filter(isEscalated).length} escalated to 3-lens panel), throttled to ${BATCH} concurrent`)
// `runThrottled` records the unjudged checks in `notRun` itself (advisory; lib/throttled-runner.mjs).
/** @param {unknown[]} unverified */
const warnUnverified = unverified => { if (unverified.length) log(`WARNING: ${unverified.length} checks got no verdict after retries`) }
warnUnverified(await runThrottled(verifyJobs, 'Verify', 'Verify'))

const judged = judge(kept, votes)
let { confirmed, refuted } = judged
// Wider than the judge's own output: coverage gaps left unverified at the budget floor join this list
// as they are, with no panel and none of the judge's per-finding flags.
/** @type {Array<(typeof judged.suspected)[number] | (LensFinding & { confirmed: false, votes: never[] })>} */
let suspected = judged.suspected
log(`Verify done: ${confirmed.length} confirmed, ${refuted.length} refuted, ${suspected.length} suspected (no verdict)`)
// A finding nobody decided must reach the VERDICT, not only the Suspected list. Suspected downgrades
// nothing — `baseVerdict` is computed from `confirmed` alone — so a run in which every escalated
// finding lost the one panel member that would have decided it prints a bare `Approve`, identical to
// a run whose panels all voted and cleared them. Blocking, and narrow: it needs an escalated
// (critical/high) finding whose absent vote was the deciding one, which is the exact case where the
// engine cannot say whether this run should have blocked.
// Gated on what the absent vote could have DECIDED, never on the finder's label. `isEscalated` reads
// the finder's severity and lens — the fields that shaped the panel — and both of its clauses leak
// here: a complexity finding is excluded by lens although the lens emits `high` and gets a single
// verifier, and a `medium` finding is excluded by severity although one verifier can calibrate it to
// `critical`. The judge computes the reachable tier instead.
/** @param {typeof judged} j */
function markUndecidedEscalated(j) {
  const undecidedEscalated = [...j.confirmed, ...j.refuted, ...j.suspected].filter(f => f.undecidedByAbsence && f.couldHaveBlocked)
  if (undecidedEscalated.length) {
    markNotRun('escalated-findings-undecided', `${undecidedEscalated.length} critical/high finding(s) lost the panel vote that would have decided them — this run cannot say whether it should have blocked`)
  }
}
markUndecidedEscalated(judged)

// ================= Coverage: critic, then verify its gaps through the same pipeline =================
/**
 * The completeness critic (retried once), and its gaps tagged as coverage findings; a critic that died
 * twice or answered without a findings array is not-run and yields no gaps.
 * @param {{ title: string, file: string, line: number }[]} confirmedIn @param {{ title: string, file: string, line: number }[]} refutedIn
 * @returns {Promise<LensFinding[]>}
 */
async function criticGaps(confirmedIn, refutedIn) {
  const CRITIC_PROMPT = `You are a completeness critic for an adversarial diff review (diff base: ${plan.baseRef || 'HEAD'}).
Ask: what is MISSING — a changed file no finding touched, a category of bug not checked, a dimension left uncovered?
Report each gap as a concrete located finding (file:line of the suspicious spot, severity, description, fix).
CONFIRMED findings (do not repeat them): ${JSON.stringify(confirmedIn.map(f => `${f.title} @ ${f.file}:${f.line}`))}
REFUTED claims (do NOT re-report these — they were adversarially disproven): ${JSON.stringify(refutedIn.map(f => `${f.title} @ ${f.file}:${f.line}`))}
Dead lenses this run (their dimension is UNCOVERED — look there first): ${JSON.stringify(deadLenses)}
If coverage is complete, return {"findings": []}.`
  let critic = /** @type {FindingsResult | null} */ (await reviewAgent(CRITIC_PROMPT, { label: 'coverage-critic', phase: 'Coverage', schema: FINDINGS, effort: 'high' }))
  if (!critic) {
    log('Coverage critic failed, retrying once')
    critic = /** @type {FindingsResult | null} */ (await reviewAgent(CRITIC_PROMPT, { label: 'coverage-critic-retry', phase: 'Coverage', schema: FINDINGS, effort: 'high' }))
  }
  if (!critic) {
    // Without this the critic's silence is indistinguishable from "coverage is complete": `?? []`
    // below yields zero gaps, and a diff whose blind spots were never looked for reads as covered.
    log('WARNING: coverage critic died twice — completeness was never checked')
    markNotRun('coverage-critic-dead', 'the coverage critic died twice — no completeness check ran, so blind spots in this review are unknown')
  }

  // A live critic whose `findings` is not an array checked nothing we can read — that is not-run under
  // its own label, never a silent "coverage is complete" and never a crash.
  if (critic && !Array.isArray(critic.findings)) {
    log('WARNING: coverage critic answered without a findings array — completeness was never checked')
    markNotRun('coverage-critic-malformed', 'the coverage critic answered without a findings array — no usable completeness check ran, so blind spots in this review are unknown')
  }
  // Critic findings do not bypass verification — they ride the same throttled pipeline.
  return (critic && Array.isArray(critic.findings) ? critic.findings : []).map(f => ({ ...f, lens: 'coverage', sources: ['coverage'] }))
}
phase('Coverage')
const gaps = await criticGaps(confirmed, refuted)

/**
 * Verifies the critic's gaps through the same pipeline, or — below the budget floor — reports them
 * as suspected; returns the confirmed and suspected lists with the gaps' outcome folded in.
 * @param {LensFinding[]} gapsIn @param {typeof confirmed} found @param {typeof suspected} doubtful
 */
async function withGapVerdicts(gapsIn, found, doubtful) {
  if (gapsIn.length && budgetAllows()) {
    log(`Coverage critic raised ${gapsIn.length} gap(s) -> verifying through the same pipeline`)
    /** @type {unknown[][]} */
    const gapVotes = gapsIn.map(() => [])
    // Opts out of the runner's advisory entry and marks its own BLOCKING one, for the reason the
    // budget-floor branch below spells out: a coverage gap is the critic's claim that something went
    // UNREVIEWED. Crossing the budget floor midway through this pass leaves exactly the same blind
    // spots unopened as failing to start it, so the two must land on the same side of the line —
    // otherwise the identical run reads `Approve` or `Approve (INCOMPLETE)` depending only on which
    // side of the first batch the floor happened to fall. Same label, so analyze-runs aggregates both.
    const unverifiedGapJobs = await runThrottled(buildVerifyJobs(gapsIn, gapVotes), 'Coverage-verify', 'Coverage', { reportUnjudged: false })
    if (unverifiedGapJobs.length) {
      log(`WARNING: ${unverifiedGapJobs.length} coverage-gap checks got no verdict`)
      markNotRun('coverage-gaps-unverified', `${unverifiedGapJobs.length} coverage-gap check(s) got no verdict — the blind spots they name went unopened`)
    }
    const g = judge(gapsIn, gapVotes)
    log(`Coverage gaps: +${g.confirmed.length} confirmed · +${g.suspected.length} suspected · ${g.refuted.length} refuted`)
    return { found: found.concat(g.confirmed), doubtful: doubtful.concat(g.suspected), refutedGaps: g.refuted.length }
  }
  if (gapsIn.length) {
    log(`Budget too low to verify ${gapsIn.length} coverage gap(s) -> reported as suspected`)
    // Blocking, unlike `verify-checks-unjudged`, and the difference is epistemic rather than a matter
    // of degree. An unjudged *finding* is a claim that something is wrong; reporting it as Suspected
    // is already the honest answer, and the review still looked. A coverage gap is the critic's claim
    // that something went UNREVIEWED — the same category as a dead lens, which downgrades. Leaving it
    // advisory would let a plain `Approve` stand on a run whose named blind spots nobody opened.
    // It does not fire on routine runs: it needs the budget floor reached AND gaps raised.
    markNotRun('coverage-gaps-unverified', `${gapsIn.length} coverage gap(s) were never verified (budget floor reached) — they are reported as Suspected, and the blind spots they name went unopened`)
    return { found, doubtful: doubtful.concat(gapsIn.map(f => ({ ...f, confirmed: false, votes: [] }))), refutedGaps: 0 }
  }
  return { found, doubtful, refutedGaps: 0 }
}
const gapped = await withGapVerdicts(gaps, confirmed, suspected)
confirmed = gapped.found
suspected = gapped.doubtful
const refutedGaps = gapped.refutedGaps

// ---- Prior decisions: the project's recorded rejections, handed in by the launching session ----
// The same rules as review (the module carries them): a matching finding below critical/high whose
// decision's scope is unchanged since the recorded commit leaves the verdict and is returned under
// `rejectedBefore`, marked in its description; anything else is raised again with the decision named.
// A finding going against an active memory record is counted with the doubt signs it carries (realm @nick/craft, node #282).
const prior = await applyPriorDecisions(
  /** @type {Record<string, Array<(typeof confirmed)[number] | (typeof suspected)[number]>>} */ ({ confirmed, suspected }),
  priorDecisionsIn.decisions,
  toCheck => reviewAgent(scopeCheckPrompt(toCheck), { label: 'decision-scope', phase: 'Coverage', schema: SCOPE_CHECK_SCHEMA, effort: 'low' }),
  'description',
  // One cheap judge for the disputed record–finding pairs, only when one exists (realm @nick/craft, node #230).
  prompt => reviewAgent(prompt, { label: 'decision-match', phase: 'Coverage', schema: MATCH_JUDGE_SCHEMA, model: 'sonnet', effort: 'low' }),
)
for (const n of prior.notes) log(`priorDecisions: ${n}`)
// A decision whose commit this repo does not know is named with the refusals, apart from a changed scope.
priorDecisionsIn.refused.push(...prior.refused)
confirmed = /** @type {typeof confirmed} */ (prior.tiers['confirmed'])
suspected = /** @type {typeof suspected} */ (prior.tiers['suspected'])
// Project rules after the decisions (realm @nick/craft, node #273): a finding the judge puts under a rule
// leaves the verdict into `coveredByRule`; a Critical one, or one without a verdict, stays — `ruleNotices` says so.
async function coverByProjectRules() {
  const r = await applyProjectRules(
    /** @type {Record<string, Array<(typeof confirmed)[number] | (typeof suspected)[number]>>} */ ({ confirmed, suspected }),
    priorDecisionsIn.decisions,
    'description',
    prompt => reviewAgent(prompt, { label: 'rule-match', phase: 'Coverage', schema: RULE_JUDGE_SCHEMA, model: 'sonnet', effort: 'low' }),
  )
  for (const n of r.notes) log(`project rules: ${n}`)
  confirmed = /** @type {typeof confirmed} */ (r.tiers['confirmed'])
  suspected = /** @type {typeof suspected} */ (r.tiers['suspected'])
  if (r.rules) memory = { ...memory, covered: r.covered.length }
  return r
}
const ruled = await coverByProjectRules()
/**
 * One list of set-aside findings as a result field, absent when empty: `rejectedBefore` for those a
 * decision answers, `knownDeferred` for those an open (deferred) question answers.
 * @param {string} key @param {typeof prior.setAside} list
 */
function setAsideField(key, list) {
  return list.length ? { [key]: list.map(({ votes: _v, ...f }) => f) } : {}
}
/** What the returned object adds for prior decisions — nothing at all when none were given. */
function priorDecisionsResult() {
  return {
    ...setAsideField('rejectedBefore', prior.setAside.filter(f => f.priorKind !== 'question')),
    ...setAsideField('knownDeferred', prior.setAside.filter(f => f.priorKind === 'question')),
    ...(ruled.covered.length ? { coveredByRule: ruled.covered.map(({ votes: _v, ...f }) => f) } : {}),
    ...(ruled.notices.length ? { ruleNotices: ruled.notices } : {}),
    ...priorRefusedResult(),
  }
}

// A verdict must never claim more coverage than the run had: a dimension that went unreviewed
// downgrades the verdict, so a run where the work died cannot read exactly like a clean one. The
// advisory entries (see `markNotRun`) are recorded and printed but do NOT downgrade — their
// findings are already reported as Suspected, and a marker that fires on routine runs stops being
// read on the runs that need it.
/** @param {{ severity: string }[]} found @returns {string} */
function verdictOf(found) {
  const baseVerdict = found.some(f => f.severity === 'critical' || f.severity === 'high') ? 'Block'
    : found.some(f => f.severity === 'medium') ? 'Warning' : 'Approve'
  return honestVerdict(baseVerdict, notRunBlocking().map(e => e.label))
}
// A usage limit or a dead round stopped the run: the stop is a blocking notRun entry, so the verdict is
// never Approve, labelled by which stop it was.
function noteLimitStop() {
  if (advLimit.seen()) markNotRun(advLimit.cause() === 'deaths' ? 'agents-died' : 'usage-limit', limitStopAdvice(advLimit, { version: CRAFT_VERSION, engine: 'adversarial-review', checkpoints: !!runDir }))
}
noteLimitStop()
const verdict = verdictOf(confirmed)
log(`Verdict: ${verdict} — ${confirmed.length} confirmed, ${suspected.length} suspected`)
for (const e of notRun) log(`${e.incomplete ? 'NOT RUN' : 'PARTIAL'}: ${e.note}`)

// ---- run record ----
/** The verdict's findings with their tier, `description` read as the reason the doubt signs scan. */
function tieredFindings() {
  return [...confirmed.map(f => ({ ...f, tier: 'confirmed', why: f.description })), ...suspected.map(f => ({ ...f, tier: 'suspected', why: f.description }))]
}
// The findings going against memory, as review renders them; this engine posts nothing, so no sorting reads them.
const contradicts = contradictionSection(tieredFindings()).trim()
const candidates = kept.length + gaps.length
const refutedTotal = refuted.length + refutedGaps
await logRun({
  ...recordHead(),
  verdict,
  findings: summarizeFindings([...confirmed, ...suspected].map(capSeverity)),
  scout: scoutRecord(plan.lenses),
  dimensions: plan.lenses.map((/** @type {string} */ l) => {
    const s = summarizeFindings(confirmed.filter(f => (f.sources || []).includes(l)).map(capSeverity))
    return { dimension: l, verdict: '', findingCount: s.total, bySeverity: s.bySeverity }
  }),
  verification: { candidates, confirmed: confirmed.length, refuteRate: refuteRate(refutedTotal, candidates) },
  notRun: notRunLabels(),
  // The findings going against an active memory record (realm @nick/craft, nodes #281, #282): this engine
  // posts nothing (`toPr` null) and reads no changed lines, so the outside-the-diff sign is untold.
  memoryContradictions: contradictionRecord(tieredFindings(), null, () => '', null),
  outputTokens: budget.spent(),
})

return {
  verdict,
  confirmed: confirmed.map(({ votes: v, ...f }) => ({ ...f, votes: v.length, refutes: v.filter(x => x.refuted).length })),
  suspected: suspected.map(({ votes: v, ...f }) => f),
  notRun: notRunNotes().concat(telemetryNotes()),
  scout: { size: plan.sizeBucket, lenses: plan.lenses, deadLenses },
  // Only when given: an invocation without priorDecisions returns exactly what it always did.
  ...priorDecisionsResult(),
  ...(contradicts ? { contradictsMemory: contradicts } : {}),
}
}
