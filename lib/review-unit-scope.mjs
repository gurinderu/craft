// One profile's unitScope state and steps (src/review.js, Lenses phase; realm @nick/craft, transformation
// #324): the unit slices (#319), the confined lens's unit rule and question channel (#320, #316), the live
// coordinator of each round and the seam pass before verification (#321), and the contract lens per touched
// unit (#327). A unit is what the profile's unit discovery finds (`profile.units`, realm #362; Rust's crates
// in lib/rust-units.mjs). Off, on a profile with no discovery, a failed probe, no unit in the change or one
// too small to slice by unit, it is the directory slicing and every step a no-op — the lens rounds then
// dispatch exactly as before, and a run that asked for the mode says in its report why it did not get it.
import { sliceDiff, partitionOwned, LENS_WINDOW_AGENTS } from './lens-scope.mjs'
import { deadlineArm } from './agent-deadline.mjs'
import { deadlineMsFor } from './review-deadlines.mjs'
import { unitRootOf, touchedUnits, questionTally, UNIT_MIN_FILES } from './unit-scope.mjs'
import { parsePackageLines, parseNumstat } from './unit-graph.mjs'
import { unitBatchPlan } from './review-unit-batches.mjs'
import { applyDispositions } from './unit-seam.mjs'
import { contractPrompt, coordinatorPrompt, seamPrompt, stopPrompt } from './review-unit-prompts.mjs'
import { UNITS_SCHEMA, COORD_SCHEMA, SEAM_SCHEMA, STOP_SCHEMA, multiLensSchema } from './review-unit-schemas.mjs'

/**
 * @typedef {import('./review-run.mjs').ReviewRun} ReviewRun
 * @typedef {import('./review-profiles.mjs').Profile} Profile
 * @typedef {import('./review-plan.mjs').Plan} Plan
 * @typedef {import('./review-schemas.mjs').Finding} Finding
 * @typedef {import('./unit-scope.mjs').UnitGroup} Slice
 * @typedef {import('./review-unit-schemas.mjs').QuestionAnswer} QuestionAnswer
 * @typedef {import('./review-unit-schemas.mjs').CoordAnswer} CoordAnswer
 * @typedef {import('./unit-graph.mjs').UnitDiscovery} UnitDiscovery
 * @typedef {{ language: string, roots: number, units: number, slices: number, channel: boolean, window: number,
 *   coordinators: number, coordinatorAnswered: number, releaseFailed: number, releaseTimedOut: number,
 *   questions: ReturnType<typeof questionTally>, resurrectedConfined: number, resurrectedUnconfined: number, resurrectedContract: number,
 *   seam: { ran: boolean, retried: boolean, findings: number, answered: number, dispositions: { confirm: number, drop: number, convert: number }, setAside: import('./unit-seam.mjs').SetAside[] },
 *   unitBatches?: import('./review-unit-batches.mjs').BatchRow[] | null, sectioned?: string[], untaggedFindings?: number,
 *   costEstimate?: import('./review-unit-batches.mjs').CostEstimate }} UnitRun
 * @typedef {{ lens: string, members: string[], slice: Slice | null, tag: string }} LensDispatch
 */

// How long a round waits for its coordinator to return once released. The coordinator polls in 100 s calls,
// so a released one answers well inside this; past it the round goes on and the record says so.
export const RELEASE_GRACE_MS = 240000

/**
 * Release one round's coordinator: write its stop file, then wait for its answer — never past `graceMs`,
 * so a failed stop write or a stuck coordinator cannot hold the review.
 * @template T
 * @param {{ writeStop: () => Promise<boolean>, coord: Promise<T | null>, graceMs: number, arm?: (fn: () => void, ms: number) => () => void }} r
 * @returns {Promise<{ stopped: boolean, answer: T | null, timedOut: boolean }>}
 */
export async function releaseCoordinator({ writeStop, coord, graceMs, arm = deadlineArm(undefined, undefined) }) {
  const stopped = await writeStop().catch(() => false)
  /** @type {() => void} */
  let disarm = () => {}
  const late = { late: true }
  const timer = new Promise(resolve => { disarm = arm(() => resolve(late), graceMs) })
  const settled = await Promise.race([coord.catch(() => null), timer])
  disarm()
  return settled === late ? { stopped, answer: null, timedOut: true } : { stopped, answer: /** @type {T | null} */ (settled), timedOut: false }
}

// The profile's unit probe, one cheap agent. A dead or malformed answer is not "no unit in the change": it is
// a hole in what the run could see (#362), named by `probeFailed`.
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
 * @returns {Promise<{ roots: string[], units: string[], slices: Slice[], sectioned: string[], batches: ReturnType<typeof unitBatchPlan> | null, off: { why: string, probeFailed?: string } | null }>}
 */
async function unitSlicing(reviewRun, { profile, plan, changedFiles, lensDiffRange, discovery }) {
  const owns = (/** @type {string} */ f) => profile.detect([f])
  /** @param {{ why: string, probeFailed?: string }} off @param {string[]} [found] */
  const normal = (off, found = []) => ({ roots: found, units: /** @type {string[]} */ ([]), slices: sliceDiff(changedFiles, { owns }), sectioned: [], batches: null, off })
  if (!discovery) return normal({ why: `not available for ${profile.lang}: its profile finds no units` })
  const { r, probeFailed } = await probeUnits(reviewRun, profile, discovery, lensDiffRange())
  if (!r) return normal({ why: `skipped, the ${discovery.noun} probe failed on the ${profile.lang} change (${probeFailed})`, probeFailed })
  const packages = parsePackageLines(r.packages, discovery.nameKey)
  const roots = [...new Set([...(Array.isArray(r.roots) ? r.roots.map(unitRootOf) : []), ...packages.map(p => p.root)])]
  const units = touchedUnits(changedFiles, roots)
  if (!units.length) return normal({ why: `found no ${discovery.noun} in the ${profile.lang} change` }, roots)
  const batches = unitBatchPlan({ lenses: plan.lenses, changedFiles, roots, packages, numstat: parseNumstat(r.numstat), owns, batched: !!reviewRun.unitBatches, batchBudget: reviewRun.unitBatchBudget, costModel: reviewRun.costModelArg })
  // The slicer's "do not slice" is the same fallback: no contract, no seam, no coordinator (#362).
  if (!batches.slices.length) {
    const owned = partitionOwned(changedFiles, owns).owned.length
    return normal({ why: `skipped, change too small to slice: ${owned < UNIT_MIN_FILES ? `${owned} files` : `one ${discovery.noun} (${units.join(', ')})`}` }, roots)
  }
  return { roots, units, slices: batches.slices, sectioned: batches.sectioned, batches, off: null }
}

/**
 * @param {ReviewRun} reviewRun
 * @param {{ profile: Profile, plan: Plan, changedFiles: string[], lensDiffRange: () => string }} ctx
 */
export async function openUnitScope(reviewRun, { profile, plan, changedFiles, lensDiffRange }) {
  const { ragent, unitRuns } = reviewRun
  const { log: logLine } = reviewRun.sb
  const asked = (reviewRun.unitScope && profile.units) || null
  const { roots, units, slices, sectioned, batches, off } = await unitSlicing(reviewRun, { profile, plan, changedFiles, lensDiffRange, discovery: asked })
  const discovery = off ? null : asked
  const on = !!discovery
  const bundle = sectioned.join('+')
  const probeNotRun = noteUnavailable(reviewRun, profile, off)
  const confined = slices.filter(g => g.unit).length
  const channel = on && confined && reviewRun.runDir ? `${reviewRun.runDir}/unit-${profile.id}` : ''
  /** @type {Array<QuestionAnswer & { lens: string }>} */
  const questions = []
  /** @type {UnitRun} */
  const tel = { language: profile.id, roots: roots.length, units: units.length, slices: confined, channel: !!channel, window: LENS_WINDOW_AGENTS - (channel ? 1 : 0),
    coordinators: 0, coordinatorAnswered: 0, releaseFailed: 0, releaseTimedOut: 0, questions: questionTally([]), resurrectedConfined: 0, resurrectedUnconfined: 0, resurrectedContract: 0,
    seam: { ran: false, retried: false, findings: 0, answered: 0, dispositions: { confirm: 0, drop: 0, convert: 0 }, setAside: [] } }
  if (batches) Object.assign(tel, { unitBatches: batches.unitBatches, sectioned, untaggedFindings: 0, costEstimate: batches.costEstimate })
  if (on) unitRuns.push(tel)

  /** The questions of settled lens answers, each with the lens that asked. @param {Array<{ __lens: string, __members?: string[], questions?: unknown }>} landed */
  const keepQuestions = landed => { for (const r of landed) if (Array.isArray(r.questions)) questions.push(...r.questions.map(q => questionOf(q, r.__lens, r.__members))) }
  /** @param {Slice | null} slice @param {number} round */
  const tag = (/** @type {string} */ lens, slice, round) => (channel && slice?.unit ? `${lens}-s${slices.indexOf(slice)}r${round}` : '')
  return {
    on, slices, notRun: probeNotRun, keepQuestions,
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
    // One slot of the lens window is the coordinator's, so a round never runs a 17th agent (#325).
    window: tel.window,
    tag,
    /** The unit rule of a dispatch, null off or on a slice outside every unit. @param {Slice | null} slice @param {string} t */
    unitOf: (slice, t) => (discovery && slice?.unit ? { root: slice.unit, roots: slice.units ?? [slice.unit], channel, tag: t, kind: discovery } : null),
    /** @param {Slice} slice @param {string} priorSummary */
    contractPrompt: (slice, priorSummary) => contractPrompt({ root: slice.unit || '.', lang: profile.lang, kind: /** @type {UnitDiscovery} */ (discovery), range: lensDiffRange(), priorSummary }),
    /** The contract lens of each touched unit, dispatched in round 1 only. @param {number} round */
    contracts: round => (on && round === 1 ? units.map(c => ({ lens: 'contract', members: ['contract'], slice: /** @type {Slice} */ ({ key: `unit:${c}`, files: [], unit: c }), tag: '' })) : []),
    /** The live coordinator of one round, dispatched beside its lenses; null with no channel lens. @param {number} round @param {Array<{ tag: string }>} ds */
    coordinate: (round, ds) => {
      const expected = ds.filter(d => d.tag).length
      if (!channel || !expected) return null
      tel.coordinators++
      const capMinutes = Math.max(1, Math.round(deadlineMsFor({ phase: 'Lenses' }, reviewRun.deadlineArg) / 60000))
      return ragent(coordinatorPrompt({ lang: profile.lang, noun: String(discovery?.noun), channel, round, expected, capMinutes }), { label: `coord:${profile.id} r${round}`, phase: 'Lenses', model: plan.lensModel, schema: COORD_SCHEMA }).catch(() => null)
    },
    /**
     * The round's lenses settled: their questions kept, each with the lens that asked — a sectioned agent's with
     * the section its question names, the lens its dependent finding counts under (sourceOf); the coordinator released.
     * @param {number} round @param {Promise<CoordAnswer | null> | null} coord @param {Array<{ __lens: string, __members?: string[], questions?: unknown }>} landed
     */
    settle: async (round, coord, landed) => {
      keepQuestions(landed)
      if (!coord) return
      const writeStop = async () => !!(await ragent(stopPrompt(channel, round), { label: `coord-stop:${profile.id} r${round}`, phase: 'Lenses', model: 'haiku', effort: 'low', schema: STOP_SCHEMA }))?.written
      const { stopped, answer, timedOut } = await releaseCoordinator({ writeStop, coord, graceMs: RELEASE_GRACE_MS })
      if (!stopped) tel.releaseFailed++
      if (timedOut) { tel.releaseTimedOut++; logLine(`⚠️ [${profile.id}] unitScope: round ${round} coordinator did not return within ${RELEASE_GRACE_MS / 60000} min of its release${stopped ? '' : ' (its stop file was not written)'} — the review goes on without it`) }
      tel.coordinatorAnswered += Number(answer?.answered) || 0
    },
    /**
     * A resurrected dispatch: confined (its slice and unit rule kept, no coordinator to ask), unsliced, or a contract lens on its unit.
     * @param {'confined' | 'unconfined' | 'contract'} kind
     */
    noteResurrected: kind => { if (kind === 'contract') tel.resurrectedContract++; else if (kind === 'confined') tel.resurrectedConfined++; else tel.resurrectedUnconfined++ },
    /**
     * Before verification: the seam between the touched units, the open questions, and a disposition for
     * each finding that depends on one. Its findings join the pool as `seam`.
     * @param {Finding[]} pool @param {Set<string>} seen @param {string[]} notRun @param {(found: Finding[], seen: Set<string>, pool: Finding[]) => void} pushUnseen
     */
    seam: async (pool, seen, notRun, pushUnseen) => {
      tel.questions = questionTally(questions)
      if (!on || !units.length) return
      const open = questions.filter(q => !q.answered)
      // A dead seam pass is retried once, like a dead lens in the resurrection sweep; the record says it was.
      const pass = (/** @type {string} */ suffix) => ragent(seamPrompt({ lang: profile.lang, kind: /** @type {UnitDiscovery} */ (discovery), units, range: lensDiffRange(), open }), { label: `seam:${profile.id}${suffix}`, phase: 'Lenses', model: plan.lensModel, schema: SEAM_SCHEMA }).catch(() => null)
      let s = await pass('')
      if (!s || !Array.isArray(s.findings)) { tel.seam.retried = true; s = await pass(' retry') }
      if (!s || !Array.isArray(s.findings)) return void notRun.push(`${profile.id} seam pass (unitScope) — returned no findings`)
      const { kept, counts, setAside } = applyDispositions(pool, s.dispositions, open)
      pool.splice(0, pool.length, ...kept)
      pushUnseen(s.findings.map(f => ({ ...f, source: 'seam' })), seen, pool)
      tel.seam = { ran: true, retried: tel.seam.retried, findings: s.findings.length, answered: Number(s.answered) || 0, dispositions: counts, setAside }
    },
    /** The unit lenses that fully ran. @param {Set<string>} expected @param {Set<string>} returned */
    ran: (expected, returned) => [
      ...(units.length && [...expected].every(k => !k.startsWith('contract :: ') || returned.has(k)) ? ['contract'] : []),
      ...(tel.seam.ran ? ['seam'] : []),
    ],
    /** The record's extra dimension rows: contract and seam, on a profile whose change touched a unit. */
    dimensions: () => (on && units.length ? ['contract', 'seam'] : []),
  }
}

// A run that asked for unitScope and got the normal mode on this profile says why, in its log and its report
// (realm @nick/craft, #362): no unit discovery, a failed probe, no unit in the change, or one too small to slice.
// A failed probe is also a coverage hole: the notRun line it returns.
/** @param {ReviewRun} reviewRun @param {Profile} profile @param {{ why: string, probeFailed?: string } | null} off @returns {string[]} */
function noteUnavailable(reviewRun, profile, off) {
  if (!reviewRun.unitScope || !off) return []
  reviewRun.unitNotices.push(`Unit mode ${off.why} — the review ran in the normal mode.`)
  reviewRun.sb.log(`⚠️ [${profile.id}] unitScope: ${off.why} — directory slicing kept`)
  return off.probeFailed ? [`${profile.id} unit probe (unitScope) — ${off.probeFailed}; the review ran in the normal mode`] : []
}

// One lens question as kept for the seam pass: with the lens that asked, or, from a sectioned agent, with the
// section it names — the bundle's name when it names none, as an untagged finding counts.
/** @param {QuestionAnswer} q @param {string} lens @param {string[] | undefined} members @returns {QuestionAnswer & { lens: string }} */
function questionOf(q, lens, members) {
  const { source, ...rest } = q
  return { ...rest, lens: members && members.length > 1 && members.includes(String(source)) ? String(source) : lens }
}
