// The run record of a review run (integrations/claude-code/src/review.js, integrations/shared/cli-review-steps.mjs) in the store's own format, so the
// run-store report (integrations/shared/analyze-runs.mjs) and the ledger readers read it as they read review's. The `craft` binary
// files it itself (realm @nick/craft, nodes #456, #539) with its own store writer (cli/crates/craft-store), which builds
// the checkpoints and the record as this file does and writes them as integrations/shared/craft-log-run.mjs does
// (content/parity/store-cases.json, written from integrations/shared/binary-filing-replay.mjs, holds the two together): one start checkpoint once the binary has
// read the diff, one more as each of its phases ends, then `finalize`, which folds them and files the run under the
// branch and head the first observed (integrations/shared/craft-log-run.mjs, startIdentity) — what the external-findings
// matcher selects a branch's runs by (integrations/shared/match-external-runs.mjs). The driver files through a logger agent only the
// record of a run the binary never finished, and an argument's refusal. The record holds what the shared readers need: the verdict, the findings counted by severity, the changed files
// no profile covered, what did not run, the round of the branch's chain and the binary's ledger: a row per reported
// finding and per prior finding the round carried, each with its disposition; and, as review's record keeps them, the
// sorting before publication, the findings going against memory and what was posted on the PR; and, in the engine's
// shape, each lens's yield (`dimensions`), the verification (`verification`), the lens rounds (`lensRounds`) and what their yield leaves beside them (`seedYield`, `unattributedYield`,
// `unattributedConfirmed`) as the
// binary counted them, and what the run cost as the driver observed it (`runtimeStats`, integrations/shared/cli-review-clock.mjs).
import { makeRunLogger, quietly, telemetryLossNoter } from './run-logging.mjs'
import { telemetryLostSection } from './review-coverage.mjs'
import { fingerprint, summarizeFindings, scopedTokens, tokensScope } from './run-record.mjs'
import { resumeHint } from './cli-review-verdict.mjs'

/** @typedef {{ severity: string, file: string, line: number, title: string, ruleId: string, tier: string }} Finding  as the finished step names it */
/** @typedef {{ file: string, line: number, symbol: string, severity: string, tier: string, disposition: string, source: string, ruleId: string, title: string, why: string, toolRule?: string, sources?: unknown[], deferral?: Record<string, unknown> }} LedgerRow  as the finished step names it */
/** @typedef {{ verdict: string, run?: string, base?: string, path?: string, findings?: Finding[], uncovered?: string[], notRun?: string[], capped?: string[], round?: number, lensScope?: 'delta' | 'full', ledger?: LedgerRow[] | null, reReview?: Record<string, unknown> | null, memory?: Record<string, unknown> | null, sorting?: Record<string, unknown> | null, memoryContradictions?: Record<string, unknown> | null, prComments?: Record<string, unknown> | null, dimensions?: Record<string, unknown>[], verification?: Record<string, unknown> | null, lensRounds?: Record<string, unknown>[] | null, seedYield?: Record<string, unknown> | null, unattributedYield?: Record<string, unknown> | null, unattributedConfirmed?: number | null, runtimeStats?: import('./cli-review-clock.mjs').RuntimeStats | null }} Outcome */
/** @typedef {(prompt: string, opts: Record<string, unknown>) => Promise<unknown>} Call */
/** @typedef {{ run: Call, route: (opts: Record<string, unknown>) => Record<string, unknown> }} Service  integrations/shared/service-agent.mjs */

const ENGINE = 'review'
// The phase the record is written under: the engine's last.
const RECORD_PHASE = 'Record'
// Which driver ran the review, on the record and on every slice: the engine's chain readers skip a CLI run's records
// and partial directories, whose rounds the binary chains itself.
const DRIVER = 'cli'

/**
 * One reported finding as a ledger row, in the shape review's ledger keeps (integrations/shared/review-ledger-entry.mjs): none is
 * dispositioned, and the binary keeps no symbol or reason for the record.
 * @param {Finding} f
 */
const ledgerRow = f => ({
  fp: fingerprint(f),
  file: f.file,
  line: f.line,
  symbol: '',
  severity: f.severity,
  tier: f.tier,
  disposition: 'open',
  source: '',
  ruleId: f.ruleId,
  title: f.title,
  why: '',
})

/**
 * One row of the binary's ledger as the record keeps it: fingerprinted as review's rows are, its disposition the
 * binary's — `open`, `closed` for a resolved finding kept as a tombstone, or the author's word carried as it stands.
 * @param {LedgerRow} r
 */
const keptRow = r => ({ fp: fingerprint(r), ...r })

/**
 * The binary's count of the findings going against memory as the record keeps it (integrations/shared/memory-contradiction.mjs): each
 * finding fingerprinted over the fields the binary names (`key`) as its ledger row is, so analyze-runs finds it in the
 * branch's later round; null when the binary sent none.
 * @param {Record<string, unknown> | null | undefined} m @returns {Record<string, unknown> | null}
 */
function contradictionsKept(m) {
  if (!m) return null
  /** @type {unknown[]} */
  const items = Array.isArray(m['findings']) ? m['findings'] : []
  return {
    ...m,
    findings: items.map(i => {
      const { key, ...rest } = /** @type {Record<string, unknown>} */ (i && typeof i === 'object' ? i : {})
      return { fp: fingerprint(/** @type {import('./run-record.mjs').FindingKey} */ (key && typeof key === 'object' ? key : {})), ...rest }
    }),
  }
}

/**
 * With `comment`, the sorting before publication (integrations/shared/sorting-choice.mjs reads its doubtful findings) and what was posted
 * on the PR; on every run, the findings going against memory (realm @nick/craft, nodes #270, #281).
 * @param {Outcome} o
 */
export const publicationKept = o => ({
  sorting: o.sorting ?? null,
  memoryContradictions: contradictionsKept(o.memoryContradictions),
  prComments: o.prComments ?? null,
})

/**
 * What the run left unreviewed: the files no profile covered, what did not run, and the coverage gaps apart from it,
 * which no reader takes for INCOMPLETE — only when there are any (cli/crates/craft-review/src/report/gap_cap.rs; realm
 * @nick/craft, node #541).
 * @param {Outcome} o
 */
const holesKept = o => ({
  uncoveredFiles: o.uncovered ?? [],
  notRun: o.notRun ?? [],
  ...(o.capped?.length ? { capped: o.capped } : {}),
})

/**
 * Each lens's yield and the verification as the engine's record writes them (integrations/shared/review-ledger.mjs), counted by the
 * binary — `[]` and null when it never got that far — and the cost the driver observed.
 * @param {Outcome} o
 */
const telemetryKept = o => ({
  dimensions: o.dimensions ?? [],
  verification: o.verification ?? null,
  ...(o.lensRounds ? { lensRounds: o.lensRounds } : {}),
  ...(o.seedYield ? { seedYield: o.seedYield } : {}),
  ...(o.unattributedYield ? { unattributedYield: o.unattributedYield } : {}),
  ...(o.unattributedConfirmed != null ? { unattributedConfirmed: o.unattributedConfirmed } : {}),
  runtimeStats: o.runtimeStats ?? null,
})

/**
 * What change the run reviewed: its base, and the directory a `path=` run was confined to, '' for the whole change —
 * the pre-PR check counts only the latter (cli/bin/craft/src/hook/counts.rs; realm @nick/craft, node #541).
 * @param {Outcome} o
 */
const changeKept = o => ({ base: o.base ?? '', path: o.path ?? '' })

/** The host a run's tasks ran in, as the record names it: Claude Code when none was named. @param {string | undefined} r */
const hostOf = r => r || 'claude-code'

// The order the engines set a memory source's keys in (`readMemoryRecall`, `acceptedMemory`, `withPassed`, `withDerived`
// in integrations/shared/memory-recall.mjs, then a launcher's degraded recall as rust-audit notes it): a record keeps it
// whatever order the binary's step gave them, as the Rust writer does (cli/crates/craft-store/src/memory.rs; realm
// @nick/craft, node #250).
const MEMORY_ORDER = [
  'source',
  'count',
  'why',
  'recallDied',
  'backend',
  'externals',
  'queryError',
  'truncated',
  'questions',
  'rules',
  'passed',
  'added',
  'derived',
  'recallDegraded',
]

/**
 * A memory object with its keys in the engines' order, any other named key after them as it came (index keys lead, as
 * JavaScript orders them); anything else null, as the Rust writer keeps it.
 * @param {unknown} m @returns {Record<string, unknown> | null}
 */
function orderedMemory(m) {
  if (!m || typeof m !== 'object' || Array.isArray(m)) return null
  const o = /** @type {Record<string, unknown>} */ (m)
  /** @type {Record<string, unknown>} */
  const out = {}
  for (const k of MEMORY_ORDER) if (Object.hasOwn(o, k)) out[k] = o[k]
  for (const [k, v] of Object.entries(o)) if (!Object.hasOwn(out, k)) out[k] = v
  return out
}

/**
 * The record of a run that ended with `o`. The project and the git identity are the logger script's to stamp, never
 * the record's. A run a parent engine launched (`_via`, as rust-audit launches its per-crate reviews) is filed nested,
 * naming the parent. Its `runtime` is the host its tasks ran in: `craft review run`'s backend (codex, pi, opencode),
 * else Claude Code, whose engine drives the binary itself.
 * @param {Outcome} o @param {{ craftVersion: string, depth: string, strict: boolean, via: string | null, outputTokens: number | null, outputTokensScope?: string, runtime?: string }} at
 *   outputTokensScope: what outputTokens counts (`turn-delta`), on the record only when named
 * @returns {Record<string, unknown>}
 */
export function cliRecord(o, { craftVersion, depth, strict, via, outputTokens, outputTokensScope, runtime }) {
  const findings = o.findings ?? []
  return {
    schemaVersion: 1,
    runtime: hostOf(runtime),
    craftVersion,
    kind: 'workflow',
    name: ENGINE,
    driver: DRIVER,
    // The binary's run directory: a run stopped and resumed files a record per part, each naming it, which the store's
    // readers fold into the run's finished record (integrations/shared/run-duplicates.mjs; cli/crates/craft-store/src/parts.rs).
    cliRun: o.run ?? '',
    nested: via !== null,
    via,
    depth,
    ...changeKept(o),
    verdict: o.verdict,
    // The round and the re-review summary of the binary's chain of rounds; the binary reads its own
    // round records to build the next round on, and the record keeps the same ledger for the store's readers — on the
    // binary's own filing path (cli/crates/craft-store); the host is printed no ledger (realm @nick/craft, node #522).
    // `lensScope` as the engine's record names it (integrations/shared/review-record.mjs): a round over the fix commits alone is `delta`,
    // which the external-findings matcher does not count as coverage of the whole diff (integrations/shared/match-external-runs.mjs).
    round: o.round ?? 1,
    lensScope: o.lensScope ?? 'full',
    reReview: o.reReview ?? null,
    findings: summarizeFindings(findings),
    ledger: o.ledger ? o.ledger.map(keptRow) : findings.map(ledgerRow),
    ...holesKept(o),
    ...telemetryKept(o),
    // Where the project memory the run applied came from, as the engine's record keeps it (integrations/shared/review-record.mjs; realm
    // @nick/craft, node #250): null when the binary never finished; and whether strict mode raised the maintainability bar.
    memory: orderedMemory(o.memory),
    strict,
    ...publicationKept(o),
    outputTokens,
    ...tokensScope(outputTokens, outputTokensScope),
  }
}

/** @typedef {import('./cli-review-step.mjs').Step} Step */

/**
 * Each write the binary's telemetry after `step` could not land, kept in `lost` and logged.
 * @param {Step} step @param {string[]} lost @param {(line: string) => void} say
 */
export const heardLosses = (step, lost, say) => toldLosses(step.filing?.lost ?? [], lost, say)

/**
 * Each write `lines` says did not land, kept in `lost` and logged.
 * @param {string[]} lines @param {string[]} lost @param {(line: string) => void} say
 */
function toldLosses(lines, lost, say) {
  for (const line of lines) {
    lost.push(line)
    say(`⚠️ telemetry: ${line}`)
  }
}

/**
 * The notes a finished run's answer carries: the telemetry section, and — when the binary did not file the record —
 * how to file it again, through the driver (`driver`, as resumeHint names it; by default the Workflow).
 * @param {Step & { done: true }} finished @param {string[]} lost @param {(what: string, why: string, landed: boolean) => void} noteLoss
 * @param {string} [driver] @returns {string}
 */
export function settledNotes(finished, lost, noteLoss, driver) {
  const record = finished.filing?.record ?? ''
  if (record === 'filed') return telemetryLostSection(lost)
  // Absence is said, never left to be inferred (realm @nick/craft, node #40): a binary that wrote nothing, or
  // attempted no record, is a lost record too.
  if (record !== 'failed')
    noteLoss('the run record', finished.filing ? 'the craft binary attempted no record' : 'the craft binary reported no telemetry write', false)
  return `${telemetryLostSection(lost)}The run record can be filed again: ${resumeHint(finished.run, driver).replace(/^To resume it once agents can answer again: /, '')}`
}

/**
 * The driver's side of a run's telemetry: `at(root)` names the plugin root the logger is located in once the run has
 * one; `heard(step)` takes what the binary's own write after that step did — its run directory and every write that
 * did not land; `told(lines)` writes said lost where no step was read (a brief status); `settled(finished)` the notes a finished run's answer carries, saying aloud a record the binary did
 * not file; `missing(why)` those of a run whose record no one can file; `file(outcome)` files the record of a run the binary never finished into the directory its checkpoints
 * went to, `refusal(record)` a refused argument's record as it stands, and `notes()` the telemetry section the answer
 * carries when a write did not land. A lost write never fails the run.
 * @param {{ agent: Call, log: (line: string) => void, budget?: { spent: () => number | null } }} sb
 * @param {{ craftVersion: string, repo: string, run?: string, depth: string, strict: boolean, via?: string, service: Service }} o  run: the run directory a resume names
 */
export function cliRecorder(sb, { craftVersion, repo: given, run = '', depth, strict, via = '', service }) {
  let repo = given
  let keyed = !!given
  /** @type {string[]} */
  const lost = []
  const noteLoss = telemetryLossNoter(lost, sb.log)
  let craftRoot = ''
  // Where the binary's checkpoints went and whether a write re-enters that directory, as its last step said.
  let filing = { runDir: '', rejoin: false }
  // What the binary last said of the run — its directory, its round of the chain, what its lenses review, its base and
  // path — for the record of a run it never finished; a resume's directory before any step is read.
  /** @type {Partial<Outcome>} */
  let seen = run ? { run } : {}
  const logRun = makeRunLogger({
    // service.route: once the service agent failed to launch, the record's first ask goes to the default type too.
    call: quietly((/** @type {string} */ prompt, /** @type {Record<string, unknown>} */ opts) => sb.agent(prompt, service.route(opts))),
    serviceAgent: true,
    phase: RECORD_PHASE,
    noteLoss,
    target: () => ({ craftRoot, repo, command: 'finalize', dir: filing.runDir, rejoin: filing.rejoin }),
  })
  /** @param {Step} step */
  function heard(step) {
    if (step.filing) filing = step.filing
    seen = { run: step.run, round: step.round, lensScope: step.lensScope, base: step.base, path: step.path }
    heardLosses(step, lost, sb.log)
  }
  /** @param {Step & { done: true }} finished @returns {string} */
  const settled = finished => settledNotes(finished, lost, noteLoss)
  /** The notes of a run whose record no one can file, saying why. @param {string} why @returns {string} */
  function missing(why) {
    noteLoss('the run record', why, false)
    return telemetryLostSection(lost)
  }
  /** @param {Outcome} outcome */
  const file = outcome =>
    logRun(cliRecord({ ...seen, ...outcome }, { craftVersion, depth, strict, via: via || null, ...scopedTokens(sb.budget?.spent() ?? null) }))
  // keyTo: the repository the run reviews, when the binary names it (a resumed run, `run=`), over the one given;
  // keyed: whether the record has a repository of its own, given or named.
  return {
    at: (/** @type {string} */ root) => {
      craftRoot = root
    },
    keyTo: (/** @type {string} */ r) => {
      repo = r
      keyed = true
    },
    keyed: () => keyed,
    heard,
    told: (/** @type {string[]} */ lines) => toldLosses(lines, lost, sb.log),
    settled,
    missing,
    file,
    refusal: (/** @type {Record<string, unknown>} */ record) => logRun({ ...record, driver: DRIVER }),
    notes: () => telemetryLostSection(lost),
  }
}
