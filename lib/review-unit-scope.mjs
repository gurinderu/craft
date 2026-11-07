// One profile's unitScope state and steps (src/review.js, Lenses phase; realm @nick/craft, transformation
// #324) over the slices of lib/review-unit-slicing.mjs (#319): the confined lens's unit rule and question
// channel (#320, #316), the live coordinator of each round and the seam pass before verification (#321), and
// the contract lens per touched unit (#327). Where the mode cannot run (#362) it is the directory slicing and
// every step a no-op — the lens rounds then dispatch exactly as before.
import { LENS_WINDOW_AGENTS } from './lens-scope.mjs'
import { deadlineArm } from './agent-deadline.mjs'
import { deadlineMsFor } from './review-deadlines.mjs'
import { questionTally } from './unit-scope.mjs'
import { applyDispositions } from './unit-seam.mjs'
import { contractPrompt, coordinatorPrompt, seamPrompt, stopPrompt } from './review-unit-prompts.mjs'
import { COORD_SCHEMA, SEAM_SCHEMA, STOP_SCHEMA } from './review-unit-schemas.mjs'
import { profileSlices, unitDispatch } from './review-unit-slicing.mjs'

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
 *   unitBatches?: import('./review-unit-batches.mjs').BatchRow[] | null,
 *   costEstimate?: import('./review-unit-batches.mjs').CostEstimate }} UnitRun
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

/**
 * @param {ReviewRun} reviewRun
 * @param {{ profile: Profile, plan: Plan, changedFiles: string[], lensDiffRange: () => string }} ctx
 */
export async function openUnitScope(reviewRun, { profile, plan, changedFiles, lensDiffRange }) {
  const { ragent, unitRuns } = reviewRun
  const { log: logLine } = reviewRun.sb
  const asked = (reviewRun.unitScope && profile.units) || null
  const { roots, units, slices, batches, off } = await profileSlices(reviewRun, { profile, plan, changedFiles, lensDiffRange, discovery: asked })
  const discovery = off ? null : asked
  const on = !!discovery
  const confined = slices.filter(g => g.unit).length
  const channel = on && confined && reviewRun.runDir ? `${reviewRun.runDir}/unit-${profile.id}` : ''
  /** @type {Array<QuestionAnswer & { lens: string }>} */
  const questions = []
  /** @type {UnitRun} */
  const tel = { language: profile.id, roots: roots.length, units: units.length, slices: confined, channel: !!channel, window: LENS_WINDOW_AGENTS - (channel ? 1 : 0),
    coordinators: 0, coordinatorAnswered: 0, releaseFailed: 0, releaseTimedOut: 0, questions: questionTally([]), resurrectedConfined: 0, resurrectedUnconfined: 0, resurrectedContract: 0,
    seam: { ran: false, retried: false, findings: 0, answered: 0, dispositions: { confirm: 0, drop: 0, convert: 0 }, setAside: [] } }
  if (batches) Object.assign(tel, { unitBatches: batches.unitBatches, costEstimate: batches.costEstimate })
  if (on) unitRuns.push(tel)

  /** The questions of settled lens answers, each with the lens that asked. @param {Array<{ __lens: string, questions?: unknown }>} landed */
  const keepQuestions = landed => { for (const r of landed) if (Array.isArray(r.questions)) questions.push(...r.questions.map((/** @type {QuestionAnswer} */ q) => ({ ...q, lens: r.__lens }))) }
  return {
    on, slices, keepQuestions,
    ...unitDispatch({ plan, slices, channel }),
    // One slot of the lens window is the coordinator's, so a round never runs a 17th agent (#325).
    window: tel.window,
    /** The unit rule of a dispatch, null off or on a slice outside every unit. @param {Slice | null} slice @param {string} t */
    unitOf: (slice, t) => (discovery && slice?.unit ? { root: slice.unit, roots: slice.units ?? [slice.unit], channel, tag: t, kind: discovery } : null),
    /** @param {Slice} slice @param {string} priorSummary */
    contractPrompt: (slice, priorSummary) => contractPrompt({ root: slice.unit || '.', lang: profile.lang, kind: /** @type {UnitDiscovery} */ (discovery), range: lensDiffRange(), priorSummary, repoRules: plan.repoRules }),
    /** The contract lens of each touched unit, dispatched in round 1 only. @param {number} round */
    contracts: round => (on && round === 1 ? units.map(c => ({ lens: 'contract', slice: /** @type {Slice} */ ({ key: `unit:${c}`, files: [], unit: c }), tag: '' })) : []),
    /** The live coordinator of one round, dispatched beside its lenses; null with no channel lens. @param {number} round @param {Array<{ tag: string }>} ds */
    coordinate: (round, ds) => {
      const expected = ds.filter(d => d.tag).length
      if (!channel || !expected) return null
      tel.coordinators++
      const capMinutes = Math.max(1, Math.round(deadlineMsFor({ phase: 'Lenses' }, reviewRun.deadlineArg) / 60000))
      return ragent(coordinatorPrompt({ lang: profile.lang, noun: String(discovery?.noun), channel, round, expected, capMinutes }), { label: `coord:${profile.id} r${round}`, phase: 'Lenses', model: plan.lensModel, schema: COORD_SCHEMA }).catch(() => null)
    },
    /**
     * The round's lenses settled: their questions kept, each with the lens that asked; the coordinator released.
     * @param {number} round @param {Promise<CoordAnswer | null> | null} coord @param {Array<{ __lens: string, questions?: unknown }>} landed
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
      const pass = (/** @type {string} */ suffix) => ragent(seamPrompt({ lang: profile.lang, kind: /** @type {UnitDiscovery} */ (discovery), units, range: lensDiffRange(), open, repoRules: plan.repoRules }), { label: `seam:${profile.id}${suffix}`, phase: 'Lenses', model: plan.lensModel, schema: SEAM_SCHEMA }).catch(() => null)
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
