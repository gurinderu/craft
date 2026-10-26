// One profile's crateScope state and steps (src/review.js, Lenses phase; realm @nick/craft, transformation
// #324): the crate slices (#319), the confined lens's crate rule and question channel (#320, #316), the live
// coordinator of each round and the seam pass before verification (#321), and the contract lens per touched
// crate (#327). Off, or on a profile other than rust, it is the directory slicing and every step a no-op —
// the lens rounds then dispatch exactly as before.
import { sliceDiff, LENS_WINDOW_AGENTS } from './lens-scope.mjs'
import { deadlineArm } from './agent-deadline.mjs'
import { deadlineMsFor } from './review-deadlines.mjs'
import { crateRootOf, touchedCrates, questionTally } from './crate-scope.mjs'
import { parsePackageLines, parseNumstat } from './crate-manifests.mjs'
import { crateBatchPlan } from './review-crate-batches.mjs'
import { applyDispositions } from './crate-seam.mjs'
import { contractPrompt, coordinatorPrompt, seamPrompt, cratesPrompt, stopPrompt } from './review-crate-prompts.mjs'
import { CRATES_SCHEMA, COORD_SCHEMA, SEAM_SCHEMA, STOP_SCHEMA, multiLensSchema } from './review-crate-schemas.mjs'

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
 *   questions: ReturnType<typeof questionTally>, resurrectedConfined: number, resurrectedUnconfined: number, resurrectedContract: number,
 *   seam: { ran: boolean, retried: boolean, findings: number, answered: number, dispositions: { confirm: number, drop: number, convert: number }, setAside: import('./crate-seam.mjs').SetAside[] },
 *   crateBatches?: import('./review-crate-batches.mjs').BatchRow[] | null, sectioned?: string[], untaggedFindings?: number,
 *   costEstimate?: import('./review-crate-batches.mjs').CostEstimate }} CrateRun
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

/**
 * The slices of one profile: crate batches under crateScope (#355) unless crateBatches=false (one per crate
 * then), the directory slicing off or with no Cargo package found. The probe is one cheap agent: the package
 * roots with their sizes and dependencies, and the diff's numstat.
 * @param {ReviewRun} reviewRun
 * @param {{ profile: Profile, plan: Plan, changedFiles: string[], lensDiffRange: () => string, on: boolean }} ctx
 * @returns {Promise<{ roots: string[], slices: Slice[], sectioned: string[], batches: ReturnType<typeof crateBatchPlan> | null }>}
 */
async function crateSlicing(reviewRun, { profile, plan, changedFiles, lensDiffRange, on }) {
  const owns = (/** @type {string} */ f) => profile.detect([f])
  const r = on ? await reviewRun.ragent(cratesPrompt(lensDiffRange()), { label: `crates:${profile.id}`, phase: 'Lenses', schema: CRATES_SCHEMA, model: 'haiku', effort: 'low' }).catch(() => null) : null
  const packages = parsePackageLines(r?.packages)
  const roots = [...new Set([...(Array.isArray(r?.roots) ? r.roots.map(crateRootOf) : []), ...packages.map(p => p.root)])]
  if (on && !roots.length) reviewRun.sb.log(`⚠️ [${profile.id}] crateScope: no Cargo package found — directory slicing kept`)
  if (!roots.length) return { roots, slices: sliceDiff(changedFiles, { owns }), sectioned: [], batches: null }
  const batches = crateBatchPlan({ lenses: plan.lenses, changedFiles, roots, packages, numstat: parseNumstat(r?.numstat), owns, batched: !!reviewRun.crateBatches, batchBudget: reviewRun.crateBatchBudget, costModel: reviewRun.costModelArg })
  return { roots, slices: batches.slices, sectioned: batches.sectioned, batches }
}

/**
 * @param {ReviewRun} reviewRun
 * @param {{ profile: Profile, plan: Plan, changedFiles: string[], lensDiffRange: () => string }} ctx
 */
export async function openCrateScope(reviewRun, { profile, plan, changedFiles, lensDiffRange }) {
  const { ragent, crateRuns } = reviewRun
  const { log: logLine } = reviewRun.sb
  const on = reviewRun.crateScope && profile.id === 'rust'
  const { roots, slices, sectioned, batches } = await crateSlicing(reviewRun, { profile, plan, changedFiles, lensDiffRange, on })
  const bundle = sectioned.join('+')
  const crates = touchedCrates(changedFiles, roots)
  const confined = slices.filter(g => g.crate).length
  const channel = on && confined && reviewRun.runDir ? `${reviewRun.runDir}/crate-${profile.id}` : ''
  /** @type {Array<QuestionAnswer & { lens: string }>} */
  const questions = []
  /** @type {CrateRun} */
  const tel = { language: profile.id, roots: roots.length, crates: crates.length, slices: confined, channel: !!channel, window: LENS_WINDOW_AGENTS - (channel ? 1 : 0),
    coordinators: 0, coordinatorAnswered: 0, releaseFailed: 0, releaseTimedOut: 0, questions: questionTally([]), resurrectedConfined: 0, resurrectedUnconfined: 0, resurrectedContract: 0,
    seam: { ran: false, retried: false, findings: 0, answered: 0, dispositions: { confirm: 0, drop: 0, convert: 0 }, setAside: [] } }
  if (batches) Object.assign(tel, { crateBatches: batches.crateBatches, sectioned, untaggedFindings: 0, costEstimate: batches.costEstimate })
  if (on) crateRuns.push(tel)

  /** @param {Slice | null} slice @param {number} round */
  const tag = (/** @type {string} */ lens, slice, round) => (channel && slice?.crate ? `${lens}-s${slices.indexOf(slice)}r${round}` : '')
  return {
    on, slices,
    /**
     * One round's lens dispatches: each lens per slice, the sectioned lenses of a crate batch as one agent.
     * @param {(lens: string) => Array<Slice | null>} slicesFor @param {number} round @returns {LensDispatch[]}
     */
    dispatches: (slicesFor, round) => plan.lenses.flatMap(lens => slicesFor(lens).flatMap(slice => {
      if (!sectioned.includes(lens) || !slice?.crate) return [{ lens, members: [lens], slice, tag: tag(lens, slice, round) }]
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
     * Resurrection attempts with the sectioned lenses of one crate slice merged back into one agent.
     * @param {Array<{ lens: string, slice: Slice | null }>} attempts @returns {Array<{ lens: string, members: string[], slice: Slice | null }>}
     */
    regroup: attempts => {
      /** @type {Map<Slice, string[]>} */
      const bySlice = new Map()
      /** @type {Array<{ lens: string, members: string[], slice: Slice | null }>} */
      const out = []
      for (const a of attempts) {
        if (a.slice?.crate && sectioned.includes(a.lens)) bySlice.set(a.slice, [...(bySlice.get(a.slice) || []), a.lens])
        else out.push({ lens: a.lens, members: [a.lens], slice: a.slice })
      }
      for (const [slice, ms] of bySlice) out.push(ms.length > 1 ? { lens: ms.join('+'), members: ms, slice } : { lens: String(ms[0]), members: ms, slice })
      return out
    },
    // One slot of the lens window is the coordinator's, so a round never runs a 17th agent (#325).
    window: tel.window,
    tag,
    /** The crate rule of a dispatch, null off or on a slice outside every crate. @param {Slice | null} slice @param {string} t */
    crateOf: (slice, t) => (on && slice?.crate ? { root: slice.crate, roots: slice.crates ?? [slice.crate], channel, tag: t } : null),
    /** @param {Slice} slice @param {string} priorSummary */
    contractPrompt: (slice, priorSummary) => contractPrompt({ root: slice.crate || '.', lang: profile.lang, range: lensDiffRange(), priorSummary }),
    /** The contract lens of each touched crate, dispatched in round 1 only. @param {number} round */
    contracts: round => (on && round === 1 ? crates.map(c => ({ lens: 'contract', members: ['contract'], slice: /** @type {Slice} */ ({ key: `crate:${c}`, files: [], crate: c }), tag: '' })) : []),
    /** The live coordinator of one round, dispatched beside its lenses; null with no channel lens. @param {number} round @param {Array<{ tag: string }>} ds */
    coordinate: (round, ds) => {
      const expected = ds.filter(d => d.tag).length
      if (!channel || !expected) return null
      tel.coordinators++
      const capMinutes = Math.max(1, Math.round(deadlineMsFor({ phase: 'Lenses' }, reviewRun.deadlineArg) / 60000))
      return ragent(coordinatorPrompt({ lang: profile.lang, channel, round, expected, capMinutes }), { label: `coord:${profile.id} r${round}`, phase: 'Lenses', model: plan.lensModel, schema: COORD_SCHEMA }).catch(() => null)
    },
    /**
     * The round's lenses settled: their questions kept, each with the lens that asked — a sectioned agent's with
     * the section its question names, the lens its dependent finding counts under (sourceOf); the coordinator released.
     * @param {number} round @param {Promise<CoordAnswer | null> | null} coord @param {Array<{ __lens: string, __members?: string[], questions?: unknown }>} landed
     */
    settle: async (round, coord, landed) => {
      for (const r of landed) if (Array.isArray(r.questions)) questions.push(...r.questions.map(q => questionOf(q, r.__lens, r.__members)))
      if (!coord) return
      const writeStop = async () => !!(await ragent(stopPrompt(channel, round), { label: `coord-stop:${profile.id} r${round}`, phase: 'Lenses', model: 'haiku', effort: 'low', schema: STOP_SCHEMA }))?.written
      const { stopped, answer, timedOut } = await releaseCoordinator({ writeStop, coord, graceMs: RELEASE_GRACE_MS })
      if (!stopped) tel.releaseFailed++
      if (timedOut) { tel.releaseTimedOut++; logLine(`⚠️ [${profile.id}] crateScope: round ${round} coordinator did not return within ${RELEASE_GRACE_MS / 60000} min of its release${stopped ? '' : ' (its stop file was not written)'} — the review goes on without it`) }
      tel.coordinatorAnswered += Number(answer?.answered) || 0
    },
    /**
     * A resurrected dispatch: confined (its slice and crate rule kept, no coordinator to ask), unsliced, or a contract lens on its crate.
     * @param {'confined' | 'unconfined' | 'contract'} kind
     */
    noteResurrected: kind => { if (kind === 'contract') tel.resurrectedContract++; else if (kind === 'confined') tel.resurrectedConfined++; else tel.resurrectedUnconfined++ },
    /**
     * Before verification: the seam between the touched crates, the open questions, and a disposition for
     * each finding that depends on one. Its findings join the pool as `seam`.
     * @param {Finding[]} pool @param {Set<string>} seen @param {string[]} notRun @param {(found: Finding[], seen: Set<string>, pool: Finding[]) => void} pushUnseen
     */
    seam: async (pool, seen, notRun, pushUnseen) => {
      tel.questions = questionTally(questions)
      if (!on || !crates.length) return
      const open = questions.filter(q => !q.answered)
      // A dead seam pass is retried once, like a dead lens in the resurrection sweep; the record says it was.
      const pass = (/** @type {string} */ suffix) => ragent(seamPrompt({ lang: profile.lang, crates, range: lensDiffRange(), open }), { label: `seam:${profile.id}${suffix}`, phase: 'Lenses', model: plan.lensModel, schema: SEAM_SCHEMA }).catch(() => null)
      let s = await pass('')
      if (!s || !Array.isArray(s.findings)) { tel.seam.retried = true; s = await pass(' retry') }
      if (!s || !Array.isArray(s.findings)) return void notRun.push(`${profile.id} seam pass (crateScope) — returned no findings`)
      const { kept, counts, setAside } = applyDispositions(pool, s.dispositions, open)
      pool.splice(0, pool.length, ...kept)
      pushUnseen(s.findings.map(f => ({ ...f, source: 'seam' })), seen, pool)
      tel.seam = { ran: true, retried: tel.seam.retried, findings: s.findings.length, answered: Number(s.answered) || 0, dispositions: counts, setAside }
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

// One lens question as kept for the seam pass: with the lens that asked, or, from a sectioned agent, with the
// section it names — the bundle's name when it names none, as an untagged finding counts.
/** @param {QuestionAnswer} q @param {string} lens @param {string[] | undefined} members @returns {QuestionAnswer & { lens: string }} */
function questionOf(q, lens, members) {
  const { source, ...rest } = q
  return { ...rest, lens: members && members.length > 1 && members.includes(String(source)) ? String(source) : lens }
}
