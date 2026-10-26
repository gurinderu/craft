// A profile's completeness critic (src/review.js, Synthesize phase): on a large or security-sensitive plan and
// budget allowing, it names lenses that should have run; the admitted ones run, and their findings are verified.
import { applyPathFloor } from './path-severity-floor.mjs'
import { CRITIC_SCHEMA } from './review-schemas.mjs'
import { flattenField } from './prompt-fields.mjs'

/**
 * @typedef {import('./review-schemas.mjs').Finding} Finding
 * @typedef {import('./review-profiles.mjs').Profile} Profile
 * @typedef {import('./review-run.mjs').ReviewRun} ReviewRun
 * @typedef {import('./review-plan.mjs').Plan} Plan
 */
/**
 * @typedef {ReturnType<typeof import('./review-lens-dispatch.mjs').makeLensDispatch>} Dispatch
 * @typedef {ReturnType<typeof import('./review-lens-prompts.mjs').makeLensPrompts>} Prompts
 * @typedef {ReturnType<typeof import('./review-verify-pool.mjs').makeVerifyPool>} Verifier
 * @typedef {ReturnType<typeof import('./review-dedup.mjs').makeDedup>} Dedup
 * @typedef {Awaited<ReturnType<Verifier['verifyPool']>>} Verified
 */

/**
 * The profile's verified tiers with the critic's follow-ups added, and its notes.
 * @param {ReviewRun} reviewRun
 * @param {{ profile: Profile, plan: Plan, pool: Finding[], seen: Set<string>, profileNotRun: string[], surfaceDropped: string[], toolProvenance: string, baseRef: string, runLens: Dispatch['runLens'], lensPrompt: Prompts['lensPrompt'], admittedLens: (l: string) => boolean, verifyPool: Verifier['verifyPool'], dedupPool: Dedup['dedupPool'], verified: Verified }} critic
 */
export async function criticPhase(reviewRun, { profile, plan, pool, seen, profileNotRun, surfaceDropped, toolProvenance, baseRef, runLens, lensPrompt, admittedLens, verifyPool, dedupPool, verified }) {
  const { key, lightPass, optionalNamedByCritic, surfaceGateNamedByCritic, ragent } = reviewRun
  const { log: logLine, parallel: runParallel, phase: enterPhase, budget: tokenBudget } = reviewRun.sb
  // Lenses the completeness critic added and that were dispatched — on the record, because they change
  // what a round cost without changing its plan (lib/round-pairs.mjs compares them, realm #97).
  /** @type {string[]} */
  let criticFollowupLenses = []
  let { confirmed: profileConfirmed, suspected: profileSuspected, unverified: profileUnverified, dropped: profileDropped, refuted, savedByFloor: profileSavedByFloor } = verified
  // ---- Completeness critic (large or security-sensitive; budget-gated) ----
  enterPhase('Synthesize')
  // The completeness critic, when the plan is large or security-sensitive and the budget allows it.
  async function completenessCritic() {
    // A light pass runs no critic: its follow-up lenses are the extra round the light pass forgoes (#295).
    if (lightPass) return
    const criticInScope = plan.sizeBucket === 'large' || plan.securitySensitive
    if (criticInScope && (!tokenBudget.total || tokenBudget.remaining() > 90000)) {
      await runCritic()
    } else if (criticInScope) {
      profileNotRun.push(`${profile.id} completeness-critic`)
      logLine(`Budget low (~${Math.round(tokenBudget.remaining() / 1000)}k left) — SKIPPED [${profile.id}] completeness critic. Review marked INCOMPLETE.`)
    }
  }
  async function runCritic() {
    const candidates = profile.lenses.filter((/** @type {string} */ l) => !plan.lenses.includes(l))
    const critic = await ragent(
      `You are a completeness critic for a ${profile.lang} review of the diff (base ${flattenField(baseRef) || 'HEAD'}).
Lenses already run: ${plan.lenses.join(', ')}. Confirmed: ${profileConfirmed.length}, Suspected: ${profileSuspected.length}.
Name any review lens that was NOT run but SHOULD be, given what the diff touches — choose ONLY from: ${JSON.stringify(candidates)}.
Also note in one line anything else likely missed (a changed file no finding touched, a claim left unverified). If coverage is complete, return missingLenses: [] and notes: "coverage complete".`,
      { label: `critic:${profile.id}`, phase: 'Synthesize', schema: CRITIC_SCHEMA, effort: 'low' },
    )
    profileCriticNotes = critic?.notes ?? ''
    // `admittedLens()` gates HERE too, and this is the fourth road into the plan, not a redundant check:
    // `candidates` is by construction the lenses NOT selected, so the whole optional set is in it.
    // The critic is the same model whose hands this project deliberately took the spend out of
    // ("the scout classifies, the code budgets"); letting it re-order lenses on the synthesis phase
    // would return that spend through a side door and undo the boundary. The signal is not thrown
    // away — a refused name is carried to the reader as an uncovered surface, with how to buy it.
    const named = (critic?.missingLenses ?? []).filter((/** @type {string} */ l) => candidates.includes(l))
    const followups = refuseCriticNames(named)
    if (followups.length && (!tokenBudget.total || tokenBudget.remaining() > 60000)) {
      await criticFollowups(followups)
    } else if (followups.length) {
      profileNotRun.push(`${profile.id} critic follow-up lenses (${followups.join('/')})`)
      logLine(`Budget low (~${Math.round(tokenBudget.remaining() / 1000)}k left) — SKIPPED [${profile.id}] critic follow-up lenses. Review marked INCOMPLETE.`)
    }
  }
  // The critic's names the optional request or the surface gate refuses, recorded as uncovered; the rest are follow-ups.
  /** @param {string[]} named @returns {string[]} */
  function refuseCriticNames(named) {
    for (const l of named) if (!admittedLens(l)) optionalNamedByCritic.add(l)
    const refusedOptional = named.filter((/** @type {string} */ l) => !admittedLens(l))
    if (refusedOptional.length) logLine(`[${profile.id}] Completeness critic named optional lens(es) ${refusedOptional.join(', ')} — NOT dispatched (the optional pass is bought by an explicit \`optional=\` request); reported as uncovered.`)
    // realm @nick/craft #102: the surface gate BINDS the critic too, mirroring `admittedLens()` above and
    // for the same reason. `candidates` is by construction the lenses NOT in the plan, so a lens the
    // gate dropped is in it — and re-dispatching it here would buy back exactly the whole-repo lens the
    // diff's absent surface said not to run, while `surfaceGateSection()` still reported it "not run"
    // (the report would then LIE). `surfaceDropped` is the PER-PROFILE drop list, so a lens dropped in
    // this profile does not wrongly suppress another profile's critic. A named-and-dropped lens is
    // refused, carried to the reader as an uncovered surface, and kept out of the follow-up set.
    for (const l of named) if (surfaceDropped.includes(l)) surfaceGateNamedByCritic.add(l)
    const refusedSurface = named.filter((/** @type {string} */ l) => surfaceDropped.includes(l))
    if (refusedSurface.length) logLine(`[${profile.id}] Completeness critic named surface-gated lens(es) ${refusedSurface.join(', ')} — NOT dispatched (the diff does not touch the surface their defect class needs); reported as uncovered.`)
    return named.filter((/** @type {string} */ l) => admittedLens(l) && !surfaceDropped.includes(l))
  }
  /** @param {string[]} followups */
  async function criticFollowups(followups) {
    logLine(`[${profile.id}] Completeness critic → follow-up lenses: ${followups.join(', ')}`)
    criticFollowupLenses = [...followups]
    const priorSummary = `Earlier lenses already produced ${pool.length} findings — do NOT repeat them; surface only what your lens would add.`
    // A SILENT REFUSAL NEXT TO A LOUD ONE. `.filter(Boolean)` used to swallow a follow-up lens that
    // DIED — no notRun entry, no INCOMPLETE — while the branch two lines below, where the same lens
    // is skipped for lack of budget, records both. "The critic said run it and it died" is not a
    // cleaner outcome than "the critic said run it and there was no budget"; it is the same hole in
    // coverage, and the one a re-run can actually fix.
    const settledExtra = await runParallel(followups.map((/** @type {string} */ lens) => () =>
      runLens(lens, lensPrompt(lens, priorSummary, profile, plan), 'Synthesize', ' (critic)'),
    ))
    const deadFollowups = followups.filter((/** @type {string} */ _l, /** @type {number} */ i) => !settledExtra[i])
    if (deadFollowups.length) {
      profileNotRun.push(...deadFollowups.map((/** @type {string} */ l) => `${profile.id} critic follow-up lens ${l} — dispatched and returned no findings (died, or answered off-schema)`))
      logLine(`⚠️ [${profile.id}] critic follow-up lens(es) ${deadFollowups.join('/')} died before returning findings — recorded as not run; the review is INCOMPLETE`)
    }
    // `source` is the lens the engine dispatched, never the model's own label: the severity floor
    // and every source-keyed rule read it, as on the lens-round path.
    const extra = settledExtra.flatMap((r, i) => (r == null ? [] : (r.findings || []).map(f => ({ ...f, source: /** @type {string} */ (followups[i]) }))))
    const fresh = extra.filter(f => { const k = key(f); if (seen.has(k)) return false; seen.add(k); return true })
    if (fresh.length) {
      const v = await verifyPool(await dedupPool(applyPathFloor(fresh), profile), plan, profile, toolProvenance)
      profileNotRun.push(...(v.notRun || []))
      profileSavedByFloor = profileSavedByFloor.concat(v.savedByFloor || [])
      profileConfirmed = profileConfirmed.concat(v.confirmed)
      profileSuspected = profileSuspected.concat(v.suspected)
      profileUnverified = profileUnverified.concat(v.unverified)
      profileDropped += v.dropped
      refuted = refuted.concat(v.refuted)
      logLine(`[${profile.id}] Critic follow-up: +${v.confirmed.length} confirmed · +${v.suspected.length} suspected · ${v.dropped} refuted · +${v.unverified.length} not verified`)
    }
  }
  let profileCriticNotes = ''
  await completenessCritic()
  return { confirmed: profileConfirmed, suspected: profileSuspected, unverified: profileUnverified, dropped: profileDropped, refuted, savedByFloor: profileSavedByFloor, criticNotes: profileCriticNotes, criticFollowupLenses }
}
