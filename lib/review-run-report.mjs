// What the review engine (src/review.js) wraps every report in, above and below the verdict: lost telemetry,
// lost re-review memory, a missing reviewer agent, the usage-limit stop, the light pass, the extra lenses, the
// optional and surface-gated lenses, and where the memory came from — each derived mechanically, never asked
// of the synthesis model.
import { agentUnavailableSection } from './agent-fallback.mjs'
import { extraLensSection } from './review-extra-lenses.mjs'
import { limitStopAdvice } from './usage-limit.mjs'
import { telemetryLostSection } from './review-coverage.mjs'
import { markVerdictLight, lightSection } from './review-depth.mjs'
import { memorySection } from './memory-recall.mjs'
import { priorDecisionsRefusedSection } from './prior-decisions.mjs'

/**
 * @typedef {import('./review-profiles.mjs').Profile} Profile
 * @typedef {ReturnType<typeof import('./review-run-args.mjs').readReviewArgs>} ReviewArgs
 * @typedef {ReturnType<typeof import('./review-lens-tallies.mjs').makeLensTallies>} LensTallies
 */

/**
 * The run's report wrapper and the run state it renders; `active` is set once the coverage is decided.
 * @param {{ opts: ReviewArgs, tallies: LensTallies, limitStop: ReturnType<typeof import('./usage-limit.mjs').makeLimitStop>, telemetryLost: string[], craftVersion: string }} deps
 */
export function makeRunReport({ opts, tallies, limitStop, telemetryLost, craftVersion }) {
const { lightPass, lightSkippedLenses, lightKeptLenses, extraLensOutcome, extraLensRequest, reviewDepth } = opts
const { optionalSection, surfaceGateSection } = tallies
/** The active profiles, once the coverage decided them; empty on an earlier exit. @type {Profile[]} */
let active = []
// Re-review memory outcome, surfaced in the user-facing report (realm @nick/craft #104). A DETACHED
// HEAD makes the prior-round lookup return 'no-branch', so the run silently becomes round 1 with no
// chaining and no signal. `reReviewMemory` (below) sets this note; it is null on every run that chained
// normally or is a genuine first review, so the section is empty then. Declared before `out()` so an
// early exit that returns before the prior-round read sees a plain null, never a temporal-dead-zone.
/** @type {string | null} */
let reReviewMemoryNote = null
// Prepended by `out()` — near the top, above the verdict — because a re-review that quietly forgot its
// memory must be visible before the verdict, not buried after it.
const reReviewMemorySection = () => (reReviewMemoryNote ? `## ⚠️ Re-review memory off\n${reReviewMemoryNote}\n\n` : '')
// realm @nick/craft #113: a profile whose dedicated reviewer agent is not registered in this session
// (typically: the craft plugin is not enabled in this project) runs every lens on the generic subagent.
// The review still happens — but without the agent's rubric, and the operator otherwise sees only a
// failed probe. Stated above the verdict, with the fix; recorded on the run record.
/** @type {{ id: string, agent: string, error: string }[]} */
const reviewerAgentUnavailable = []
// The agent-type match and the section text are shared with rust-audit (lib/agent-fallback.mjs).
/** @param {Profile} profile @param {unknown} error */
function noteReviewerAgentMissing(profile, error) {
  if (!reviewerAgentUnavailable.some(x => x.id === profile.id)) reviewerAgentUnavailable.push({ id: profile.id, agent: profile.reviewerAgent, error: String(error || '').slice(0, 160) })
}
// Lens dispatches that came back EMPTY from the reviewer agent and were re-run on the generic
// subagent. On some runtimes that is how an unknown agent type looks; it can also be a transient
// death, so it is not taken as "missing" — but it is said, per profile, rather than staying silent.
/** @type {Record<string, number>} */
const reviewerAgentFallbacks = {}
/** @type {Record<string, string>} */
const reviewerAgentNames = {}           // profile id -> its reviewer agent type, for the report line
// Lens dispatches whose reviewer agent threw a "not found" isAgentTypeMissing does not recognise and the
// generic subagent then answered: the sandbox's wording for an unregistered type is not yet observed (#152),
// so the lens keeps its coverage rather than dying on a guess about the text. Also in the record count.
/** @type {Record<string, { count: number, error: string }>} */
const reviewerAgentNotFound = {}
/** @param {Profile} profile */
function noteReviewerAgentFallback(profile) {
  reviewerAgentFallbacks[profile.id] = (reviewerAgentFallbacks[profile.id] || 0) + 1
  reviewerAgentNames[profile.id] = profile.reviewerAgent
}
/** @param {Profile} profile @param {string} error */
function noteReviewerAgentNotFound(profile, error) {
  const was = reviewerAgentNotFound[profile.id]
  reviewerAgentNotFound[profile.id] = { count: (was?.count || 0) + 1, error }
  reviewerAgentFallbacks[profile.id] = (reviewerAgentFallbacks[profile.id] || 0) + 1
  reviewerAgentNames[profile.id] = profile.reviewerAgent
}
const reviewerAgentSection = () => agentUnavailableSection(
  reviewerAgentUnavailable.map(x => ({ agent: x.agent, what: `every ${x.id} lens`, error: x.error })),
  Object.entries(reviewerAgentFallbacks).filter(([id]) => !reviewerAgentUnavailable.some(x => x.id === id))
    .flatMap(([id, n]) => {
      const agentName = reviewerAgentNames[id] || `${id} reviewer agent`
      const nf = reviewerAgentNotFound[id]
      return [
        { agent: agentName, count: n - (nf?.count || 0), what: 'lens dispatch(es)' },
        ...(nf ? [{ agent: agentName, count: nf.count, what: 'lens dispatch(es)', error: nf.error }] : []),
      ]
    }),
)

// Wraps every report the engine can return. Narrow on purpose: it fires only for a write that was
// ATTEMPTED and did not land, never for telemetry that was never attempted — a marker that shows up
// on healthy runs is a marker people stop reading, which is the symmetric half of the same defect.
/** The extra lenses' account, once the first profile reached its lenses (realm @nick/craft, node #295). */
function extraLensReport() {
  return extraLensOutcome.reached ? extraLensSection({ how: extraLensRequest.how, ran: extraLensOutcome.ran, failed: extraLensOutcome.failed, discovery: extraLensOutcome.discovery, exit: extraLensOutcome.exit, rubric: extraLensOutcome.ran.length ? active[0]?.id ?? '' : '' }) : ''
}

/** The usage-limit stop and how to recover the record it may have cost, above the verdict; '' without a stop. */
function limitStopSection() {
  const advice = limitStopAdvice(limitStop, { version: craftVersion, engine: 'review', checkpoints: true })
  return advice ? `## \u26d4 Usage limit reached\n${advice}\n\n` : ''
}

/** @param {string} reportText */
function out(reportText) {
  return `${limitStopSection()}${telemetryLostSection(telemetryLost)}${reReviewMemorySection()}${reviewerAgentSection()}${lightPass ? markVerdictLight(reportText) + lightSection([...lightSkippedLenses], opts.lensPhaseReached, [...lightKeptLenses]) : reportText}${extraLensReport()}${optionalSection()}${surfaceGateSection()}${memorySection(opts.memory)}${priorDecisionsRefusedSection(opts.priorDecisionsIn.refused)}`
}

// Each failed or refused NAMED extra lens as a coverage gap of the first profile. A discovered one that
// could not run is said in the Extra lenses section only: discovery is on by default in a light pass,
// and resolving a project agent from a plugin workflow is not observed (realm @nick/craft, node #178),
// so its failure must not turn every such run INCOMPLETE.
/** @param {Profile} profile @returns {string[]} */
function extraLensGaps(profile) {
  return profile === active[0] && extraLensRequest.how === 'named' ? extraLensOutcome.failed.map(extraLensGapLine) : []
}

/** @param {{ agent: string, why: string }} x */
function extraLensGapLine(x) {
  return `extra lens ${x.agent} -- ${x.why}, so its review did not happen`
}

// An exit before the lenses ran: the extra lenses did not run either, and the report and the record
// say so with the reason (realm @nick/craft, node #295). A named one is a coverage gap; a discovery
// that never ran is said in the Extra lenses section. Returns the gaps' notRun lines.
/** @param {string} reason @returns {string[]} */
function extraLensesNotRun(reason, needed = true) {
  if (extraLensOutcome.reached || extraLensRequest.how === 'off') return []
  extraLensOutcome.reached = true
  extraLensOutcome.exit = { reason, needed }
  // Nothing to review (an empty or docs-only diff): a named lens was not needed, which is no gap.
  if (extraLensRequest.how === 'named' && needed) extraLensOutcome.failed.push(...extraLensRequest.agents.map(agentTypeName => ({ agent: agentTypeName, why: `not run: ${reason}` })))
  return extraLensOutcome.failed.map(extraLensGapLine)
}

/** The record's depth and extra-lens fields, on every record this engine writes (#295). */
function depthRecordFields() {
  return { depth: reviewDepth, extraLenses: { how: extraLensRequest.how, requested: extraLensRequest.agents, ran: extraLensOutcome.ran, failed: extraLensOutcome.failed, ...(extraLensOutcome.exit ? { exit: extraLensOutcome.exit } : {}) } }
}
return {
  reviewerAgentUnavailable, noteReviewerAgentMissing, reviewerAgentFallbacks, reviewerAgentNames, noteReviewerAgentFallback, noteReviewerAgentNotFound,
  out, extraLensGaps, extraLensesNotRun, depthRecordFields,
  get reReviewMemoryNote() { return reReviewMemoryNote },
  set reReviewMemoryNote(v) { reReviewMemoryNote = v },
  get active() { return active },
  set active(v) { active = v },
}
}
