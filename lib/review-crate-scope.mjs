// One profile's crateScope state and steps (src/review.js, Lenses phase; realm @nick/craft, transformation
// #324): the crate slices (#319), the confined lens's crate rule and question channel (#320, #316), the live
// coordinator of each round and the seam pass before verification (#321), and the contract lens per touched
// crate (#327). Off, or on a profile other than rust, it is the directory slicing and every step a no-op —
// the lens rounds then dispatch exactly as before.
import { sliceDiff, LENS_WINDOW_AGENTS } from './lens-scope.mjs'
import { deadlineArm } from './agent-deadline.mjs'
import { crateRootOf, sliceByCrate, touchedCrates, questionTally, applyDispositions } from './crate-scope.mjs'
import { contractPrompt, coordinatorPrompt, seamPrompt, cratesPrompt, stopPrompt } from './review-crate-prompts.mjs'
import { CRATES_SCHEMA, COORD_SCHEMA, SEAM_SCHEMA, STOP_SCHEMA } from './review-crate-schemas.mjs'

/**
 * @typedef {import('./review-run.mjs').ReviewRun} ReviewRun
 * @typedef {import('./review-profiles.mjs').Profile} Profile
 * @typedef {import('./review-plan.mjs').Plan} Plan
 * @typedef {import('./review-schemas.mjs').Finding} Finding
 * @typedef {import('./crate-scope.mjs').CrateGroup} Slice
 * @typedef {import('./review-crate-schemas.mjs').QuestionAnswer} QuestionAnswer
 * @typedef {import('./review-crate-schemas.mjs').CoordAnswer} CoordAnswer
 * @typedef {{ language: string, roots: number, crates: number, slices: number, channel: boolean, window: number,
 *   coordinators: number, coordinatorAnswered: number, releaseFailed: number, releaseTimedOut: number,
 *   questions: ReturnType<typeof questionTally>, resurrectedConfined: number, resurrectedUnconfined: number,
 *   seam: { ran: boolean, findings: number, answered: number, dispositions: { confirm: number, drop: number, convert: number } } }} CrateRun
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
export async function openCrateScope(reviewRun, { profile, plan, changedFiles, lensDiffRange }) {
  const { ragent, crateRuns } = reviewRun
  const { log: logLine } = reviewRun.sb
  const owns = (/** @type {string} */ f) => profile.detect([f])
  const on = reviewRun.crateScope && profile.id === 'rust'
  const roots = on ? await crateRootsOf() : []
  /** @type {Slice[]} */
  const slices = roots.length ? sliceByCrate(changedFiles, roots, { owns }) : sliceDiff(changedFiles, { owns })
  const crates = touchedCrates(changedFiles, roots)
  const confined = slices.filter(g => g.crate).length
  const channel = on && confined && reviewRun.runDir ? `${reviewRun.runDir}/crate-${profile.id}` : ''
  /** @type {Array<QuestionAnswer & { lens: string }>} */
  const questions = []
  /** @type {CrateRun} */
  const tel = { language: profile.id, roots: roots.length, crates: crates.length, slices: confined, channel: !!channel, window: LENS_WINDOW_AGENTS - (channel ? 1 : 0),
    coordinators: 0, coordinatorAnswered: 0, releaseFailed: 0, releaseTimedOut: 0, questions: questionTally([]), resurrectedConfined: 0, resurrectedUnconfined: 0,
    seam: { ran: false, findings: 0, answered: 0, dispositions: { confirm: 0, drop: 0, convert: 0 } } }
  if (on) crateRuns.push(tel)

  // The Cargo package roots, from one cheap agent; none found keeps the directory slicing.
  async function crateRootsOf() {
    const r = await ragent(cratesPrompt(), { label: `crates:${profile.id}`, phase: 'Lenses', schema: CRATES_SCHEMA, model: 'haiku', effort: 'low' }).catch(() => null)
    const found = Array.isArray(r?.roots) ? r.roots.map(crateRootOf) : []
    if (!found.length) logLine(`⚠️ [${profile.id}] crateScope: no Cargo package found — directory slicing kept`)
    return found
  }
  /** @param {Slice | null} slice @param {number} round */
  const tag = (/** @type {string} */ lens, slice, round) => (channel && slice?.crate ? `${lens}-s${slices.indexOf(slice)}r${round}` : '')
  return {
    on, slices,
    // One slot of the lens window is the coordinator's, so a round never runs a 17th agent (#325).
    window: tel.window,
    tag,
    /** The crate rule of a dispatch, null off or on a slice outside every crate. @param {Slice | null} slice @param {string} t */
    crateOf: (slice, t) => (on && slice?.crate ? { root: slice.crate, channel, tag: t } : null),
    /** @param {Slice} slice @param {string} priorSummary */
    contractPrompt: (slice, priorSummary) => contractPrompt({ root: slice.crate || '.', lang: profile.lang, range: lensDiffRange(), priorSummary }),
    /** The contract lens of each touched crate, dispatched in round 1 only. @param {number} round */
    contracts: round => (on && round === 1 ? crates.map(c => ({ lens: 'contract', slice: /** @type {Slice} */ ({ key: `crate:${c}`, files: [], crate: c }), tag: '' })) : []),
    /** The live coordinator of one round, dispatched beside its lenses; null with no channel lens. @param {number} round @param {Array<{ tag: string }>} ds */
    coordinate: (round, ds) => {
      const expected = ds.filter(d => d.tag).length
      if (!channel || !expected) return null
      tel.coordinators++
      return ragent(coordinatorPrompt({ lang: profile.lang, channel, round, expected }), { label: `coord:${profile.id} r${round}`, phase: 'Lenses', model: plan.lensModel, schema: COORD_SCHEMA }).catch(() => null)
    },
    /**
     * The round's lenses settled: their questions kept, each with the lens that asked; the coordinator released.
     * @param {number} round @param {Promise<CoordAnswer | null> | null} coord @param {Array<{ __lens: string, questions?: unknown }>} landed
     */
    settle: async (round, coord, landed) => {
      for (const r of landed) if (Array.isArray(r.questions)) questions.push(...r.questions.map(q => ({ ...q, lens: r.__lens })))
      if (!coord) return
      const writeStop = async () => !!(await ragent(stopPrompt(channel, round), { label: `coord-stop:${profile.id} r${round}`, phase: 'Lenses', model: 'haiku', effort: 'low', schema: STOP_SCHEMA }))?.written
      const { stopped, answer, timedOut } = await releaseCoordinator({ writeStop, coord, graceMs: RELEASE_GRACE_MS })
      if (!stopped) tel.releaseFailed++
      if (timedOut) { tel.releaseTimedOut++; logLine(`⚠️ [${profile.id}] crateScope: round ${round} coordinator did not return within ${RELEASE_GRACE_MS / 60000} min of its release${stopped ? '' : ' (its stop file was not written)'} — the review goes on without it`) }
      tel.coordinatorAnswered += Number(answer?.answered) || 0
    },
    /** A resurrected dispatch: confined (its slice and crate rule kept, no coordinator to ask) or unsliced. @param {boolean} confinedRetry */
    noteResurrected: confinedRetry => { if (confinedRetry) tel.resurrectedConfined++; else tel.resurrectedUnconfined++ },
    /**
     * Before verification: the seam between the touched crates, the open questions, and a disposition for
     * each finding that depends on one. Its findings join the pool as `seam`.
     * @param {Finding[]} pool @param {Set<string>} seen @param {string[]} notRun @param {(found: Finding[], seen: Set<string>, pool: Finding[]) => void} pushUnseen
     */
    seam: async (pool, seen, notRun, pushUnseen) => {
      tel.questions = questionTally(questions)
      if (!on || !crates.length) return
      const open = questions.filter(q => !q.answered)
      const s = await ragent(seamPrompt({ lang: profile.lang, crates, range: lensDiffRange(), open }), { label: `seam:${profile.id}`, phase: 'Lenses', model: plan.lensModel, schema: SEAM_SCHEMA }).catch(() => null)
      if (!s || !Array.isArray(s.findings)) return void notRun.push(`${profile.id} seam pass (crateScope) — returned no findings`)
      const { kept, counts } = applyDispositions(pool, s.dispositions, open)
      pool.splice(0, pool.length, ...kept)
      pushUnseen(s.findings.map(f => ({ ...f, source: 'seam' })), seen, pool)
      tel.seam = { ran: true, findings: s.findings.length, answered: Number(s.answered) || 0, dispositions: counts }
    },
    /** The crate lenses that fully ran. @param {Set<string>} expected @param {Set<string>} returned */
    ran: (expected, returned) => [
      ...(crates.length && [...expected].every(k => !k.startsWith('contract :: ') || returned.has(k)) ? ['contract'] : []),
      ...(tel.seam.ran ? ['seam'] : []),
    ],
    /** The record's extra dimension rows: contract and seam, on a profile whose change touched a crate. */
    dimensions: () => (on && crates.length ? ['contract', 'seam'] : []),
  }
}
