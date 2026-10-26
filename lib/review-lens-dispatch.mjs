// The single dispatch point of a profile's lenses (src/review.js, Lenses phase): the reviewer agent first, the
// generic subagent when it is missing, every failure recorded by dispatch, and the one probe up front.
import { isAgentTypeMissing } from './agent-fallback.mjs'
import { FINDINGS_SCHEMA } from './review-schemas.mjs'
import { SURFACE_GATED_LENSES, OPTIONAL_LENSES } from './review-lens-tallies.mjs'

/**
 * @typedef {import('./review-profiles.mjs').Profile} Profile
 * @typedef {import('./review-schemas.mjs').FindingsAnswer} FindingsAnswer
 * @typedef {ReturnType<typeof import('./lens-scope.mjs').sliceDiff>[number]} Slice
 * @typedef {import('./review-run.mjs').ReviewRun} ReviewRun
 * @typedef {import('./review-plan.mjs').Plan} Plan
 */

/**
 * One profile's lens dispatch.
 * @param {ReviewRun} reviewRun @param {{ profile: Profile, plan: Plan }} lens  the profile and its plan
 */
export function makeLensDispatch(reviewRun, { profile, plan }) {
  const { optionalDispatched, surfaceGateDispatched, ragent, noteReviewerAgentMissing, noteReviewerAgentFallback, noteReviewerAgentNotFound } = reviewRun
  const { log: logLine, agent: runAgent } = reviewRun.sb
// ================= Per-profile pipeline: scout → gate → lenses → verify → critic =================
/** The single dispatch point's record of what ran, for the optional and surface-gate tallies. @param {string} lens */
function noteLensDispatched(lens) {
  // The single dispatch point for every lens on every path. Recording here — not at plan time — is
  // what makes the report and the run record physically unable to disagree with what happened.
  if (OPTIONAL_LENSES.includes(lens)) optionalDispatched.add(lens)
  // realm @nick/craft #102: mirrors the line above — a surface-gated lens that actually ran in ANY
  // profile is subtracted from the reported/recorded "dropped" set by surfaceGateTally().
  if (SURFACE_GATED_LENSES[lens]) surfaceGateDispatched.add(lens)
}
  // Lens runner: prefer the profile's dedicated reviewer agent; if that agent type is not
  // registered in this session (stale plugin registry), fall back to the generic workflow
  // subagent — lens prompts are self-contained. The miss is LEARNED once (reviewerAgentMissing):
  // without it the absent agent type is re-attempted on every lens × round, which floods the run
  // with "agent type '<x>' not found". Both failure shapes are handled — a thrown /not found/ and
  // a null return (some runtimes signal an unknown agent type that way). Record the real failure
  // reason so INCOMPLETE reporting doesn't have to guess (budget vs registry vs death).
  /** @type {Map<string, string>} */
  const lensFailures = new Map()
  let reviewerAgentMissing = false
  // Keyed by DISPATCH, not by lens name. Once a lens fans out over slices there are several live
  // dispatches under one name, and a name-keyed map keeps only the last failure — so the reported
  // reason would name one slice's error as if it were the lens's.
  const dispatchKey = (/** @type {string} */ lens, /** @type {Slice | null} */ slice) => (slice ? `${lens} :: ${slice.key}` : lens)
  // An answer is model output: the schema shapes it, but an off-schema answer still arrives. One
  // without a findings array did not review — counting it as returned would read `{}` as a clean lens
  // and iterate a string or a number as findings. It is a lens failure with its own reason, so every
  // caller (the round, the resurrection sweep, the critic follow-ups) sees exactly what a dead lens is.
  /** @param {string} lens @param {string} prompt @param {string} phaseName @param {string} labelSuffix @param {Slice | null} [slice] @returns {Promise<FindingsAnswer | null>} */
  async function runLens(lens, prompt, phaseName, labelSuffix, slice = null) {
    const res = await dispatchLens(lens, prompt, phaseName, labelSuffix, slice)
    if (res != null && !Array.isArray(/** @type {{ findings?: unknown }} */ (res).findings)) {
      lensFailures.set(dispatchKey(lens, slice), 'answered off-schema (no findings array)')
      logLine(`⚠️ [${profile.id}] lens ${dispatchKey(lens, slice)} answered off-schema (no findings array) — counted as not returned`)
      return null
    }
    return res
  }
  // A fallback counts as answered only when runLens would accept it: an off-schema answer is a dead lens.
  const answeredFindings = (/** @type {unknown} */ r) => r != null && Array.isArray(/** @type {{ findings?: unknown }} */ (r).findings)
  /** @param {string} lens @param {string} prompt @param {string} phaseName @param {string} labelSuffix @param {Slice | null} [slice] */
  async function dispatchLens(lens, prompt, phaseName, labelSuffix, slice = null) {
    noteLensDispatched(lens)
    const opts = { label: `lens:${profile.id}:${lens}${labelSuffix}`, phase: phaseName, schema: FINDINGS_SCHEMA, model: plan.lensModel }
    const runGeneric = async () => {
      try {
        return await ragent(prompt, opts)
      } catch (e) {
        lensFailures.set(dispatchKey(lens, slice), String((e && /** @type {{ message?: unknown }} */ (e).message) || e).slice(0, 160))
        return null
      }
    }
    if (reviewerAgentMissing) return runGeneric()
    try {
      const res = await ragent(prompt, { ...opts, agentType: profile.reviewerAgent })
      if (res != null) return res
      // Null (not a throw) from the reviewer path: on some runtimes an unknown agent type returns
      // null rather than throwing. ragent already retried; try the generic subagent once. Do NOT
      // set reviewerAgentMissing — a null can be a transient API death, so later lenses still get
      // a shot at the real reviewer agent. Counted, so the report can say it happened — only when the
      // generic subagent answered: dead on both paths is a dead lens, as rust-audit counts it (#116).
      const fallback = await runGeneric()
      if (answeredFindings(fallback)) noteReviewerAgentFallback(profile)
      return fallback
    } catch (e) {
      return reviewerAgentThrew(e, lens, slice, runGeneric)
    }
  }

  // The reviewer-agent dispatch threw: an unregistered agent type routes this and every later lens to
  // the generic subagent; any other error is this dispatch's failure, retried generically only when it reads /not found/.
  /** @param {unknown} e @param {string} lens @param {Slice | null} slice @param {() => Promise<FindingsAnswer | null>} runGeneric */
  async function reviewerAgentThrew(e, lens, slice, runGeneric) {
    const msg = String((e && /** @type {{ message?: unknown }} */ (e).message) || e)
    // dispatchKey, like the other write to this map. Keyed by bare name the real error message was
    // looked up under a key nobody uses, so a sliced dispatch that died WITH a reason was reported
    // as "died without an error" — and any sibling slice could overwrite it.
    if (!isAgentTypeMissing(msg, profile.reviewerAgent)) {
      // Recorded first, so a generic run that also returns nothing still reports this error (a generic
      // throw overwrites it with its own). Not memoized: a real unregistered type in unknown wording
      // costs one failed agent dispatch per lens — the price of not guessing at the text (#116).
      lensFailures.set(dispatchKey(lens, slice), msg.slice(0, 160))
      if (!/not found/i.test(msg)) return null
      const fallback = await runGeneric()
      if (answeredFindings(fallback)) { lensFailures.delete(dispatchKey(lens, slice)); noteReviewerAgentNotFound(profile, msg.slice(0, 160)) }
      return fallback
    }
    reviewerAgentMissing = true; noteReviewerAgentMissing(profile, msg)
    logLine(`⚠️ [${profile.id}] agent type '${profile.reviewerAgent}' not registered here — routing remaining lenses to the generic subagent`)
    return await runGeneric()
  }
  // The probe: only a thrown /not found/ marks the reviewer agent missing.
  async function probeReviewerAgent() {
    if (profile.reviewerAgent && !reviewerAgentMissing) {
      try {
        await runAgent('Reply with the single word: OK.', { label: `probe:${profile.id}`, phase: 'Gate', model: 'haiku', effort: 'low', agentType: profile.reviewerAgent })
      } catch (e) {
        const msg = String((e && /** @type {{ message?: unknown }} */ (e).message) || e)
        if (isAgentTypeMissing(msg, profile.reviewerAgent)) {
          reviewerAgentMissing = true; noteReviewerAgentMissing(profile, msg)
          logLine(`[${profile.id}] reviewer agent '${profile.reviewerAgent}' not registered — all lenses will use the generic subagent`)
        }
      }
    }
  }
  return { runLens, dispatchKey, lensFailures, probeReviewerAgent }
}
