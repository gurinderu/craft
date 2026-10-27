// How one profile's change is cut for unitScope (src/review.js, Lenses phase; realm @nick/craft, transformation
// #324): the unit probe and the unit slices (#319, #355), the fallback to the directory slicing with the notice
// that says why (#362), and the shape of each round's lens dispatches over those slices, a sectioned agent's
// findings and questions each under its own lens. The run-time scope built on them — coordinator, questions,
// seam pass, contract lens — is lib/review-unit-scope.mjs.
import { sliceDiff, partitionOwned } from './lens-scope.mjs'
import { unitRootOf, touchedUnits, UNIT_MIN_FILES } from './unit-scope.mjs'
import { parsePackageLines, parseNumstat } from './unit-graph.mjs'
import { unitBatchPlan } from './review-unit-batches.mjs'
import { UNITS_SCHEMA, multiLensSchema } from './review-unit-schemas.mjs'

/**
 * @typedef {import('./review-run.mjs').ReviewRun} ReviewRun
 * @typedef {import('./review-profiles.mjs').Profile} Profile
 * @typedef {import('./review-plan.mjs').Plan} Plan
 * @typedef {import('./unit-scope.mjs').UnitGroup} Slice
 * @typedef {import('./unit-graph.mjs').UnitDiscovery} UnitDiscovery
 * @typedef {import('./review-unit-schemas.mjs').QuestionAnswer} QuestionAnswer
 * @typedef {{ lens: string, members: string[], slice: Slice | null, tag: string }} LensDispatch
 */

// The profile's unit probe, one cheap agent. A dead or malformed answer is not "no unit in the change": its
// notice names the failed probe (#362) by `probeFailed`; the lenses then run fully in the normal mode.
/** @param {ReviewRun} reviewRun @param {Profile} profile @param {UnitDiscovery} discovery @param {string} range */
async function probeUnits(reviewRun, profile, discovery, range) {
  let failure = 'returned no result'
  const r = await reviewRun.ragent(discovery.probePrompt(range), { label: `units:${profile.id}`, phase: 'Lenses', schema: UNITS_SCHEMA, model: 'haiku', effort: 'low' })
    .catch((/** @type {unknown} */ e) => { failure = String((e && /** @type {{ message?: unknown }} */ (e).message) || e).slice(0, 160); return null })
  if (r && (Array.isArray(r.roots) || Array.isArray(r.packages))) return { r, probeFailed: '' }
  return { r: null, probeFailed: r ? 'answered off-schema (no roots and no packages)' : failure }
}

/**
 * The slices of one profile: unit batches under unitScope (#355) unless unitBatches=false (one per unit
 * then); the directory slicing, exactly as with the flag off, when the mode cannot run — `off` says why: no
 * discovery, a failed probe, no unit in the change, or a change too small to slice by unit. The probe is
 * the profile's, one cheap agent: the unit roots with their sizes and dependencies, and the diff's numstat.
 * @param {ReviewRun} reviewRun
 * @param {{ profile: Profile, plan: Plan, changedFiles: string[], lensDiffRange: () => string, discovery: UnitDiscovery | null }} ctx
 * @returns {Promise<{ roots: string[], units: string[], slices: Slice[], sectioned: string[], batches: ReturnType<typeof unitBatchPlan> | null, off: { why: string } | null }>}
 */
async function unitSlicing(reviewRun, { profile, plan, changedFiles, lensDiffRange, discovery }) {
  const owns = (/** @type {string} */ f) => profile.detect([f])
  /** @param {{ why: string }} off @param {string[]} [found] */
  const normal = (off, found = []) => ({ roots: found, units: /** @type {string[]} */ ([]), slices: sliceDiff(changedFiles, { owns }), sectioned: [], batches: null, off })
  if (!discovery) return normal({ why: `not available for ${profile.lang}: its profile finds no units` })
  const { r, probeFailed } = await probeUnits(reviewRun, profile, discovery, lensDiffRange())
  if (!r) return normal({ why: `skipped, the ${discovery.noun} probe failed on the ${profile.lang} change (${probeFailed})` })
  const packages = parsePackageLines(r.packages, discovery.nameKey)
  const roots = [...new Set([...(Array.isArray(r.roots) ? r.roots.map(unitRootOf) : []), ...packages.map(p => p.root)])]
  const units = touchedUnits(changedFiles, roots)
  if (!units.length) return normal({ why: `found no ${discovery.noun} in the ${profile.lang} change` }, roots)
  const batches = unitBatchPlan({ lenses: plan.lenses, changedFiles, roots, packages, numstat: parseNumstat(r.numstat), owns, batched: !!reviewRun.unitBatches, batchBudget: reviewRun.unitBatchBudget, agentCeiling: reviewRun.unitAgentCeiling, costModel: reviewRun.costModelArg })
  // The slicer's "do not slice" is the same fallback: no contract, no seam, no coordinator (#362).
  if (!batches.slices.length) {
    const owned = partitionOwned(changedFiles, owns).owned.length
    return normal({ why: `skipped, change too small to slice: ${owned < UNIT_MIN_FILES ? `${owned} files` : `one ${discovery.noun} (${units.join(', ')})`}` }, roots)
  }
  return { roots, units, slices: batches.slices, sectioned: batches.sectioned, batches, off: null }
}

/**
 * The slices of one profile (unitSlicing), and — when the run asked for unitScope and got the normal mode —
 * its one warning line in the log and the report (realm @nick/craft, #362). A failed probe is a warning too,
 * not a coverage hole: the lenses ran fully in the normal mode.
 * @param {ReviewRun} reviewRun
 * @param {{ profile: Profile, plan: Plan, changedFiles: string[], lensDiffRange: () => string, discovery: UnitDiscovery | null }} ctx
 */
export async function profileSlices(reviewRun, ctx) {
  const sliced = await unitSlicing(reviewRun, ctx)
  const { off } = sliced
  if (reviewRun.unitScope && off) {
    reviewRun.unitNotices.push(`Unit mode ${off.why} — the review ran in the normal mode.`)
    reviewRun.sb.log(`⚠️ [${ctx.profile.id}] unitScope: ${off.why} — directory slicing kept`)
  }
  return sliced
}

/**
 * The shape of one profile's lens dispatches over its slices: each lens per slice, the sectioned lenses of a
 * unit batch as one agent, each finding counted under its own lens.
 * @param {{ plan: Plan, slices: Slice[], sectioned: string[], channel: string, tel: { untaggedFindings?: number } }} s
 */
export function unitDispatch({ plan, slices, sectioned, channel, tel }) {
  const bundle = sectioned.join('+')
  /** @param {Slice | null} slice @param {number} round */
  const tag = (/** @type {string} */ lens, slice, round) => (channel && slice?.unit ? `${lens}-s${slices.indexOf(slice)}r${round}` : '')
  return {
    tag,
    /**
     * One round's lens dispatches: each lens per slice, the sectioned lenses of a unit batch as one agent.
     * @param {(lens: string) => Array<Slice | null>} slicesFor @param {number} round @returns {LensDispatch[]}
     */
    dispatches: (slicesFor, round) => plan.lenses.flatMap(lens => slicesFor(lens).flatMap(slice => {
      if (!sectioned.includes(lens) || !slice?.unit) return [{ lens, members: [lens], slice, tag: tag(lens, slice, round) }]
      return lens === sectioned[0] ? [{ lens: bundle, members: sectioned, slice, tag: tag(bundle, slice, round) }] : []
    })),
    /** A sectioned agent's schema, null for one lens. @param {string[]} members */
    schemaFor: members => (members.length > 1 ? multiLensSchema(members) : null),
    /** The lens a finding of a dispatch counts under: its own lens, or the section it names. @param {string[]} members @param {unknown} source */
    sourceOf: (members, source) => {
      if (members.length === 1) return String(members[0])
      if (members.includes(String(source))) return String(source)
      tel.untaggedFindings = (tel.untaggedFindings ?? 0) + 1
      return bundle
    },
    /**
     * Resurrection attempts with the sectioned lenses of one unit slice merged back into one agent.
     * @param {Array<{ lens: string, slice: Slice | null }>} attempts @returns {Array<{ lens: string, members: string[], slice: Slice | null }>}
     */
    regroup: attempts => {
      /** @type {Map<Slice, string[]>} */
      const bySlice = new Map()
      /** @type {Array<{ lens: string, members: string[], slice: Slice | null }>} */
      const out = []
      for (const a of attempts) {
        if (a.slice?.unit && sectioned.includes(a.lens)) bySlice.set(a.slice, [...(bySlice.get(a.slice) || []), a.lens])
        else out.push({ lens: a.lens, members: [a.lens], slice: a.slice })
      }
      for (const [slice, ms] of bySlice) out.push(ms.length > 1 ? { lens: ms.join('+'), members: ms, slice } : { lens: String(ms[0]), members: ms, slice })
      return out
    },
  }
}

// One lens question as kept for the seam pass: with the lens that asked, or, from a sectioned agent, with the
// section it names — the bundle's name when it names none, as an untagged finding counts.
/** @param {QuestionAnswer} q @param {string} lens @param {string[] | undefined} members @returns {QuestionAnswer & { lens: string }} */
export function questionOf(q, lens, members) {
  const { source, ...rest } = q
  return { ...rest, lens: members && members.length > 1 && members.includes(String(source)) ? String(source) : lens }
}
