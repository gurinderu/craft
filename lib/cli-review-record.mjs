// The run record of a cli-review run (src/cli-review.js, lib/cli-review-steps.mjs), filed through the one write path
// every engine shares (lib/run-logging.mjs) in the store's own format, so the
// run-store report (lib/analyze-runs.mjs) and the ledger readers read it as they read review's. As adversarial-review
// does: one start checkpoint once the binary has read the diff, then `finalize`, which folds it and files the run
// under the branch and head that checkpoint observed (lib/craft-log-run.mjs, startIdentity) — what the external-findings
// matcher selects a branch's runs by (lib/match-external-runs.mjs). The record holds what the shared readers need: the verdict, the findings counted by severity, the changed files
// no profile covered, what did not run, the round of the branch's chain and the binary's ledger: a row per reported
// finding and per prior finding the round carried, each with its disposition.
import { checkpointPrompt, makeRunLogger, quietly, telemetryLossNoter } from './run-logging.mjs'
import { telemetryLostSection } from './review-coverage.mjs'
import { fingerprint, summarizeFindings } from './run-record.mjs'
import { SERVICE_AGENT_TYPE } from './service-agent.mjs'

/** @typedef {{ severity: string, file: string, line: number, title: string, ruleId: string, tier: string }} Finding  as the finished step names it */
/** @typedef {{ file: string, line: number, symbol: string, severity: string, tier: string, disposition: string, source: string, ruleId: string, title: string, why: string, toolRule?: string, sources?: unknown[] }} LedgerRow  as the finished step names it */
/** @typedef {{ verdict: string, base?: string, findings?: Finding[], uncovered?: string[], notRun?: string[], round?: number, lensScope?: 'delta' | 'full', ledger?: LedgerRow[] | null, reReview?: Record<string, unknown> | null }} Outcome */
/** @typedef {(prompt: string, opts: Record<string, unknown>) => Promise<unknown>} Call */
/** @typedef {{ run: Call, route: (opts: Record<string, unknown>) => Record<string, unknown> }} Service  lib/service-agent.mjs */

const ENGINE = 'cli-review'
// The phase the record is written under: the engine's last.
const RECORD_PHASE = 'Record'
const START = 'start'

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
 * The record of a run that ended with `o`. The project and the git identity are the logger script's to stamp, never
 * the record's.
 * @param {Outcome} o @param {{ craftVersion: string, depth: string, outputTokens: number | null }} at
 * @returns {Record<string, unknown>}
 */
function cliRecord(o, { craftVersion, depth, outputTokens }) {
  const findings = o.findings ?? []
  return {
    schemaVersion: 1, runtime: 'claude-code', craftVersion, kind: 'workflow', name: ENGINE, nested: false, via: null,
    depth, base: o.base ?? '', verdict: o.verdict,
    // The round and the re-review summary of the binary's chain of rounds; the binary reads its own
    // round records to build the next round on, and the record keeps the same ledger for the store's readers.
    // `lensScope` as the engine's record names it (lib/review-record.mjs): a round over the fix commits alone is `delta`,
    // which the external-findings matcher does not count as coverage of the whole diff (lib/match-external-runs.mjs).
    round: o.round ?? 1, lensScope: o.lensScope ?? 'full', reReview: o.reReview ?? null,
    findings: summarizeFindings(findings), ledger: o.ledger ? o.ledger.map(keptRow) : findings.map(ledgerRow),
    uncoveredFiles: o.uncovered ?? [], notRun: o.notRun ?? [], dimensions: [], verification: null,
    outputTokens,
  }
}

/**
 * The record writer of one run: `at(root)` names the plugin root the logger is located in once the run has one,
 * `checkpoint()` writes the start slice, `file(outcome)` the record, and `notes()` the telemetry section the
 * answer carries when a write did not land. A lost write never fails the run.
 * @param {{ agent: Call, log: (line: string) => void, budget?: { spent: () => number } }} sb
 * @param {{ craftVersion: string, repo: string, depth: string, service: Service }} o
 */
export function cliRecorder(sb, { craftVersion, repo, depth, service }) {
  /** @type {string[]} */
  const lost = []
  const noteLoss = telemetryLossNoter(lost, sb.log)
  let craftRoot = ''
  let runDir = ''
  const logRun = makeRunLogger({
    // service.route: once the service agent failed to launch, the record's first ask goes to the default type too.
    call: quietly((/** @type {string} */ prompt, /** @type {Record<string, unknown>} */ opts) => sb.agent(prompt, service.route(opts))),
    serviceAgent: true, phase: RECORD_PHASE, noteLoss,
    target: () => ({ craftRoot, repo, command: 'finalize', dir: runDir }),
  })
  async function checkpoint() {
    const payload = { kind: 'workflow', name: ENGINE, craftVersion, phase: START }
    const res = /** @type {{ runDir?: string, error?: string, __threw?: string } | null} */ (await quietly(service.run)(
      checkpointPrompt({ payload, craftRoot, repo, phase: START }),
      { label: `checkpoint:${START}`, phase: 'Start', schema: CHECKPOINT_SCHEMA, model: 'haiku', effort: 'low', agentType: SERVICE_AGENT_TYPE },
    ))
    if (res?.runDir) runDir = res.runDir
    else noteLoss(`phase checkpoint '${START}'`, res?.__threw || res?.error || 'the logger agent returned no runDir', false)
  }
  /** @param {Outcome} outcome */
  const file = outcome => logRun(cliRecord(outcome, { craftVersion, depth, outputTokens: sb.budget?.spent() ?? null }))
  return { at: (/** @type {string} */ root) => { craftRoot = root }, checkpoint, file, notes: () => telemetryLostSection(lost) }
}
