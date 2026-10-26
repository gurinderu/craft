// The review engine's run (src/review.js), opened once before the Scout phase: its options, its one dispatch
// path, its telemetry and the wrapper every report goes out through. The phases take what they need of it.
import { reviewVerdict } from './run-record.mjs'
import { readReviewArgs } from './review-run-args.mjs'
import { makeLensTallies } from './review-lens-tallies.mjs'
import { announceDeadlineOverride } from './review-deadlines.mjs'
import { makeReviewAgent } from './review-run-agent.mjs'
import { makeRunTelemetry } from './review-run-telemetry.mjs'
import { makeRunReport } from './review-run-report.mjs'

/**
 * The Workflow sandbox's globals the review takes (lib/workflow-sandbox.d.ts), handed in by the engine: lib/
 * code never names them free.
 * @typedef {{ args: unknown, agent: (prompt: string, opts?: import('./review-run-agent.mjs').AgentOptions) => Promise<unknown>,
 *   parallel: <T>(thunks: Array<() => T | Promise<T>>) => Promise<Array<Awaited<T> | null>>, phase: (title: string) => void,
 *   log: (message: string) => void, budget: { total: number | null, spent(): number, remaining(): number } }} Sandbox
 * @typedef {import('./review-schemas.mjs').Finding} Finding
 * @typedef {import('./profile-merge.mjs').ProfileResult} ProfileResult
 * @typedef {ReturnType<typeof openReviewRun>} ReviewRun
 */

/**
 * @param {Sandbox} sb @param {string} craftVersion  the engine's release stamp
 * @param {ProfileResult[]} results  the per-profile results the engine fills as the profiles run
 */
export function openReviewRun(sb, craftVersion, results) {
const { log: logLine } = sb
const opts = readReviewArgs(sb.args, logLine, craftVersion)
const { strict } = opts
const tallies = makeLensTallies(opts.optionalRequested, results)
// Severity ordering, worst first.
/** @type {Record<string, number>} */
const SEV_RANK = { Critical: 0, High: 1, Medium: 2, Low: 3, Info: 4 }
announceDeadlineOverride(opts.deadlineArg, logLine)
const dispatch = makeReviewAgent({ runAgent: sb.agent, logLine, repoArg: opts.repoArg, deadlineArg: opts.deadlineArg })

// finalVerdict is workflow-local — NOT part of lib/run-record.mjs.
// In strict mode the maintainability bar is a presumption of block: any Confirmed
// maintainability finding at Medium or above escalates the verdict to Block. Outside strict mode
// the base verdict stands (maintainability findings are at most a Warning).
// A finding counts as maintainability for the strict escalation if its own source is maintainability
// OR a maintainability finding was merged into it during cross-lens dedup (dedupPool carries every
// contributing source in `sources`). Without the second clause a maintainability finding absorbed
// under a same-severity non-maintainability base would silently escape the strict Block.
/** @param {Finding} f */
function isMaintainability(f) {
  return (f['source'] || '') === 'maintainability' || (Array.isArray(f['sources']) && /** @type {unknown[]} */ (f['sources']).includes('maintainability'))
}
/** @param {Finding[]} confirmedIn */
function finalVerdict(confirmedIn) {
  if (strict && confirmedIn.some(f => isMaintainability(f)
    && (f['severity'] === 'Critical' || f['severity'] === 'High' || f['severity'] === 'Medium'))) return 'Block'
  return reviewVerdict(confirmedIn)
}
const telemetry = makeRunTelemetry({ logLine, ragentQuietly: dispatch.ragentQuietly, splitThrew: dispatch.splitThrew, craftRootArg: opts.craftRootArg, repoArg: opts.repoArg, craftVersion })
const report = makeRunReport({ opts, tallies, limitStop: dispatch.limitStop, telemetryLost: telemetry.telemetryLost, craftVersion })

/** @param {Finding} f */
function key(f) {
  return `${(f['file'] || '').toLowerCase()}:${f['line'] || 0}:${(f['title'] || '').toLowerCase().replace(/\s+/g, ' ').trim()}`
}
return {
  sb, craftVersion, SEV_RANK, isMaintainability, finalVerdict, key,
  A: opts.A, baseArg: opts.baseArg, intentArg: opts.intentArg, postComments: opts.postComments, pathArg: opts.pathArg, repoArg: opts.repoArg,
  ambiguousPath: opts.ambiguousPath, scopeNotRun: opts.scopeNotRun, scopeSection: opts.scopeSection, craftRootArg: opts.craftRootArg,
  loggerPreludeNow: opts.loggerPreludeNow, LOGGER_PATH: opts.LOGGER_PATH, viaArg: opts.viaArg, strict, recalledByLauncher: opts.recalledByLauncher,
  requestedLangs: opts.requestedLangs, freshArg: opts.freshArg, fullEvery: opts.fullEvery, reviewDepth: opts.reviewDepth, lightPass: opts.lightPass,
  extraLensRequest: opts.extraLensRequest, lightSkippedLenses: opts.lightSkippedLenses, lightKeptLenses: opts.lightKeptLenses,
  extraLensOutcome: opts.extraLensOutcome, optionalRequested: opts.optionalRequested,
  ...tallies,
  REPO_DIRECTIVE: dispatch.REPO_DIRECTIVE, limitStop: dispatch.limitStop, ragent: dispatch.ragent, ragentQuietly: dispatch.ragentQuietly, splitThrew: dispatch.splitThrew,
  telemetryLost: telemetry.telemetryLost, noteTelemetryLoss: telemetry.noteTelemetryLoss, checkpoint: telemetry.checkpoint, logRun: telemetry.logRun,
  reviewerAgentUnavailable: report.reviewerAgentUnavailable, noteReviewerAgentMissing: report.noteReviewerAgentMissing,
  reviewerAgentFallbacks: report.reviewerAgentFallbacks, reviewerAgentNames: report.reviewerAgentNames,
  noteReviewerAgentFallback: report.noteReviewerAgentFallback, noteReviewerAgentNotFound: report.noteReviewerAgentNotFound,
  out: report.out, extraLensGaps: report.extraLensGaps, extraLensesNotRun: report.extraLensesNotRun, depthRecordFields: report.depthRecordFields,
  get memory() { return opts.memory },
  set memory(v) { opts.memory = v },
  get priorDecisionsIn() { return opts.priorDecisionsIn },
  set priorDecisionsIn(v) { opts.priorDecisionsIn = v },
  get lensPhaseReached() { return opts.lensPhaseReached },
  set lensPhaseReached(v) { opts.lensPhaseReached = v },
  get reReviewMemoryNote() { return report.reReviewMemoryNote },
  set reReviewMemoryNote(v) { report.reReviewMemoryNote = v },
  get active() { return report.active },
  set active(v) { report.active = v },
  get startHead() { return telemetry.startHead },
  set startHead(v) { telemetry.startHead = v },
  get rejoinArmed() { return telemetry.rejoinArmed },
}
}
