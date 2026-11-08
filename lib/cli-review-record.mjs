// The run record of a cli-review run (src/cli-review.js, lib/cli-review-steps.mjs), filed through the one write path
// every engine shares (lib/run-logging.mjs) in the store's own format, so the
// run-store report (lib/analyze-runs.mjs) and the ledger readers read it as they read review's. As adversarial-review
// does: one start checkpoint once the binary has read the diff, one more as each of the binary's phases ends, then
// `finalize`, which folds them and files the run under the branch and head the first observed (lib/craft-log-run.mjs, startIdentity) — what the external-findings
// matcher selects a branch's runs by (lib/match-external-runs.mjs). The record holds what the shared readers need: the verdict, the findings counted by severity, the changed files
// no profile covered, what did not run, the round of the branch's chain and the binary's ledger: a row per reported
// finding and per prior finding the round carried, each with its disposition; and, as review's record keeps them, the
// sorting before publication, the findings going against memory and what was posted on the PR; and, in the engine's
// shape, each lens's yield (`dimensions`), the verification (`verification`), the lens rounds (`lensRounds`) as the
// binary counted them, and what the run cost as the driver observed it (`runtimeStats`, lib/cli-review-clock.mjs).
import { checkpointPrompt, makeRunLogger, quietly, telemetryLossNoter } from './run-logging.mjs'
import { telemetryLostSection } from './review-coverage.mjs'
import { fingerprint, summarizeFindings } from './run-record.mjs'
import { SERVICE_AGENT_TYPE } from './service-agent.mjs'

/** @typedef {{ severity: string, file: string, line: number, title: string, ruleId: string, tier: string }} Finding  as the finished step names it */
/** @typedef {{ file: string, line: number, symbol: string, severity: string, tier: string, disposition: string, source: string, ruleId: string, title: string, why: string, toolRule?: string, sources?: unknown[], deferral?: Record<string, unknown> }} LedgerRow  as the finished step names it */
/** @typedef {{ verdict: string, base?: string, findings?: Finding[], uncovered?: string[], notRun?: string[], round?: number, lensScope?: 'delta' | 'full', ledger?: LedgerRow[] | null, reReview?: Record<string, unknown> | null, memory?: Record<string, unknown> | null, sorting?: Record<string, unknown> | null, memoryContradictions?: Record<string, unknown> | null, prComments?: Record<string, unknown> | null, dimensions?: Record<string, unknown>[], verification?: Record<string, unknown> | null, lensRounds?: Record<string, unknown>[] | null, runtimeStats?: import('./cli-review-clock.mjs').RuntimeStats | null }} Outcome */
/** @typedef {(prompt: string, opts: Record<string, unknown>) => Promise<unknown>} Call */
/** @typedef {{ run: Call, route: (opts: Record<string, unknown>) => Record<string, unknown> }} Service  lib/service-agent.mjs */

const ENGINE = 'cli-review'
// The phase the record is written under: the engine's last.
const RECORD_PHASE = 'Record'
const START = 'start'
// Which driver ran the review, on the record and on every slice: the engine's chain readers skip a CLI run's records
// and partial directories, whose rounds the binary chains itself.
const DRIVER = 'cli'

/** What a checkpoint answers: the run directory the logger wrote it into. */
const CHECKPOINT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['runDir'],
  properties: {
    runDir: { type: 'string', description: 'the runDir the script printed; empty string if it failed' },
    error: { type: 'string', description: 'when runDir is empty, the failing line verbatim; empty otherwise' },
  },
}

/**
 * One reported finding as a ledger row, in the shape review's ledger keeps (lib/review-ledger-entry.mjs): none is
 * dispositioned, and the binary keeps no symbol or reason for the record.
 * @param {Finding} f
 */
const ledgerRow = f => ({
  fp: fingerprint(f), file: f.file, line: f.line, symbol: '', severity: f.severity, tier: f.tier, disposition: 'open',
  source: '', ruleId: f.ruleId, title: f.title, why: '',
})

/**
 * One row of the binary's ledger as the record keeps it: fingerprinted as review's rows are, its disposition the
 * binary's — `open`, `closed` for a resolved finding kept as a tombstone, or the author's word carried as it stands.
 * @param {LedgerRow} r
 */
const keptRow = r => ({ fp: fingerprint(r), ...r })

/**
 * The binary's count of the findings going against memory as the record keeps it (lib/memory-contradiction.mjs): each
 * finding fingerprinted over the fields the binary names (`key`) as its ledger row is, so analyze-runs finds it in the
 * branch's later round; null when the binary sent none.
 * @param {Record<string, unknown> | null | undefined} m @returns {Record<string, unknown> | null}
 */
function contradictionsKept(m) {
  if (!m) return null
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
 * With `comment`, the sorting before publication (lib/sorting-choice.mjs reads its doubtful findings) and what was posted
 * on the PR; on every run, the findings going against memory (realm @nick/craft, nodes #270, #281).
 * @param {Outcome} o
 */
const publicationKept = o => ({ sorting: o.sorting ?? null, memoryContradictions: contradictionsKept(o.memoryContradictions), prComments: o.prComments ?? null })

/**
 * Each lens's yield and the verification as the engine's record writes them (lib/review-ledger.mjs), counted by the
 * binary — `[]` and null when it never got that far — and the cost the driver observed.
 * @param {Outcome} o
 */
const telemetryKept = o => ({
  dimensions: o.dimensions ?? [], verification: o.verification ?? null, ...(o.lensRounds ? { lensRounds: o.lensRounds } : {}),
  runtimeStats: o.runtimeStats ?? null,
})

/**
 * The record of a run that ended with `o`. The project and the git identity are the logger script's to stamp, never
 * the record's.
 * @param {Outcome} o @param {{ craftVersion: string, depth: string, strict: boolean, outputTokens: number | null }} at
 * @returns {Record<string, unknown>}
 */
function cliRecord(o, { craftVersion, depth, strict, outputTokens }) {
  const findings = o.findings ?? []
  return {
    schemaVersion: 1, runtime: 'claude-code', craftVersion, kind: 'workflow', name: ENGINE, driver: DRIVER, nested: false, via: null,
    depth, base: o.base ?? '', verdict: o.verdict,
    // The round and the re-review summary of the binary's chain of rounds; the binary reads its own
    // round records to build the next round on, and the record keeps the same ledger for the store's readers.
    // `lensScope` as the engine's record names it (lib/review-record.mjs): a round over the fix commits alone is `delta`,
    // which the external-findings matcher does not count as coverage of the whole diff (lib/match-external-runs.mjs).
    round: o.round ?? 1, lensScope: o.lensScope ?? 'full', reReview: o.reReview ?? null,
    findings: summarizeFindings(findings), ledger: o.ledger ? o.ledger.map(keptRow) : findings.map(ledgerRow),
    uncoveredFiles: o.uncovered ?? [], notRun: o.notRun ?? [],
    ...telemetryKept(o),
    // Where the project memory the run applied came from, as the engine's record keeps it (lib/review-record.mjs; realm
    // @nick/craft, node #250): null when the binary never finished; and whether strict mode raised the maintainability bar.
    memory: o.memory ?? null, strict,
    ...publicationKept(o),
    outputTokens,
  }
}

/**
 * The record writer of one run: `at(root)` names the plugin root the logger is located in once the run has one,
 * `checkpoint(phase, figures)` writes a phase slice (the start's by default) after the slices before it, into the
 * directory the first minted, `file(outcome)` the record once they are down, and `notes()` the telemetry section the
 * answer carries when a write did not land. A lost write never fails the run.
 * @param {{ agent: Call, log: (line: string) => void, budget?: { spent: () => number } }} sb
 * @param {{ craftVersion: string, repo: string, depth: string, strict: boolean, service: Service }} o
 */
export function cliRecorder(sb, { craftVersion, repo: given, depth, strict, service }) {
  let repo = given
  let keyed = !!given
  /** @type {string[]} */
  const lost = []
  const noteLoss = telemetryLossNoter(lost, sb.log)
  let craftRoot = ''
  let runDir = ''
  // Asked once a slice failed while the run had no directory, so a later one re-enters the directory this run may
  // already have rather than mint another (the engine's rejoin, lib/review-run-telemetry.mjs); sticky, for finalize.
  let failed = false
  let rejoin = false
  /** @type {Promise<void>} the slices written so far, each after the one before */
  let slices = Promise.resolve()
  const logRun = makeRunLogger({
    // service.route: once the service agent failed to launch, the record's first ask goes to the default type too.
    call: quietly((/** @type {string} */ prompt, /** @type {Record<string, unknown>} */ opts) => sb.agent(prompt, service.route(opts))),
    serviceAgent: true, phase: RECORD_PHASE, noteLoss,
    target: () => ({ craftRoot, repo, command: 'finalize', dir: runDir, rejoin }),
  })
  /** @param {string} slice  the phase it is a checkpoint of @param {Record<string, unknown>} figures */
  async function write(slice, figures) {
    const payload = { kind: 'workflow', name: ENGINE, driver: DRIVER, craftVersion, phase: slice, ...figures }
    const armed = !runDir && failed
    rejoin ||= armed
    const res = /** @type {{ runDir?: string, error?: string, __threw?: string } | null} */ (await quietly(service.run)(
      checkpointPrompt({ payload, craftRoot, repo, phase: slice, dir: runDir, rejoin: armed }),
      { label: `checkpoint:${slice}`, phase: slice === START ? 'Start' : 'Agents', schema: CHECKPOINT_SCHEMA, model: 'haiku', effort: 'low', agentType: SERVICE_AGENT_TYPE },
    ))
    if (res?.runDir) runDir = res.runDir
    else lostSlice(slice, res)
  }
  /** @param {string} slice @param {{ error?: string, __threw?: string } | null} res */
  function lostSlice(slice, res) {
    failed = true
    noteLoss(`phase checkpoint '${slice}'`, res?.__threw || res?.error || 'the logger agent returned no runDir', false)
  }
  /** @param {string} [slice] @param {Record<string, unknown>} [figures] @returns {Promise<void>} */
  const checkpoint = (slice = START, figures = {}) => (slices = slices.then(() => write(slice, figures)))
  /** @param {Outcome} outcome */
  const file = async outcome => {
    await slices
    return logRun(cliRecord(outcome, { craftVersion, depth, strict, outputTokens: sb.budget?.spent() ?? null }))
  }
  // keyTo: the repository the run reviews, when the binary names it (a resumed run, `run=`), over the one given;
  // keyed: whether the record has a repository of its own, given or named.
  return { at: (/** @type {string} */ root) => { craftRoot = root }, keyTo: (/** @type {string} */ r) => { repo = r; keyed = true }, keyed: () => keyed, checkpoint, file, notes: () => telemetryLostSection(lost) }
}
