// The review engine's lens rosters that a plan may not buy on its own (the conditional, surface-gated and
// optional lenses), and the run-level tallies of what was dispatched of them, rendered on every report.
import { failedProfiles, optionalTallyFrom, savedSurfaceDrops } from './profile-merge.mjs'

/**
 * @typedef {import('./review-schemas.mjs').ScoutAnswer} ScoutAnswer
 * @typedef {import('./profile-merge.mjs').ProfileResult} ProfileResult
 */

// Admitted by a code signal, never by a floor. See `blanketLenses()` in planFor: a blanket roster fill
// says "nothing is known about this diff", which is not a reason to pay for the roster's most
// expensive lens. `failure-windows` is gated on the scout having CHOSEN `reconciler` (controller
// code); nothing else here yet, and the list exists so the next such lens has somewhere to be
// declared rather than becoming a fourth blanket exception.
export const CONDITIONAL_LENSES = ['failure-windows']

// realm @nick/craft #102: each expensive whole-repo lens fires only if the diff touches the surface its defect class needs; fail-open.
// The map is lens → the `scout.surfaces` boolean that must not be affirmatively `false` for the lens
// to run. A missing surfaces object, a missing key, or `true` all KEEP the lens (see the gate in
// reviewProfile): a lens is dropped only where the scout said, in so many words, the surface is absent.
// `wireForm` names every contract another version reads, calls or deploys against (stored and wire
// data, CLI/config/env/chart surface, API/schema versions, exported names): the compat lens covers
// all of them, so a narrower surface would gate it out of the diffs it now exists for.
/** @type {Record<string, keyof NonNullable<ScoutAnswer['surfaces']>>} */
export const SURFACE_GATED_LENSES = { 'negative-space': 'crossBoundarySymbol', 'compat': 'wireForm', 'invariants': 'invariantType' }


// ================= The optional pass =================
// Three lenses that do not earn a place on every run. The basis is NOT equal across them: only
// `ownership` (retired, not here) has three independent counts. The two earlier store-wide counts
// named api-idioms and performance among the bottom four; `api-boundary` was not in them at all, so
// for the composition of THIS trio the basis is ONE run — one diff, one repository, one domain
// (realm @nick/craft, node #20, which requires that limit to be stated rather than dropped).
// Measured over runs of the
// budget-deterministic engine against a large Rust diff (14 lenses × 3 rounds, 215 findings):
// `performance` (15 findings, 12 of them Low/Info), `api-idioms` (14/10) and `api-boundary` (11/7)
// returned hundreds of CONFIRMED Medium-and-below findings and NOT ONE High in any of the three.
// Deleting them would make the review worse — the findings are real. Paying three full agents for
// them on every run is the part the numbers do not support. So they leave every automatic path and
// stay reachable by an explicit request.
//
// The failure mode this must not become is the one this repo keeps hitting: a run that never looked
// at performance reading as a run that found nothing wrong with it. So the skipped set is stated
// MECHANICALLY — `optionalSection()`, appended by `out()` to every report the engine can return,
// never asked of the synthesis model, which can die or simply not obey — and filed on the run
// record as `optionalPass`.
//
// STRICT MODE AND THE SECURITY FLOOR TOUCH THIS IN NEITHER DIRECTION, and that is a decision, not
// an omission.
//   · `strict` is the harsh MAINTAINABILITY bar: it forces the maintainability lens and turns its
//     confirmed findings into presumptive blockers. Letting it also buy three unrelated lenses
//     would make one flag mean two things, and would deliver the optional pass to a caller who
//     asked for something else.
//   · The security-sensitive floor expands `blanketLenses()`, and `blanketLenses()` excludes the optional set
//     exactly as it excludes CONDITIONAL_LENSES. A floor is a statement of IGNORANCE about the
//     diff, and ignorance is not a reason to buy the three lenses that measured worst.
//   · Neither may silently DISABLE it either: an explicit `optional=` request is honoured on every
//     path, including a security-floored run and a strict one. The request is the only switch.
export const OPTIONAL_LENSES = ['performance', 'api-idioms', 'api-boundary']

// `optional=true` / `--optional` / `optional=all` buys the whole set; `optional=performance,api-boundary`
// (or a JSON array) buys those. Absent buys none.
// An unrecognised name is REFUSED LOUDLY rather than dropped: `optional=perf` that quietly buys
// nothing, on a run whose whole point was to buy something, is the exact silence this section exists
// to prevent — and the run would then report the lens as skipped while the caller believed otherwise.
/** The values that buy no optional lens, and those that buy the whole set (compared as `===` would). */
/** @type {unknown[]} */
const OPTIONAL_NONE = [undefined, null, '', false, 'false', 'none']
/** @type {unknown[]} */
const OPTIONAL_ALL = [true, 'true', 'all']
/** @param {unknown} raw */
export function parseOptionalRequest(raw) {
  if (OPTIONAL_NONE.includes(raw)) return { lenses: [], unknown: [] }
  if (OPTIONAL_ALL.includes(raw)) return { lenses: [...OPTIONAL_LENSES], unknown: [] }
  const names = (Array.isArray(raw) ? /** @type {unknown[]} */ (raw) : String(raw).split(/[\s,]+/)).map((/** @type {unknown} */ x) => String(x).trim()).filter(Boolean)
  return { lenses: names.filter(n => OPTIONAL_LENSES.includes(n)), unknown: names.filter(n => !OPTIONAL_LENSES.includes(n)) }
}

/**
 * The run's tallies of the optional and surface-gated lenses, and the report sections they render.
 * @param {string[]} optionalRequested  the optional lenses the caller asked for
 * @param {ProfileResult[]} results  the per-profile results, filled as the profiles run
 */
export function makeLensTallies(optionalRequested, results) {
// The optional tally is DERIVED, never accumulated. `ran`/`skipped` used to be snapshotted off the
// plan the moment it was built — but the plan is not final there: the completeness critic composes
// lenses much later, on the synthesis phase. Any such later road made the snapshot a LIE in the one
// direction that matters, printing "not looked at" over a lens whose findings were in the report.
// So the tally rests only on what cannot be second-guessed: which optional lenses each profile past
// its mechanical gate could have bought at all (its `optionalScope`, returned on `results`), and
// which ones were actually DISPATCHED (recorded by `runLens`, the single dispatch point for every
// lens on every path — planned, resurrected, or critic-composed). optionalTallyFrom
// (lib/profile-merge.mjs) subtracts, naming each lens once across profiles.
/** @type {Set<string>} */
const optionalDispatched = new Set()
// An optional lens the completeness critic named as an uncovered surface. It is NOT bought (the
// critic is the same model whose spend this pass deliberately took out of model hands), but the
// signal is real and must reach the reader rather than die in the filter.
/** @type {Set<string>} */
const optionalNamedByCritic = new Set()
const optionalTally = () => optionalTallyFrom(results, optionalDispatched, optionalRequested)
// Appended by `out()`, so it reaches every report that has a skipped list to show — the synthesized
// one and the mechanical fallback. The earliest exits (no diff) run before any profile is planned, so
// the list is empty there. A red-gated profile contributes only lenses the caller explicitly requested
// (it aborts before any lens could run), so a default run on which every profile carrying optional
// lenses is red emits no section; a passing profile on a mixed red run still contributes its whole
// scope, and the section then names the gate first. It says "absence of a result", never "no
// problems found".
const optionalSection = () => {
  const skipped = optionalTally().skipped
  if (!skipped.length) return ''
  const named = skipped.filter(l => optionalNamedByCritic.has(l))
  // A red mechanical gate blocks the whole review on its own, so "buy them with optional=…" is the
  // wrong next step there: lenses the caller already requested need no new request, and the rest are
  // beside the point until the gate is green (realm @nick/craft #109).
  if (failedProfiles(results).length) {
    const unrequested = skipped.filter(l => !optionalRequested.includes(l))
    // The critic only ever names an unrequested lens, so it is already in the one optional= offer
    // above; here it is a signal for the re-run, not a second instruction.
    const criticHint = named.length ? `\n⚠️ The completeness critic named ${named.join(', ')} as an uncovered surface for THIS diff. It was not dispatched; once the gate is green, weigh including it in that re-run.\n` : ''
    return `\n\n## Not looked at — the optional pass did not run\n⚠️ These lenses were NOT dispatched, so this review makes NO statement about what they cover: ${skipped.join(', ')}. That is an absence of a result, not a clean one. The mechanical gate is red, which blocks this review by itself — fix the gate first.${unrequested.length ? ` ${unrequested.join(', ')} ${unrequested.length === 1 ? 'is' : 'are'} off by default; add \`optional=${unrequested.join(',')}\` to the re-run only if you want ${unrequested.length === 1 ? 'it' : 'them'}.` : ''}\n` + criticHint
  }
  const criticLine = named.length ? `\n⚠️ The completeness critic named ${named.join(', ')} as an uncovered surface for THIS diff. It was still not dispatched — the optional pass is bought by an explicit request, not by a model mid-run — so buy it deliberately with \`optional=${named.join(',')}\`.\n` : ''
  return `\n\n## Not looked at — the optional pass did not run\n⚠️ These lenses were NOT dispatched, so this review makes NO statement about what they cover: ${skipped.join(', ')}. That is an absence of a result, not a clean one. They are off by default because they returned no High findings on the run that was measured — one diff of one repository, so the basis is a single point, not a settled law; to buy them, re-run with \`optional=true\` (or \`optional=${skipped.join(',')}\`).\n`
    + criticLine
}

// realm @nick/craft #102. Mirrors optionalSection(): derived from the per-profile results of
// reviewProfile's surface gate and appended by out(), so it reaches every report the engine can return, and stated
// MECHANICALLY rather than asked of the synthesis model (which can die or not obey). A whole-repo
// lens is dropped when the diff does not touch the surface its defect class needs — that is an
// ABSENCE of a result for those areas, NOT an approval of them.
// The drops themselves come back PER PROFILE on `results` (`surfaceDropped`) and are merged by
// savedSurfaceDrops (lib/profile-merge.mjs), which keeps only profiles past their gate and subtracts
// what ran elsewhere. `results` is handed in before any profile runs, because out() reads it through
// surfaceGateSection() on every early exit too — where it is simply still empty.
// Mirrors optionalDispatched: a surface-gated lens actually DISPATCHED in some profile, recorded by
// runLens (the single dispatch point on every path). The gate is a PER-PROFILE decision reading each
// profile's own scout, and negative-space is force-added to every plan — so on a mixed rust+nix diff a
// lens the gate drops in one profile can still run in another. The per-profile drops alone would then
// report a lens as saved while it actually ran, corrupting #102's savings measurement — the same
// snapshot-is-a-lie failure `optionalTally()` already fixed. savedSurfaceDrops subtracts what ran.
/** @type {Set<string>} */
const surfaceGateDispatched = new Set()
// Mirrors optionalNamedByCritic: a surface-gated lens the completeness critic named as an uncovered
// surface. It is NOT re-dispatched (the diff's absent surface is the deliberate boundary, and the
// critic is the same model whose spend this pass took out of model hands), but the signal is real and
// must reach the reader rather than die in the filter.
/** @type {Set<string>} */
const surfaceGateNamedByCritic = new Set()
// The run-level truth, DERIVED not accumulated (mirrors optionalTally): a lens counts as
// surface-gate-dropped only if the gate dropped it in a profile PAST its mechanical gate AND it ran
// in NO active profile.
const surfaceGateTally = () => ({ dropped: savedSurfaceDrops(results, surfaceGateDispatched) })
const surfaceGateSection = () => {
  const gateDropped = surfaceGateTally().dropped
  if (!gateDropped.length) return ''
  // `dropped` already subtracts what ran, so a critic-named lens that ran somewhere is not a gap.
  const named = gateDropped.filter(l => surfaceGateNamedByCritic.has(l))
  return `\n\n## Not run — the diff does not touch the surface these lenses need\n⚠️ These whole-repo lenses were NOT dispatched, so this review makes NO statement about what they cover: ${gateDropped.join(', ')}. Each fires only when the diff touches the surface its defect class needs (a cross-boundary symbol, a wire/serialized form, an invariant-bearing type), and this diff does not. That is an absence of a result, not a clean one.\n`
    + (named.length ? `\n⚠️ The completeness critic named ${named.join(', ')} as an uncovered surface for THIS diff. It was still NOT dispatched — the surface gate is the deliberate boundary, not something a model re-opens mid-run — so treat this as a visible gap, not a clean pass.\n` : '')
}
return { optionalDispatched, optionalNamedByCritic, optionalTally, optionalSection, surfaceGateDispatched, surfaceGateNamedByCritic, surfaceGateSection }
}
