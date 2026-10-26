// The per-profile preflight and mechanical gate (src/review.js, Gate phase): the preflight pass and its probe
// audit, and what the gate's answer gives the plan checkpoint, the verifiers and the log.
import { auditPreflightProbes } from './preflight-probes.mjs'
import { flattenField } from './prompt-fields.mjs'
import { PREFLIGHT_SCHEMA, preflightPrompt, preflightIsPartial } from './review-preflight-prompt.mjs'

/**
 * @typedef {import('./review-schemas.mjs').Finding} Finding
 * @typedef {import('./review-profiles.mjs').Preflight} Preflight
 * @typedef {import('./review-profiles.mjs').Profile} Profile
 * @typedef {import('./review-schemas.mjs').GateAnswer} GateAnswer
 * @typedef {import('./review-run.mjs').ReviewRun} ReviewRun
 */

/**
 * The gate helpers of one run.
 * @param {ReviewRun} reviewRun @param {{ baseRef: string }} change  the diff base
 */
export function makeGate(reviewRun, { baseRef }) {
const { ragent } = reviewRun
const { log: logLine } = reviewRun.sb
/** The preflight pass and its declared-probe audit, both logged. @param {Profile} profile */
async function runPreflight(profile) {
// Cheap and first: resolve the runner, the compile blockers and what CI already covers, so the gate
// spends its time on signals rather than on discovering its own environment. Best-effort by design —
// a preflight that dies just leaves the gate to work it out the old way.
const preflight = await ragent(preflightPrompt(profile, { baseRef }),
  // 5min, not the phase default. Three numbers set it, and the deadline must clear ALL of them:
  //  · the prompt declares a 3min ceiling, and a deadline at twice that makes the budget advisory —
  //    nothing then stops a pass that ignores the ceiling. 5min stays under 2x and keeps it real.
  //  · the measured cost of an earlier version of this pass was 207s, ALREADY past three minutes.
  //  · the clock starts at DISPATCH, not at execution, so it covers queue wait PLUS the run.
  // A deadline between those last two (210000 did exactly this) times out work that would have
  // landed. Losing preflight is survivable — the gate re-establishes everything itself, the slow
  // way — so the bound is set above the measured cost rather than tight against it.
  // THE COST ARGUMENT THAT USED TO STAND HERE IS NO LONGER TRUE, and the constant survives it.
  // It read: a miss costs TWO dispatches, because `ragent` abandoned the wait and re-dispatched
  // with a fresh deadline, so a hung pass burned up to 10min. The deadline is now ONE budget
  // shared by the attempts, and a deadline fire spends it by definition — so a miss costs one
  // dispatch and at most these 5 minutes, and the second attempt exists only for the fast death
  // that leaves budget behind. 300000 is therefore now a straightforwardly bounded 5min ceiling,
  // not a 10min one accepted as a trade.
  { label: `preflight:${profile.id}`, schema: PREFLIGHT_SCHEMA, phase: 'Gate', model: 'haiku', effort: 'low', deadlineMs: 300000 })
// The declared-probe audit. Named in the log and carried into the record so a breach of the
// "ask each source once" rule is a fact of the run rather than a matter of the prompt's manners.
const probeViolations = auditPreflightProbes(preflight)
if (probeViolations.length) {
  logLine(`⚠️ [${profile.id}] PREFLIGHT PROBE BUDGET BREACHED (${probeViolations.length}): ${probeViolations.join(' · ')}`)
}
if (preflight) {
  logLine(preflightLine(profile, preflight))
} else {
  // Never silent: no preflight line at all would read as "this run had no preflight step".
  logLine(`⚠️ [${profile.id}] Preflight unavailable (failed or passed its deadline) — the gate establishes the environment itself, and its provenance says so.`)
  // DELIBERATELY NOT `notRun`, unlike a dead scout. `notRun` drives the INCOMPLETE verdict and
  // means "a review step did not happen; re-run it". A dead scout satisfies that: the plan
  // degrades to the conservative fallback and the scouted intent is genuinely lost. A dead
  // preflight loses no coverage — every fact it resolves is re-established by the gate, and
  // preflightBrief() tells the gate to do exactly that. It costs time, not signal. Marking such a
  // run INCOMPLETE would flag a pure performance fallback as an unfinished review and dilute the
  // marker for the cases that mean it. The loss stays visible where it belongs: this log line and
  // `preflight.status: 'unavailable'` in the run record.
}
return { preflight, probeViolations }
}

/** @param {Profile} profile @param {Preflight} preflight */
function preflightLine(profile, preflight) {
  return `[${profile.id}] Preflight: runner ${preflight.runner ? `\`${preflight.runner.trim()}\`` : '(none)'}`
    + ` · ${preflight.blockers?.length ? `${preflight.blockers.length} compile blocker(s)` : 'no compile blockers'}`
    + ` · CI covers ${preflight.ciCovers?.length ? preflight.ciCovers.join(', ') : 'nothing'}`
    + `${preflight.missingTools?.length ? ` · missing: ${preflight.missingTools.join(', ')}` : ''}`
    + `${preflightIsPartial(preflight) ? ' · ⚠️ PARTIAL — see notes' : ''}`
}

/** @param {GateAnswer | null} gate */
function gateFields(gate) {
  return {
    gateStatus: gate?.status ?? 'unknown',
    gateProvenance: gate?.provenance ?? 'gate not established',
    failedChecks: gate?.failedChecks ?? [],
    // Red, real, and NOT this diff's doing. Kept out of failedChecks so it cannot stop the review, and
    // out of notes so it cannot be quietly lost: it prints on every verdict, including a green one.
    carriedChecks: gate?.carriedChecks ?? [],
  }
}

/** @param {GateAnswer | null} gate */
function gateSeedFindings(gate) {
  return (gate?.seedFindings ?? []).map((/** @type {Finding} */ f) => ({ ...f, source: f['source'] || 'tool' }))
}

/** @param {Profile} profile @param {string} gateStatus @param {string} gateProvenance @param {string[]} failedChecks @param {string[]} carriedChecks */
function logGate(profile, gateStatus, gateProvenance, failedChecks, carriedChecks) {
  logLine(`[${profile.id}] Gate: ${gateStatus} — ${gateProvenance}${failedChecks.length ? ` · failed: ${failedChecks.join(', ')}` : ''}${carriedChecks.length ? ` · ${carriedChecks.length} pre-existing (carried, not blocking)` : ''}`)
}

/** @param {string} gateProvenance @param {Preflight | null} preflight */
function toolProvenanceFor(gateProvenance, preflight) {
  // What a VERIFIER needs to run a tool, as opposed to what the RECORD needs to explain the gate.
  // Kept separate so the preflight's runner prefix never leaks into the persisted provenance string.
  return [
    gateProvenance,
    preflight?.runner ? `run every tool as \`${flattenField(preflight.runner).trim()} <cmd>\` — bare invocations die in missing system libraries` : '',
    preflight?.blockers?.length ? `CANNOT compile here: ${preflight.blockers.map(flattenField).join('; ')} — a tool needing a build is unrunnable, say so rather than reporting its error as evidence` : '',
  ].filter(Boolean).join(' · ')
}

/** The preflight as the plan checkpoint records it. @param {Preflight | null} preflight @param {string[]} probeViolations */
function preflightCheckpoint(preflight, probeViolations) {
  return preflight
    ? { status: preflightIsPartial(preflight) ? 'partial' : 'ok', runner: preflight.runner, blockers: preflight.blockers, missingTools: preflight.missingTools, ciCovers: preflight.ciCovers, notes: preflight.notes, probeViolations }
    : { status: 'unavailable' }
}
return { runPreflight, gateFields, gateSeedFindings, logGate, toolProvenanceFor, preflightCheckpoint }
}
