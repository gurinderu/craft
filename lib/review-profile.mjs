// One language profile's review (src/review.js): scout → plan → preflight → gate → lenses → verify → critic,
// each step from its own lib/ module; what it returns is one entry of the run's results.
import { applyPathFloor } from './path-severity-floor.mjs'
import { honestVerdict } from './honest-verdict.mjs'
import { summarizeFindings } from './run-record.mjs'
import { SCOUT_SCHEMA, GATE_SCHEMA } from './review-schemas.mjs'
import { OPTIONAL_LENSES } from './review-lens-tallies.mjs'
import { makeLensDispatch } from './review-lens-dispatch.mjs'
import { lensRoundsPhase } from './review-lens-rounds.mjs'
import { criticPhase } from './review-critic.mjs'
import { openCrateScope } from './review-crate-scope.mjs'

/**
 * @typedef {import('./review-profiles.mjs').Profile} Profile
 * @typedef {import('./review-run.mjs').ReviewRun} ReviewRun
 */
/**
 * @typedef {Awaited<ReturnType<typeof reviewProfile>>} ProfileReview  one profile's facts
 */

/**
 * @param {ReviewRun} reviewRun @param {Profile} profile
 * @param {{ prompts: ReturnType<typeof import('./review-lens-prompts.mjs').makeLensPrompts>, extras: ReturnType<typeof import('./review-extra-lens-run.mjs').makeExtraLenses>, dedup: ReturnType<typeof import('./review-dedup.mjs').makeDedup>, verifier: ReturnType<typeof import('./review-verify-pool.mjs').makeVerifyPool>, planner: ReturnType<typeof import('./review-plan.mjs').makePlanner>, gate: ReturnType<typeof import('./review-gate.mjs').makeGate>, branch: string, head: string, baseRef: string, thisRound: number, changedFiles: string[] }} kit  the run's toolkit and the change
 */
export async function reviewProfile(reviewRun, profile, kit) {
  const { finalVerdict, ragent, checkpoint } = reviewRun
  const { log: logLine, phase: enterPhase } = reviewRun.sb
  const { prompts, extras, dedup, verifier, planner, gate: gateKit, branch, head, baseRef, thisRound, changedFiles } = kit
  const { scoutPrompt, lensPrompt, lensDiffRange } = prompts
  const { planFromScout, applyLightProfile, logScoutPlan, admittedLens } = planner
  const { runPreflight, gateFields, gateSeedFindings, logGate, toolProvenanceFor, preflightCheckpoint } = gateKit
  const { verifyPool } = verifier
  const { rollupPool, dedupPool } = dedup
  // ---- Scout ----
  const scout = await ragent(scoutPrompt(profile), { label: `scout:${profile.id}`, schema: SCOUT_SCHEMA, model: 'haiku', effort: 'low', phase: 'Scout' })
  // A dead/timed-out scout falls back to the CONSERVATIVE plan (all lenses, security floor → 3-vote),
  // never a permissive one — but it must not read as a successful classification either: the fallback
  // loses the scouted intent, churn and size, so it is logged loudly and carried into `notRun` so the
  // verdict says INCOMPLETE rather than a clean Approve.
  const scoutFailed = !scout
  const scoutNotRun = scoutFailed
    ? [`${profile.id} scout classification — the plan is the conservative fallback (all lenses, 3-vote, 2 rounds), not a scouted one`]
    : []
  const { plan, surfaceDropped } = planFromScout(profile, scout)
  applyLightProfile(profile, scout, plan)
  // Only the UNIVERSE is recorded here: which optional lenses this profile could have bought. It rides
  // back on the profile's result; what ran is recorded at dispatch (`runLens`) and subtracted by
  // `optionalTally()`, because the plan is not final at this point — see the tally's definition.
  const optionalScope = profile.lenses.filter((/** @type {string} */ l) => OPTIONAL_LENSES.includes(l))
  logScoutPlan(profile, scout, plan)

  const { runLens, dispatchKey, lensFailures, probeReviewerAgent } = makeLensDispatch(reviewRun, { profile, plan })

  // ---- Preflight ----
  const { preflight, probeViolations } = await runPreflight(profile)

  // ---- Gate ----
  const gate = await ragent(profile.gate({ baseRef, isLibrary: plan.isLibrary, securitySensitive: plan.securitySensitive, preflight }),
    { label: `gate:${profile.id}`, schema: GATE_SCHEMA, phase: 'Gate', effort: 'medium' })
  const { gateStatus, gateProvenance, failedChecks, carriedChecks } = gateFields(gate)
  const seedFindings = gateSeedFindings(gate)
  logGate(profile, gateStatus, gateProvenance, failedChecks, carriedChecks)
  const toolProvenance = toolProvenanceFor(gateProvenance, preflight)
  // First checkpoint: from here on, a run that dies still says what was planned and whether the tree
  // was green. Everything before this point is cheap to redo; everything after it is not.
  // `head` is the RUN'S HEAD, the same value the final record carries, and the diff base rides under
  // its own `baseRef` key. Both once shared the `head` key — the checkpoints got the base (a ref NAME
  // like `origin/main`) while the final record got the sha — so the two sides of every
  // checkpoint↔record comparison spelled the field differently: `finalizeRun` folded 0 phases and
  // left the `.partial` directory behind, and `recover` then read a ref name as a commit and promoted
  // the leftover as a separate partial run. Two keys, each meaning one thing.
  //
  // `round` rides on every checkpoint for one reason: `recover` promotes an unfinalized directory
  // into a real record and DELETES the directory, and a record with no round is indexed as round 0 —
  // so one repair permanently reset the chain to a first review. The round number is knowable only
  // here, by the run itself; nothing downstream can reconstruct it.
  await checkpoint(`${profile.id}-plan`, {
    language: profile.id, branch, head, baseRef, round: thisRound,
    scout: { size: plan.sizeBucket, lenses: plan.lenses, maxRounds: plan.maxRounds, verifyVotes: plan.verifyVotes, securitySensitive: plan.securitySensitive },
    gate: { status: gateStatus, provenance: gateProvenance, failedChecks, carriedChecks, seeds: seedFindings.length },
    // `status` so a reader of the record can tell a preflight that ran and found nothing from one
    // that never answered — a bare `null` collapsed both into the same, more permissive, reading.
    preflight: preflightCheckpoint(preflight, probeViolations),
  }, 'Gate')
  if (gateStatus === 'fail') {
    return { profile, plan, surfaceDropped, optionalScope, ranLenses: /** @type {string[]} */ ([]), lensRounds: [], gateStatus, gateProvenance, failedChecks, carriedChecks, confirmed: [], suspected: [], unverified: [], dropped: 0, notRun: [...scoutNotRun], criticNotes: '', probeViolations }
  }

  // ---- Probe reviewer-agent availability ONCE up front ----
  // The per-lens fallback (runLens) already recovers, but it learns the miss only after the FIRST
  // attempt — and the round-1 lenses fan out in parallel, so without this every lens in round 1
  // would fail with "agent type '<x>' not found" before the memo is set. One cheap probe collapses
  // that opening wave to a single attempt. Best-effort: only a thrown /not found/ marks it missing;
  // a result, a null, or an unrelated error leaves the per-lens fallback to decide.
  await probeReviewerAgent()

  // crateScope (realm @nick/craft, #324): the crate slices, the coordinator and the seam pass; off, the directory slicing.
  const cs = await openCrateScope(reviewRun, { profile, plan, changedFiles, lensDiffRange })
  const crateLenses = cs.dimensions()
  const { pool, seen, profileNotRun, ranLenses, lensRounds } = await lensRoundsPhase(reviewRun, { profile, plan, seedFindings, scoutNotRun, runLens, dispatchKey, lensPrompt, lensFailures, extraLensesFor: extras.extraLensesFor, pushUnseen: extras.pushUnseen, branch, head, baseRef, thisRound, cs })
  if (!pool.length) {
    return { profile, plan, surfaceDropped, optionalScope, ranLenses, lensRounds, crateLenses, gateStatus, gateProvenance, failedChecks, carriedChecks, confirmed: [], suspected: [], unverified: [], dropped: 0, notRun: profileNotRun, criticNotes: '', probeViolations }
  }

  // ---- Verify ----
  enterPhase('Verify')
  const deduped = await dedupPool(rollupPool(applyPathFloor(pool), profile), profile)
  const { confirmed: profileConfirmed, suspected: profileSuspected, unverified: profileUnverified, dropped: profileDropped, refuted, notRun: verifyNotRun, savedByFloor: profileSavedByFloor } = await verifyPool(deduped, plan, profile, toolProvenance)
  // Verification that never ran joins the lens-level list: a dead batch verifier is a hole in
  // coverage exactly like a lens that never returned, and both must reach the verdict as INCOMPLETE.
  profileNotRun.push(...verifyNotRun)
  logLine(`[${profile.id}] Verify: ${profileConfirmed.length} confirmed · ${profileSuspected.length} suspected · ${profileDropped} refuted · ${profileUnverified.length} not verified`)
  await checkpoint(`${profile.id}-verify`, {
    language: profile.id, branch, head, baseRef, round: thisRound,
    verdict: honestVerdict(finalVerdict(profileConfirmed), profileNotRun),
    findings: summarizeFindings(profileConfirmed),
    // `candidates` counts what verification EXAMINED, so the unverified tier is reported beside it
    // rather than inside it.
    verification: { candidates: deduped.length - profileUnverified.length, confirmed: profileConfirmed.length, suspected: profileSuspected.length, refuted: profileDropped, unverified: profileUnverified.length },
  }, 'Verify')

  const critic = await criticPhase(reviewRun, { profile, plan, pool, seen, profileNotRun, surfaceDropped, toolProvenance, baseRef, runLens, lensPrompt, admittedLens, verifyPool, dedupPool,
    verified: { confirmed: profileConfirmed, suspected: profileSuspected, unverified: profileUnverified, dropped: profileDropped, refuted, notRun: verifyNotRun, savedByFloor: profileSavedByFloor } })

  return { profile, plan, surfaceDropped, optionalScope, ranLenses, lensRounds, crateLenses, criticFollowupLenses: critic.criticFollowupLenses, gateStatus, gateProvenance, failedChecks, carriedChecks, confirmed: critic.confirmed, suspected: critic.suspected, unverified: critic.unverified, dropped: critic.dropped, refuted: critic.refuted, notRun: profileNotRun, savedByFloor: critic.savedByFloor, criticNotes: critic.criticNotes, probeViolations }
}
