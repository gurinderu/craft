import { normalizeArgs } from '../lib/workflow-args.mjs'
import { summarizeFindings, tallyVerdicts, repoRefusal } from '../lib/run-record.mjs'
import { quietly, makeRunLogger, telemetryLossNoter } from '../lib/run-logging.mjs'
import { DEPENDENCY_SOURCE_HOW } from '../lib/dependency-source.mjs'
import { telemetryLostSection } from '../lib/review-coverage.mjs'
import { parsePriorDecisions } from '../lib/prior-decisions.mjs'
import { MEMORY_RECALL_SCHEMA, memoryRecord, mergeRecall, readLaunch, memoryLine, recallDecisions } from '../lib/memory-recall.mjs'
import { MATCH_JUDGE_SCHEMA } from '../lib/prior-decision-match.mjs'
import { SCOPE_CHECK_SCHEMA, scopeCheckPrompt } from '../lib/prior-decision-scope.mjs'
import { RULE_JUDGE_SCHEMA } from '../lib/project-rule-judge.mjs'
import { SIFT_MARK, siftFinding, collapseRepeats, repeatEntry, siftByMemory } from '../lib/triage-sift.mjs'
import { effectivePrBase, classOneBaseLine, classifiedVerdict, issueOf } from '../lib/triage-noise-class.mjs'

export const meta = {
  name: 'triage-findings',
  description: 'Triage review findings (craft agents + GitHub PR comments) into one ordered, validated fix plan — no edits',
  whenToUse: 'For every batch of review findings, whatever its size — from the report file of any review engine or the inline comments of a PR — when you want them validated against the code, deduped, conflict-checked, and turned into an ordered fix plan. It reads ONLY the checkout the session runs in: there is no `repo` argument, and passing one is refused with nothing run (use `craft:review` with repo=, or start a session inside that repository). Pass `prBase` = `git merge-base origin/<trunk> <reviewed head>` (the commit the PR forks from) only when the reviewed head is a branch diverging from trunk, and with it `base` = the reviewed head\'s SHA; on trunk or with no branch leave prBase out. prBase counts only beside a `base` it differs from (with no base, or one equal to it, or HEAD, it is absent): a finding is deferred as not this PR\'s only when shown there, else it comes back needs-decision. `base` is the ref the findings were generated against — the reviewed head — which validation pins to.',
  phases: [
    { title: 'Gather', detail: 'pull raw findings from the requested sources (a report file from any review engine, GitHub PR threads)' },
    { title: 'Sift', detail: 'collapse repeats in the batch; recall the project memory and set aside what an active decision, deferred question or project rule already answers — no validator for those' },
    { title: 'Validate', detail: 'judge each finding against the code at a pinned ref: accept / reject / defer / needs-decision' },
    { title: 'Plan', detail: 'dedup, detect conflicts, group by file, order, render a writing-plans-format fix plan + triage ledger' },
  ],
}

export async function __run() {
// Locator args (not payload): pr (GitHub PR number), report (path to a report file from any review engine
// or a saved verdict), base (ref to pin validation against), prBase (the commit the PR forks from — the merge-base
// of trunk and the reviewed head — where "not this PR's" must be shown, realm @nick/craft, node #309), priorLedger (array of prior {stable_id, verdict,
// reason} for idempotent re-runs), priorDecisions (the project's records the launcher already holds — they
// merge into what this engine recalls itself, realm @nick/craft, node #218). At least one of pr/report must be given.
// `args` may arrive as a parsed object or as a JSON string depending on the harness — normalize.
// ---- args ----
// Three plausible spellings arrive here — a real object, a JSON string, and the `key=value` form the
// skill's own invocation line advertises — and only the first used to work. The other two fell
// through every `typeof args === 'object'` guard, so every option reverted to its default and the
// run reviewed whatever the session was sitting in, then reported a confident verdict for a diff
// nobody asked about. Shared with every other engine (lib/workflow-args.mjs).
const A = normalizeArgs(args, log)

// One arg path, not two. The second one used to re-parse the raw string after normalizeArgs had
// already refused it, so a value reported as "ALL options ignored" was quietly reinstated a line
// later — a loud drop undone in silence, which is worse than either behaviour alone.
const argv = A

/** A text argument: its string form when given (truthy), else ''. @param {string} key @returns {string} */
function textArg(key) {
  return argv[key] ? String(argv[key]) : ''
}

const pr = textArg('pr')
const report = textArg('report')
const base = textArg('base')
// prBase counts only when `base` is given too and they differ: absent when base is empty, when prBase is
// `HEAD`, equal to base, or one SHA a prefix of the other (realm @nick/craft, node #309).
const prBase = effectivePrBase(textArg('prBase'), base)
/** @type {unknown[]} */
const priorLedger = Array.isArray(argv['priorLedger']) ? /** @type {unknown[]} */ (argv['priorLedger']) : []
// Where craft itself lives, so the logger can find lib/craft-log-run.mjs. It selects NO repository:
// this engine has no `repo` argument (see the refusal above) and always triages the checkout the
// session runs in. As an installed plugin CLAUDE_PLUGIN_ROOT is
// set for us; launched by scriptPath from a checkout it is NOT, and the fallback would resolve
// against the triaged repo — where the script is not. Pass craftRoot then.
const craftRootArg = textArg('craftRoot')

const RAW_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['source', 'findings'],
  properties: {
    source: { type: 'string', description: 'review | adversarial-review | rust-audit | rust-reviewer | nix-review | report | github-pr' },
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
  required: ['stable_id', 'verdict', 'reason', 'fix_pointer', 'premise_checked', 'noise_class', 'severity'],
  properties: {
    stable_id: { type: 'string', description: 'composite identity: source::location::title' },
    verdict: { type: 'string', description: 'accept | reject | defer | needs-decision' },
    noise_class: { type: 'integer', description: 'the noise class the finding falls in, 1..6 as the prompt lists them; 0 when none — a defect of this change' },
    severity: { type: 'string', description: 'the severity the code supports: Critical | High | Medium | Low | Info — lowered from the source\'s when its harm is unreachable or heals itself' },
    reason: { type: 'string', description: 'one line justifying the verdict against the code' },
    premise_checked: { type: 'string', description: 'the file:line you actually opened to settle the verdict\'s load-bearing premise when it lives outside the cited location — a dependency\'s behaviour, reachability, what a caller or sibling does. Applies to reject exactly as much as to accept. Empty string only when the cited location alone settled it' },
    fix_pointer: { type: 'string', description: 'owning craft skill + one-line fix direction; empty unless accept' },
  },
}

const PLAN_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['plan_markdown', 'ledger', 'summary'],
  properties: {
    plan_markdown: { type: 'string', description: 'the fix plan in checkbox-task markdown format (accepted findings only)' },
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

// The shapes the three schemas above promise. `agent()` returns them only when it ran: a skipped
// or dead agent yields `null`, so every call site casts to `T | null` and handles the null.
/** @typedef {{ severity: string, title: string, location: string, detail: string, proposed_fix: string, thread_id: string }} RawFinding */
/** @typedef {{ source: string, findings: RawFinding[] }} RawResult */
/** @typedef {RawFinding & { source: string }} SourcedFinding */
/** @typedef {ReturnType<typeof siftFinding>} SiftFinding */
/** @typedef {{ stable_id: string, verdict: string, reason: string, fix_pointer: string, premise_checked: string, noise_class?: number, severity?: string, action?: string }} Validation */
/** @typedef {{ stable_id: string, verdict: string, reason: string, sifted?: boolean, action?: string, repeat_of?: string }} LedgerEntry */
/** @typedef {{ plan_markdown: string, ledger: LedgerEntry[], summary: string }} PlanResult */
// What this script adds to the plan before returning it — not part of PLAN_SCHEMA.
/** @typedef {PlanResult & { notRun?: string[], telemetryLost?: string[], issues?: Array<{ stable_id: string, title: string, body: string }>, memory?: string, priorDecisionsNotApplied?: string[], ruleNotices?: string[] }} TriagePlan */

// The craft release that produced a run. Recorded on the run record and index line so an
// aggregate can be filtered to ONE engine version: without it, runs from every rubric the store
// has ever seen blend together. MUST match `.claude-plugin/plugin.json` — `lib/check-workflows.mjs`
// fails the build if it drifts. The build lifts this line verbatim into the engine's banner.
const CRAFT_VERSION = '0.36.0' // x-release-please-version

// Imported from lib/: the one write path (shared with every other record-filing engine); how to find a
// pinned dependency's source; the banner that leads the plan when a write did not land, the same one
// review.js uses; the project memory — recall, match and the split, the review engine's own (realm
// @nick/craft, nodes #203, #230, #273); the sift itself (node #305) and the validator's noise classes (node #303).

// A lost record NEVER fails the triage: killing it over a bookkeeping write would teach everyone to
// ignore the very marker this exists to raise. It is reported instead, at the head of the plan a
// human actually reads — an empty store is otherwise indistinguishable from "never run".
/** @type {string[]} */
const telemetryLost = []
// The shared run-record writer (lib/run-logging.mjs), bound to this engine's phase and loss note.
const logRun = makeRunLogger({
  call: quietly(agent), phase: 'Plan', target: () => ({ craftRoot: craftRootArg }),
  noteLoss: telemetryLossNoter(telemetryLost, log),
})

// ---- Gather --------------------------------------------------------------
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
  const refused = repoRefusal({ engine: 'triage-findings', repo: String(A['repo']), craftVersion: CRAFT_VERSION, outputTokens: budget.spent() })
  await logRun(refused.record)
  return refused.report
}

phase('Gather')
if (!pr && !report) {
  throw new Error('triage-findings needs a source: pass args.pr (GitHub PR number) and/or args.report (path to a report file from any review engine).')
}

/**
 * One gather task per requested source, and the source each stands for, in the same order: the
 * locators drive NOT-RUN bookkeeping for the run record.
 * @returns {{ gatherTasks: Array<() => Promise<RawResult | null>>, requestedLocators: string[] }}
 */
function gatherPlan() {
  /** @type {Array<() => Promise<RawResult | null>>} */
  const tasks = []
  /** @type {string[]} */
  const locators = []
  if (report) {
    locators.push('report')
    tasks.push(() => /** @type {Promise<RawResult | null>} */ (agent(
      `Read the review report at \`${report}\`. Extract every finding into the schema. Set source to the engine that wrote the report, as the report names it: "review" (craft:review), "adversarial-review", "rust-audit", "rust-reviewer" (a single reviewer verdict) or "nix-review"; "report" when the report does not say. Copy severity/title/location/detail verbatim; leave proposed_fix and thread_id empty unless present. The report's \`## Tool finding titles (verbatim)\` section (also nested under \`## Prior decisions in the nested reviews (verbatim)\`) lists titles, not findings: never extract its rows as findings. For a finding at a \`file:line\` it lists, take the title from it — the listed title equal to the finding's line; or the only one listed there, but only when the report prints a single finding at that \`file:line\` (the section lists gate-tool findings only, so a lens finding at the same site is printed beside the tool's and must not take its title). When several findings are printed there, or several titles are listed and none is equal, keep the finding's own line, never a guess between them.`,
      { label: 'gather:report', phase: 'Gather', schema: RAW_SCHEMA },
    )))
  }
  if (pr) {
    locators.push('pr')
    tasks.push(() => /** @type {Promise<RawResult | null>} */ (agent(
      `Gather inline review comments from GitHub PR #${pr}. Resolve the repo with \`gh repo view --json owner,name\`, then \`gh api repos/{owner}/{repo}/pulls/${pr}/comments --paginate\`. For each UNRESOLVED, non-outdated review comment make one finding: title = short summary, location = \`<path>:<line>\` (path + line/original_line), detail = the comment body, thread_id = the comment/thread id, severity = your best estimate (Critical|High|Medium|Low|Info), proposed_fix = empty. Set source = "github-pr".`,
      { label: 'gather:pr', phase: 'Gather', schema: RAW_SCHEMA },
    )))
  }
  return { gatherTasks: tasks, requestedLocators: locators }
}

const { gatherTasks, requestedLocators } = gatherPlan()
const gatherResults = await parallel(gatherTasks)   // order preserved → align with requestedLocators
const notRunSources = requestedLocators.filter((_, i) => !gatherResults[i])
if (notRunSources.length) log(`WARNING: source(s) that produced nothing: ${notRunSources.join(', ')} — the triage covers fewer sources than asked.`)
// A report's source is the engine that wrote it, as the gatherer read it; anything else is `report`. It opens
// every stable id, so a rust-audit report keeps the ids it always had.
const REPORT_SOURCES = ['review', 'adversarial-review', 'rust-audit', 'rust-reviewer', 'nix-review']
/** @param {unknown} said @returns {string} */
const reportSource = said => (typeof said === 'string' && REPORT_SOURCES.includes(said.trim()) ? said.trim() : 'report')
const gathered = gatherResults
  .map((g, i) => (g && requestedLocators[i] === 'report' ? { ...g, source: reportSource(g.source) } : g))
  .filter(g => !!g)
/** @type {SourcedFinding[]} */
const raw = gathered.flatMap(g => (Array.isArray(g.findings) ? g.findings : []).map(f => ({ ...f, source: g.source })))
log(`Gathered ${raw.length} raw finding(s) from ${gathered.length} source(s).`)

// stable composite id; reused for dedup, ledger, and idempotent re-runs
/** @param {SourcedFinding} f */
const idOf = f => `${f.source}::${f.location || 'no-loc'}::${f.title}`
// The prior ledger arrives in args, so an entry is read only as far as it is an object, its fields as text.
/** @param {unknown[]} entries @returns {Map<string, LedgerEntry>} */
function ledgerById(entries) {
  /** @type {Map<string, LedgerEntry>} */
  const byId = new Map()
  for (const e of entries) {
    if (!e || typeof e !== 'object') continue
    const x = /** @type {Record<string, unknown>} */ (e)
    byId.set(String(x['stable_id']), { stable_id: String(x['stable_id']), verdict: String(x['verdict'] ?? ''), reason: String(x['reason'] ?? ''), sifted: x['sifted'] === true })
  }
  return byId
}
const priorById = ledgerById(priorLedger)

// ---- Sift ----------------------------------------------------------------
// Before any validator: repeats in the batch collapse, and the project memory answers what it already
// settled (realm @nick/craft, node #305; the engine used to parse priorDecisions and drop them, node #306).
// The recall, the merge with the launcher's records, the matcher and its judge, the scope check and the
// rule judge are the review engine's own (nodes #203, #218, #230, #236, #273).
phase('Sift')
const collapsed = collapseRepeats(raw.map(f => siftFinding(f, idOf(f))))
const launch = readLaunch(A['priorDecisions'], false, '', undefined, parsePriorDecisions)
let priorDecisionsIn = launch.prior
let memory = launch.memory
async function recallMemory() {
  const paths = [...new Set(collapsed.kept.map(f => f.file).filter(Boolean))]
  if (!paths.length) {
    memory = { ...memory, why: 'not recalled — no gathered finding names a file' }
    return
  }
  const r = await recallDecisions(p => agent(p, { label: 'memory-recall', phase: 'Sift', schema: MEMORY_RECALL_SCHEMA, effort: 'low' }), paths, base)
  const m = mergeRecall(r, A['priorDecisions'], parsePriorDecisions)
  priorDecisionsIn = m.prior
  memory = m.memory
}
/** The batch recalled for and sifted by the records. */
async function siftBatch() {
  await recallMemory()
  for (const r of priorDecisionsIn.refused) log(`⚠️ priorDecisions: ${r}`)
  const s = await siftByMemory(
    collapsed.kept,
    priorDecisionsIn.decisions,
    toCheck => agent(scopeCheckPrompt(toCheck), { label: 'decision-scope', phase: 'Sift', schema: SCOPE_CHECK_SCHEMA, effort: 'low' }),
    prompt => agent(prompt, { label: 'decision-match', phase: 'Sift', schema: MATCH_JUDGE_SCHEMA, model: 'sonnet', effort: 'low' }),
    prompt => agent(prompt, { label: 'rule-match', phase: 'Sift', schema: RULE_JUDGE_SCHEMA, model: 'sonnet', effort: 'low' }),
  )
  for (const n of s.notes) log(`memory: ${n}`)
  return s
}
const sift = await siftBatch()
const priorRefused = [...priorDecisionsIn.refused, ...sift.refused]
/** Every ledger row the sift settled: the repeats, the set-aside findings, the conflicts. @type {LedgerEntry[]} */
const sifted = [...collapsed.repeated.map(repeatEntry), ...sift.ledger]
log(`Sifted ${sifted.length} of ${raw.length} before validation: ${collapsed.repeated.length} repeat(s), ${sift.counts['rejectedBefore']} rejected before, ${sift.counts['deferred']} deferred, ${sift.counts['covered']} under a project rule, ${sift.counts['conflict']} against memory; ${sift.counts['reraised']} raised again.`)

// ---- Validate ------------------------------------------------------------
phase('Validate')
const pin = base
  ? `Validate against ref \`${base}\` (the ref the findings were generated against), not the live working tree.`
  : 'Validate against the currently checked-out tree.'
const classOneBase = classOneBaseLine(prBase)

// The sentinel that marks a `needs-decision` nothing actually judged. It rides in the ledger entry's
// `reason` (a carry-forward prefixes that reason, so `includes` is the test, not equality) and it
// is what keeps such an entry OUT of the carry-forward set on the next run.
const UNJUDGED_MARKER = 'NOT JUDGED'

/** @type {string[]} */
const deadValidations = []
/**
 * The prior ledger's row for a finding when it settled the finding, else undefined.
 * @param {string} id @returns {LedgerEntry | undefined}
 */
function settledPrior(id) {
  const prior = priorById.get(id)
  // Idempotent re-run: carry a prior *settled* verdict rather than re-litigating it. `accept` is
  // re-validated (the code may have changed since); `conflict` is a cross-finding judgement, so it
  // is re-derived fresh in the Plan phase rather than carried as a stale solo verdict.
  if (!prior || !['reject', 'defer', 'needs-decision'].includes(prior.verdict)) return undefined
  // ...but a finding whose validator DIED is not settled — nothing judged it. Its stand-in verdict
  // is `needs-decision` (the vocabulary downstream already understands), so without this it would
  // be carried forward as settled on the next run: no agent re-opens it, `deadValidations` stays
  // empty, and run two emits no INCOMPLETE banner and no notRun entry over a finding no agent ever
  // read. The marker in the reason is what distinguishes it — a fifth verdict would have to be
  // taught to VALIDATION_SCHEMA, PLAN_SCHEMA, the plan prompt and tallyVerdicts, all of which
  // enumerate the four, and a ledger entry the tally does not know is silently uncounted.
  if (prior.reason.includes(UNJUDGED_MARKER)) return undefined
  // ...nor is a row the sift set aside (a repeat, a record's answer): no validator judged it, and what
  // settled it was the memory as it stood then. A finding here went past this run's sift — a decision
  // superseded, its scope changed since its commit (realm @nick/craft, node #309), its copy gone — so
  // carrying the old row would bury exactly what the sift raised again. The field is the test; the
  // mark in the reason covers a ledger whose rows lost the field on the way back.
  return prior.sifted || prior.reason.includes(SIFT_MARK) ? undefined : prior
}
/** One finding's verdict: carried from the prior ledger when settled there, else judged by an agent. @param {SiftFinding} f @returns {Promise<Validation>} */
function validateOne(f) {
  const id = f.stable_id
  const memoryNote = f.memoryNote.replace(/^\s*·\s*/, '')
  const prior = settledPrior(id)
  if (prior) {
    // Carried verdicts skip the agent, so they carry no fresh premise check — say so rather than
    // leaving the field undefined and letting the plan stage read it as "checked, found nothing".
    return Promise.resolve({ stable_id: id, verdict: prior.verdict, reason: `carried from prior run: ${prior.reason}`, fix_pointer: '', premise_checked: '(carried from prior run — not re-checked)' })
  }
  return /** @type {Promise<Validation | null>} */ (agent(
    `Judge ONE review finding against the actual code. ${pin}

Finding (source: ${f.source}):
- severity: ${f.severity}
- location: ${f.location || '(none given)'}
- what: ${f.title}
- why: ${f.detail}
${f.proposed_fix ? `- proposed fix: ${f.proposed_fix}` : ''}
${memoryNote ? `- project memory: ${memoryNote} — a record matched it but does not settle it; judge it on the code` : ''}

Read the cited code, then decide ONE verdict:
- accept — a real, in-scope problem. fix_pointer = owning craft skill (rust-errors/rust-ownership/rust-concurrency/rust-security/rust-performance/rust-idioms/rust-testing/rust-unsafe) + a one-line fix direction.
- reject — not a real problem / wrong; explain why (this becomes reviewer pushback).
- defer — real but out of scope now; say why.
- needs-decision — valid but needs a product/spec decision, OR the finding has no resolvable location; say what is needed.

PREMISE DISCIPLINE: name the ONE claim your verdict rests on. If it lives outside the cited location — the dependency behaves this way, this is reachable from untrusted input, a caller already guards it, the sibling path does X — OPEN that code (dependency sources included) and record the file:line in premise_checked. This binds **reject** exactly as much as accept: "a caller must already validate this" waved through without opening the caller is the same unfounded claim as the finding it dismisses, and it silently discards a real bug. If you cannot open it, do not guess — verdict needs-decision, saying which premise is unverified. ${DEPENDENCY_SOURCE_HOW}

NOISE CLASSES (noise_class; 0 when none applies — a defect of this change). They are judged on the code, never on the source's own label:
1 — not this change's: the problem already stands at the PR's base (the diff did not bring it) or lies outside the change's task. Check it AT THE BASE, not by the reviewer's word ("pre-existing", "out of scope"): ${classOneBase}. Verdict defer when the problem is real — the triage carries it to an issue; reject when it is not (no issue is filed).
2 — inflated severity: the claimed harm is unreachable or heals itself (a default requeue, only a metric). Judge the verdict on the merits and lower severity to what the code supports.
3 — a repeat of a finding already decided — reject, naming it.
4 — a deliberate trade-off written in the project's docs or rules — reject, naming where it is written.
5 — not decidable from the code (a rollout step, a version you cannot verify) — needs-decision, not a fix.
6 — an optional nicety in tests or comments — accept only when worth doing; it is planned apart from the defects.
severity: the source's severity unless the code supports another.

stable_id MUST be exactly: ${id}
Keep reason to one line. fix_pointer empty unless verdict is accept.`,
    { label: `validate:${(f.location || f.title).slice(0, 40)}`, phase: 'Validate', schema: VALIDATION_SCHEMA },
  )).then(v => {
    // A dead validator used to be dropped by `filter(Boolean)`, which removed the finding from the
    // plan AND from the ledger: a Critical whose judge died did not appear as unjudged, it appeared
    // as nothing. It is unjudged, so it becomes the verdict that already means "a human must look
    // at this" — the one downstream vocabulary (carry-forward, prompt, ledger) already understands.
    if (v) return v
    deadValidations.push(id)
    return { stable_id: id, verdict: 'needs-decision', reason: `${UNJUDGED_MARKER} — the validator agent died; this finding was never checked against the code`, fix_pointer: '', premise_checked: '(validator died — nothing was opened)' }
  })
}
// A noise class settles some verdicts (realm @nick/craft, node #303): class 1 becomes a deferral carried by an issue.
const validations = (await parallel(sift.toValidate.map(f => () => validateOne(f)))).filter(v => !!v).map(v => classifiedVerdict(v, prBase))

const accepted = validations.filter(v => v.verdict === 'accept')
log(`Validated ${validations.length}: ${accepted.length} accept, ${validations.length - accepted.length} other.`)
if (deadValidations.length) log(`WARNING: ${deadValidations.length} validator(s) died -> carried as needs-decision (unjudged), not dropped.`)

// ---- Plan ----------------------------------------------------------------
phase('Plan')
// Re-attach each accepted validation's raw finding so the planner has location/detail.
const rawById = new Map(raw.map(f => [idOf(f), f]))
const acceptedEnriched = accepted.map(v => ({ ...v, finding: rawById.get(v.stable_id) || null }))

const plan = /** @type {TriagePlan | null} */ (await agent(
  `Turn validated review findings into ONE fix plan. Do not invent findings; only organise what is given. Ignore any ACCEPTED entry whose \`finding\` is null (a data glitch) — leave it out of the plan and note it in the summary.

1. Dedup by stable_id (merge findings at the same location with the same fix).
2. Detect conflicts — two findings demanding opposite changes. Mark each such finding verdict "conflict" in the ledger, DO NOT put it in the plan, and surface both in the summary for a human to decide.
3. Group the remaining accepted findings by file; order groups blocking (Critical/High) → simple → complex, by the validator's \`severity\` (it may be lower than the source's). Accepted findings with noise_class 6 (optional, in tests or comments) go apart: one last task headed "Optional (tests and comments)", never mixed into the defect groups.
4. Render plan_markdown as a checkbox-task plan: one task per file-group, bite-sized checkbox steps, each step naming the file and the owning craft skill; a bug fix starts with a RED→GREEN regression test. Mark independent file-groups as parallelisable (one subagent per group).
5. ledger = EVERY finding (accept/reject/defer/needs-decision/conflict) keyed by stable_id with verdict + one-line reason — the SETTLED BEFORE VALIDATION rows below included, as given. Any reason containing "${UNJUDGED_MARKER}" or "${SIFT_MARK}" must be copied VERBATIM, marker included — that string is what tells a later re-run how this finding was settled; paraphrasing it makes the finding look judged on the code when it was not. summary = human-readable rundown of everything not in the plan; a deferral with action "issue" is named there as going to an issue on the forge (it is not this change's).

ACCEPTED (with their findings):
${JSON.stringify(acceptedEnriched, null, 2)}

ALL VERDICTS (include reject/defer/needs-decision in the ledger):
${JSON.stringify(validations, null, 2)}

SETTLED BEFORE VALIDATION (repeats in this batch, and what the project memory already answered — final; into the ledger as given, never into the plan):
${JSON.stringify(sifted, null, 2)}`,
  { label: 'plan', phase: 'Plan', schema: PLAN_SCHEMA },
))

// ---- Observability: persist a run record (best-effort) -------------------
// Prefer the plan's ledger (it carries the cross-finding `conflict` disposition); fall back to the
// solo validations when the Plan phase produced nothing.
/** The issue action on the rows a class-1 validation carries. @param {LedgerEntry[]} rows @returns {LedgerEntry[]} */
function withIssueActions(rows) {
  const toIssue = new Set(validations.filter(v => v.action === 'issue').map(v => v.stable_id))
  return toIssue.size ? rows.map(e => (e && toIssue.has(e.stable_id) ? { ...e, action: 'issue' } : e)) : rows
}
/**
 * The ledger the record tallies, set back on the plan when a marker had to be re-injected or an issue
 * action attached.
 * @param {TriagePlan | null} planIn @returns {LedgerEntry[]}
 */
function finalLedger(planIn) {
  if (!planIn || !Array.isArray(planIn.ledger)) return withIssueActions([...sifted, ...validations])
  const finalRows = withIssueActions(pinnedLedger(planIn.ledger))
  if (finalRows !== planIn.ledger) planIn.ledger = finalRows
  return finalRows
}
/**
 * The plan's ledger with every row this script settled itself restored: an unjudged one and a sifted one.
 * @param {LedgerEntry[]} planLedger @returns {LedgerEntry[]}
 */
function pinnedLedger(planLedger) {
  /** A pinned row's own verdict and reason, its `sifted` field and a repeat's `repeat_of` (realm @nick/craft, node #312) when it has them. @param {{ stable_id: string }} e @param {LedgerEntry} v @returns {LedgerEntry} */
  const restored = (e, v) => ({ ...e, verdict: v.verdict, reason: v.reason, ...(v.sifted ? { sifted: true } : {}), ...(v.repeat_of ? { repeat_of: v.repeat_of } : {}) })
  // The prompt above ASKS the plan agent to copy the marker verbatim; asking is not a guarantee. A
  // summarising model paraphrases a one-line free-text reason as a matter of course, and the marker
  // is the ONLY thing that tells the next run this finding was never judged: lose it and the finding
  // reads as settled forever — exactly the bug this marker exists to prevent, returning silently on
  // run three. So the script re-injects it deterministically. `validations` is the local record of
  // what each finding's verdict actually was, so a marked reason is restored (and a dropped entry
  // re-added) regardless of what the agent returned. The prompt instruction stays as belt and braces.
  // A row the sift settled is restored the same way: no validator judged it, and its mark says so.
  /** @type {Map<string, LedgerEntry>} */
  const pinned = new Map([...sifted, ...validations.filter(v => String(v.reason || '').includes(UNJUDGED_MARKER))].map(v => [v.stable_id, v]))
  if (!pinned.size) return planLedger
  /** @type {Set<string>} */
  const seen = new Set()
  const pinnedRows = planLedger.map(e => {
    const v = e && pinned.get(e.stable_id)
    if (!v) return e
    seen.add(e.stable_id)
    const mark = v.reason.includes(UNJUDGED_MARKER) ? UNJUDGED_MARKER : SIFT_MARK
    const kept = String(e.reason || '').includes(mark) && e.verdict === v.verdict && e.sifted === v.sifted && e.repeat_of === v.repeat_of
    return kept ? e : restored(e, v)
  })
  for (const [id, v] of pinned) if (!seen.has(id)) pinnedRows.push(restored({ stable_id: id }, v))
  return pinnedRows
}
const ledger = finalLedger(plan)
// Each class-1 finding as the issue the addressing-findings skill files on the consumer's forge (realm @nick/craft, node #303).
const issues = validations.filter(v => v.action === 'issue').flatMap(v => {
  const f = rawById.get(v.stable_id)
  return f ? [issueOf({ ...f, stable_id: v.stable_id }, v)] : []
})
await logRun({
  schemaVersion: 1,
  runtime: 'claude-code',
  craftVersion: CRAFT_VERSION,
  kind: 'workflow',
  name: 'triage-findings',
  verdict: '',                         // triage yields per-finding dispositions, not an Approve/Block verdict
  findings: summarizeFindings(raw),    // total findings triaged + severity mix
  nested: false,
  via: null,
  sources: gathered.map(g => ({ source: g.source, count: Array.isArray(g.findings) ? g.findings.length : 0 })),
  triage: { gathered: raw.length, validated: validations.length, ...tallyVerdicts(ledger), sifted: { repeats: collapsed.repeated.length, ...sift.counts }, issues: issues.length },
  memory: memoryRecord(memory),
  // Bare, aggregatable labels — NOT the human sentences below. `lib/analyze-runs.mjs` ranks
  // `notRun` by exact string to surface fragility that REPEATS across runs, and a note embedding a
  // count ("3 finding(s) were never judged") is unique per run: it fills the ranking with count-1
  // rows and sinks the real repeats. The sentences belong to the banner, which a person reads once.
  notRun: notRunSources.map(src => `gather:${src}`)
    .concat(deadValidations.length ? ['findings-unjudged'] : []),
})

if (!plan) return `${telemetryLostSection(telemetryLost)}Triage failed: the Plan-phase agent returned no result. Re-run, or triage the findings manually.`

/** The plan as its reader gets it: led by what did not run and by a write that did not land. @param {TriagePlan} planIn @returns {TriagePlan} */
function bannered(planIn) {
  // What did not run has to reach the READER of the plan, not just the run record. A dead `gather:pr`
  // agent means the plan covers fewer sources than were asked for, and a plan that says nothing about
  // it is indistinguishable from one that covered everything.
  const incomplete = notRunSources.map(src => `source \`${src}\` produced nothing — its findings are NOT in this plan`)
    .concat(deadValidations.length ? [`${deadValidations.length} finding(s) were never judged against the code (validator died); they sit in the ledger as needs-decision, not in the plan`] : [])
  if (incomplete.length) {
    const banner = ['> **INCOMPLETE TRIAGE** — this plan does not cover everything that was asked for:', ...incomplete.map(l => `> - ${l}`), ''].join('\n')
    planIn.plan_markdown = `${banner}\n${planIn.plan_markdown ?? ''}`
    planIn.summary = `INCOMPLETE: ${incomplete.join('; ')}\n\n${planIn.summary ?? ''}`
    planIn.notRun = incomplete
  }
  // A write that did not land leads the plan: a reader about to look this triage up in the store has
  // to learn here that it may not be there.
  const lostBanner = telemetryLostSection(telemetryLost)
  if (lostBanner) {
    planIn.plan_markdown = `${lostBanner}${planIn.plan_markdown ?? ''}`
    planIn.telemetryLost = telemetryLost.slice()
  }
  // Where the sift's records came from, what of them did not apply, and the issues to file.
  planIn.memory = memoryLine(memory, false)
  if (priorRefused.length) planIn.priorDecisionsNotApplied = priorRefused
  if (sift.notices.length) planIn.ruleNotices = sift.notices
  if (issues.length) planIn.issues = issues
  return planIn
}
return bannered(plan)
}
