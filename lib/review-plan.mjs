// The per-profile plan (src/review.js, Scout phase): the scout's classification, then every floor and gate in
// order — rigor by size, the required lenses, the security floor, the optional request, the surface gate, the light pass.
import { lightLenses, lightForcedLenses, lightCalledForLenses } from './review-depth.mjs'
import { isContractOrSchemaPath } from './contract-paths.mjs'
import { changesProductionCode } from './test-paths.mjs'
import { WHOLE_DIFF_LENSES } from './lens-scope.mjs'
import { CONDITIONAL_LENSES, SURFACE_GATED_LENSES, OPTIONAL_LENSES } from './review-lens-tallies.mjs'
import { repoRulePaths } from './repo-rules.mjs'

/**
 * @typedef {import('./review-profiles.mjs').Profile} Profile
 * @typedef {import('./review-schemas.mjs').ScoutAnswer} ScoutAnswer
 * @typedef {import('./review-run.mjs').ReviewRun} ReviewRun
 */
/**
 * @typedef {{ sizeBucket: string, lenses: string[], maxRounds: number, verifyVotes: number, lensModel: string, isLibrary: boolean, securitySensitive: boolean, intent: string, spec: string, churn: string[], repoRules: string[] }} Plan
 */

/**
 * The planner of one run.
 * @param {ReviewRun} reviewRun @param {{ spec: string, changedFiles: string[] }} change  the authors' spec and the changed files
 */
export function makePlanner(reviewRun, { spec, changedFiles }) {
const { intentArg, strict, lightPass, lightSkippedLenses, lightKeptLenses, optionalRequested } = reviewRun
const { log: logLine } = reviewRun.sb
// Rigor is a function of the size bucket, not a model's opinion: the scout classifies (sizeBucket,
// lenses, securitySensitive, …) and the script budgets. `lensModel` is a constant — review reasoning
// runs on Opus at every size; depth scales via rounds, votes and lens count.
const RIGOR_BY_SIZE = {
  small: { maxRounds: 1, verifyVotes: 1 },
  medium: { maxRounds: 2, verifyVotes: 1 },
  large: { maxRounds: 3, verifyVotes: 3 },
}
const LENS_MODEL = 'opus'

// ---- the per-profile plan: the scout's classification, then every floor and gate, in this order ----
// Lenses a BLANKET expansion of the roster must not include. A lens is a full agent — the
// dominant per-run cost — and `failure-windows` is the heaviest in the Rust roster: it enumerates
// every mutating request on the changed path and plays out each adjacent pair. Its premise is a
// code shape (a controller / reconcile loop), and its gate is the `reconciler` lens below. But it
// also sits in `profile.lenses`, so every blanket fill of that list — the security-sensitive
// rigor floor, the empty-lens fallback, and the conservative plan used when the scout DIED —
// bought it on any Rust diff at all, which is the opposite of "find more without paying hugely".
// A blanket fill is a statement of IGNORANCE about the diff, and ignorance is not this lens's
// signal. The scout may still pick it deliberately; only the floors may not.
// `admittedLens` is the ONE gate the optional set passes through, and it must sit under EVERY path
// into the plan — the scout's own picks, the blanket fills, and therefore the security floor and
// the empty-lens fallback that call `blanketLenses()`. There is a fourth path, far later and easy to
// miss: the completeness critic on the synthesis phase, which composes from the lenses NOT
// selected — by construction the whole optional set. It went ungated once and bought two of the
// three on an ordinary large diff. It calls `admittedLens` too now; putting the gate anywhere but
// under each of these leaves a door, because every one of them names lenses on its own signals.
/** Whether a lens may enter the plan at all: the optional set only by an explicit request. @param {string} l */
function admittedLens(l) {
  return !OPTIONAL_LENSES.includes(l) || optionalRequested.includes(l)
}

/** The profile's roster as a blanket fill takes it: no conditional lens, nothing unrequested. @param {Profile} profile @returns {string[]} */
function blanketLenses(profile) {
  return profile.lenses.filter((/** @type {string} */ l) => !CONDITIONAL_LENSES.includes(l) && admittedLens(l))
}

/** @param {ScoutAnswer | null} scout @returns {keyof typeof RIGOR_BY_SIZE} */
function rigorSize(scout) {
  // hasOwn, not truthiness: a bucket of "constructor" would index Object.prototype and pass.
  return /** @type {keyof typeof RIGOR_BY_SIZE} */ (Object.hasOwn(RIGOR_BY_SIZE, scout?.sizeBucket ?? '') ? scout?.sizeBucket : 'medium')
}

/** The lenses the scout picked that the roster has and the gate admits; a blanket fill when it picked none. @param {Profile} profile @param {ScoutAnswer | null} scout @returns {string[]} */
function scoutPickedLenses(profile, scout) {
  return scout?.lenses?.length ? scout.lenses.filter((/** @type {string} */ l) => profile.lenses.includes(l) && admittedLens(l)) : blanketLenses(profile)
}

/** The repository's rule files the scout found, as the lens prompts may carry them (realm @nick/craft, node #406). @param {ScoutAnswer | null} scout */
function scoutRepoRules(scout) {
  return repoRulePaths(scout?.repoRules)
}

/** @param {Profile} profile @param {ScoutAnswer | null} scout @param {keyof typeof RIGOR_BY_SIZE} size @returns {Plan} */
function initialPlan(profile, scout, size) {
  return {
    sizeBucket: size,
    lenses: scoutPickedLenses(profile, scout),
    maxRounds: RIGOR_BY_SIZE[size].maxRounds,
    verifyVotes: RIGOR_BY_SIZE[size].verifyVotes,
    lensModel: LENS_MODEL,
    isLibrary: profile.usesLibrary ? (scout?.isLibrary ?? false) : false,
    securitySensitive: scout?.securitySensitive ?? true,
    intent: scout?.intent ?? intentArg,
    spec,
    churn: scout?.churn ?? [],
    repoRules: scoutRepoRules(scout),
  }
}

/** Adds a lens the plan lacks. @param {Plan} plan @param {string} l */
function addMissingLens(plan, l) {
  if (!plan.lenses.includes(l)) plan.lenses.push(l)
}

/** Adds a lens the plan lacks, if the profile's roster offers it. @param {Profile} profile @param {Plan} plan @param {string} l */
function addOfferedLens(profile, plan, l) {
  if (profile.lenses.includes(l)) addMissingLens(plan, l)
}

/** The lenses the plan must carry whatever the scout picked: the always set, and those the scout's own signals call for. @param {Profile} profile @param {ScoutAnswer | null} scout @param {Plan} plan */
function addRequiredLenses(profile, scout, plan) {
  // "Always" lenses are enforced HERE, not left to the scout: smoke runs showed prompt-side
  // "always include X" gets dropped. 'intent' is the lens that catches correct-looking code
  // with wrong behavior — it runs at every size.
  for (const l of (profile.alwaysLenses || [])) addOfferedLens(profile, plan, l)
  // `tests` is enforced the same way on a change to production code (lib/test-paths.mjs): a code change
  // with no test beside it is exactly where a missing or hollow test matters most, and the scout's
  // rule only fires on changed tests. A test-only or docs-only diff still leaves it to the scout.
  if (changesProductionCode(changedFiles, profile.diffGlobs)) addOfferedLens(profile, plan, 'tests')
  // `reconciler` in the plan IS the signal that this is controller code, and controller code is
  // where the windows between two committed writes live. Enforced here rather than in the scout
  // prompt for the same measured reason as the alwaysLenses loop above: a prompt-side "also include"
  // gets dropped, and a lens that silently did not run renders as a clean pass.
  // The signal is the SCOUT having chosen `reconciler` after reading the diff — not `reconciler`
  // merely being present in the plan. A blanket fill puts it there on every Rust diff, so reading
  // the plan let the floors back in through the gate's own door: the check passed, and the
  // conditional lens was conditional on nothing.
  if (scoutChoseReconciler(scout)) addOfferedLens(profile, plan, 'failure-windows')
  if (strict) addOfferedLens(profile, plan, 'maintainability')
}

/** Whether the scout, having read the diff, chose `reconciler`: the controller-code signal. @param {ScoutAnswer | null} scout */
function scoutChoseReconciler(scout) {
  return Array.isArray(scout?.lenses) && scout.lenses.includes('reconciler')
}

/** The rigor floors: security, the size-driven lenses, and an explicit optional request. @param {Profile} profile @param {Plan} plan */
function addRigorFloors(profile, plan) {
  // Security-sensitive rigor floor: don't let the size heuristic gate rigor on a security-touching change.
  if (plan.securitySensitive) applySecurityFloor(profile, plan)
  // Negative-space lens where new reachable surface tends to appear.
  if (plan.securitySensitive || plan.sizeBucket === 'large') addMissingLens(plan, 'negative-space')
  // Compat lens on large diffs too: changed serialized/persisted representations break other-versioned
  // readers (rolling deploy, already-stored rows) invisibly to the code-intrinsic lenses. Security-sensitive
  // diffs already get it via the all-lenses floor above (compat ∈ profile.lenses).
  if (plan.sizeBucket === 'large') addOfferedLens(profile, plan, 'compat')
  // A changed contract path (lib/contract-paths.mjs) ADDS compat at every size: a chart, CRD, IDL,
  // migration or plugin manifest is deployed or called against by other versions whatever the diff's
  // size, and the surface gate below then keeps it, since the same paths force `wireForm` on.
  if (changedFiles.some(isContractOrSchemaPath)) addOfferedLens(profile, plan, 'compat')
  // An explicit request ADDS the lens; it does not merely permit it. A caller who writes
  // `optional=performance` is asking for the performance pass to RUN, not for the scout to be
  // allowed to pick it — and on a small diff with no security floor nothing else would ever put it
  // in the plan, so "permit" would have meant "nothing happens". Enforced in code, for the same
  // measured reason as the alwaysLenses loop above.
  for (const l of optionalRequested) addOfferedLens(profile, plan, l)
}

/** @param {Profile} profile @param {Plan} plan */
function applySecurityFloor(profile, plan) {
  for (const l of blanketLenses(profile)) addMissingLens(plan, l)
  plan.verifyVotes = Math.max(plan.verifyVotes, 3)
  plan.maxRounds = Math.max(plan.maxRounds, 2)
}

/** Drops each surface-gated lens whose surface the scout said is absent; returns what it dropped. @param {ScoutAnswer | null} scout @param {Plan} plan @returns {string[]} */
function applySurfaceGate(scout, plan) {
  // realm @nick/craft #102: surface gate — the LAST word on plan.lenses, sitting AFTER every floor
  // that can add negative-space/compat/invariants (the scout's picks, the security/large floors, the
  // optional request above). Each of those three fires only where the diff touches the surface its
  // defect class needs; here that surface is read and the lens dropped only where the scout said the
  // surface is absent. FAIL-OPEN: an undefined or true surface KEEPS the lens.
  const surfaces = { ...(scout?.surfaces || {}) }
  // Certain cross-boundary paths the scout can miss force their surfaces ON — never off, so this only
  // ever adds a lens back, never removes one.
  if (changedFiles.some(isContractOrSchemaPath)) { surfaces.crossBoundarySymbol = true; surfaces.wireForm = true }
  /** @type {string[]} */
  const surfaceDropped = []
  plan.lenses = plan.lenses.filter(lens => {
    const need = SURFACE_GATED_LENSES[lens]
    if (!need) return true
    if (surfaces[need] === false) { surfaceDropped.push(lens); return false }
    return true // fail-open: undefined/true keeps the lens
  })
  return surfaceDropped
}

/** @param {Profile} profile @param {ScoutAnswer | null} scout @returns {{ plan: Plan, surfaceDropped: string[] }} */
function planFromScout(profile, scout) {
  const plan = initialPlan(profile, scout, rigorSize(scout))
  if (!plan.lenses.length) plan.lenses = blanketLenses(profile)
  addRequiredLenses(profile, scout, plan)
  addRigorFloors(profile, plan)
  const surfaceDropped = applySurfaceGate(scout, plan)
  return { plan, surfaceDropped }
}

// realm @nick/craft, node #295: the light pass keeps the diff-scoped lenses for one round; the
// whole-diff lenses it drops are named on every report (lightSection); those the diff calls for, on
// controller code or a contract path, it keeps (realm @nick/craft, node #299).
/** @param {Profile} profile @param {ScoutAnswer | null} scout @param {Plan} plan */
function applyLightProfile(profile, scout, plan) {
  if (!lightPass) return
  const forced = [...lightForcedLenses(changedFiles, profile.diffGlobs, profile.lenses), ...lightCalledForLenses(changedFiles, scoutChoseReconciler(scout), profile.lenses)]
  const { kept, skipped } = lightLenses(plan.lenses, WHOLE_DIFF_LENSES, blanketLenses(profile), forced)
  plan.lenses = kept
  plan.maxRounds = 1
  for (const l of skipped) lightSkippedLenses.add(l)
  for (const l of kept) if (WHOLE_DIFF_LENSES.includes(l)) lightKeptLenses.add(l)
  logLine(`[${profile.id}] light pass: ${kept.join(', ')}, one round${skipped.length ? `; whole-diff lenses skipped: ${skipped.join(', ')}` : ''}`)
}

/** @param {Profile} profile @param {ScoutAnswer | null} scout @param {Plan} plan */
function logScoutPlan(profile, scout, plan) {
  logLine(`[${profile.id}] ${!scout ? '⚠️ scout did not return — conservative fallback plan' : (scout.notes || 'scout: classified')} · ${plan.sizeBucket}${plan.securitySensitive ? ' · SECURITY floor (all lenses, 3-vote)' : ''}${plan.lenses.includes('negative-space') ? ' · +negative-space' : ''}`)
}
return { planFromScout, applyLightProfile, logScoutPlan, admittedLens }
}
