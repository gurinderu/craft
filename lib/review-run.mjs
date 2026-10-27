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
 * What the review's phases hand each other after the profiles ran, by name; each phase takes the part it reads.
 * @typedef {{ confirmed: Finding[], suspected: Finding[], unverified: Finding[] }} Tiers
 * @typedef {ReturnType<typeof import('./review-prior-basis.mjs').priorBasisPhase>} Basis
 * @typedef {Extract<Awaited<ReturnType<typeof import('./review-coverage-phase.mjs').coveragePhase>>, { exit: null }>} Coverage
 * @typedef {ReturnType<typeof import('./review-record.mjs').makeRunRecord>} Merge
 * @typedef {Awaited<ReturnType<typeof import('./review-adjudicate-priors.mjs').adjudicatePhase>>} Adjudication
 * @typedef {Extract<Awaited<ReturnType<typeof import('./review-set-aside.mjs').setAsidePhase>>, { exit: null }>} SetAside
 * @typedef {Awaited<ReturnType<typeof import('./review-synthesis.mjs').synthesisPhase>>} Synthesis
 * @typedef {Awaited<ReturnType<typeof import('./review-sorting.mjs').sortingPhase>>} Sorting
 * @typedef {Awaited<ReturnType<typeof import('./review-ledger.mjs').ledgerPhase>>} Ledger
 * @typedef {{
 *   tierLists: Tiers, results: import('./review-profile.mjs').ProfileReview[], active: import('./review-profiles.mjs').Profile[],
 *   branch: string, head: string, baseRef: string, spec: string, changedFiles: string[],
 *   priorRound: import('./review-schemas.mjs').PriorRoundAnswer | null, reReview: ReturnType<typeof import('./run-record.mjs').reReviewMemory>,
 *   thisRound: Basis['thisRound'], priorBasisMismatch: Basis['priorBasisMismatch'], basisOverridesLogger: Basis['basisOverridesLogger'],
 *   priorFpComparable: Basis['priorFpComparable'], priorBasisVerdict: Basis['priorBasisVerdict'], priorLedgerDegraded: Basis['priorLedgerDegraded'],
 *   priorRoundJournalSourced: Basis['priorRoundJournalSourced'], fullRescan: Basis['fullRescan'],
 *   uncoveredFiles: string[], uncoveredGap: Coverage['uncoveredGap'], tombstonesDroppedForBasis: () => number,
 *   mergedProvenance: Merge['mergedProvenance'], mergedGateStatus: Merge['mergedGateStatus'], carriedSection: Merge['carriedSection'],
 *   carriedLine: Merge['carriedLine'], reviewRecord: Merge['reviewRecord'],
 *   adjudicated: Adjudication['adjudicated'], priorTombstones: Adjudication['priorTombstones'], carriedDeferred: Adjudication['carriedDeferred'],
 *   priorRejected: SetAside['priorRejected'], priorRejectedLive: SetAside['priorRejectedLive'], priorDisposition: SetAside['priorDisposition'],
 *   ruleNotices: SetAside['ruleNotices'], dropped: SetAside['dropped'], thinned: SetAside['thinned'], notRun: SetAside['notRun'],
 *   savedByFloor: SetAside['savedByFloor'], coverageNotes: SetAside['coverageNotes'], incompleteNotes: SetAside['incompleteNotes'], criticNotes: SetAside['criticNotes'],
 *   report: Synthesis['report'], isRereview: Synthesis['isRereview'], synthesisUnusable: Synthesis['synthesisUnusable'],
 *   sortingRecord: Sorting['sortingRecord'], contradictionsRecord: Sorting['contradictionsRecord'], doubtfulReport: Sorting['doubtfulReport'],
 *   recordVerdict: Ledger['recordVerdict'], floorPremiseHeld: Ledger['floorPremiseHeld'],
 * }} ReviewState
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
  // unitScope (realm @nick/craft, #324) and, per profile it ran on, what it did — for the run record.
  unitScope: opts.unitScope, unitBatches: opts.unitBatches, unitBatchBudget: opts.unitBatchBudget, unitAgentCeiling: opts.unitAgentCeiling, costModelArg: opts.costModelArg, deadlineArg: opts.deadlineArg, unitRuns: /** @type {import('./review-unit-scope.mjs').UnitRun[]} */ ([]),
  // A run that asked for unitScope and did not get it on a profile: one line each, for the report (realm #362).
  unitNotices: /** @type {string[]} */ ([]),
  requestedLangs: opts.requestedLangs, freshArg: opts.freshArg, fullEvery: opts.fullEvery, reviewDepth: opts.reviewDepth, lightPass: opts.lightPass,
  extraLensRequest: opts.extraLensRequest, lightSkippedLenses: opts.lightSkippedLenses, lightKeptLenses: opts.lightKeptLenses,
  extraLensOutcome: opts.extraLensOutcome, optionalRequested: opts.optionalRequested,
  ...tallies,
  REPO_DIRECTIVE: dispatch.REPO_DIRECTIVE, AGENT_TRIES: dispatch.AGENT_TRIES, limitStop: dispatch.limitStop, ragent: dispatch.ragent, ragentQuietly: dispatch.ragentQuietly, splitThrew: dispatch.splitThrew,
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
  // The run directory the checkpoints landed in, '' until one did: unitScope's question channel lives under it.
  get runDir() { return telemetry.runDir },
}
}
