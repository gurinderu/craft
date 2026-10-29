// Which unfinished records the run-store report lists (lib/analyze-runs.mjs, "Runs that did not finish"):
// not those whose run finished after all. Which engine's list a record is on is lib/partial-slice.mjs.
//
// A question about the list, never about the store: rebuilt records stay a valid source of a
// prior-round ledger (realm @nick/craft, node #61) and are not touched here. A record rebuilt from a
// run's transcript or checkpoints can be written while the run is still alive, and the run then files
// its own complete record. Listing the rebuilt one would report an outage that did not happen (realm
// @nick/craft, node #313). `recover` keeps such a run's checkpoint directory while it may be alive, so
// that complete record still folds every checkpoint (#340).

/** @typedef {import('./run-record.mjs').RunRecord} RunRec */

// A head shorter than this is no identity: a prefix of anything.
const MIN_HEAD = 7

/** The instant a store timestamp (`YYYY-MM-DDTHH-MM-SSZ`) names, or null. @param {unknown} ts @returns {number | null} */
export function storeTsMs(ts) {
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})Z$/.exec(String(ts ?? ''))
  if (!m) return null
  const iso = `${m[1]}T${m[2]}:${m[3]}:${m[4]}Z`
  const ms = Date.parse(iso)
  // Date.parse rolls some impossible dates over; the round trip refuses them.
  return Number.isNaN(ms) || new Date(ms).toISOString().slice(0, 19) !== iso.slice(0, 19) ? null : ms
}

/** @param {unknown} v @returns {unknown[]} */
export const listOf = v => (Array.isArray(v) ? v : [])

/** @param {unknown} v @param {string} key @returns {unknown} */
export const field = (v, key) => (v && typeof v === 'object' ? /** @type {Record<string, unknown>} */ (v)[key] : undefined)

/** When the run behind a complete record started: its earliest phase checkpoint, or null. @param {RunRec} r @returns {number | null} */
function startedMs(r) {
  const times = listOf(r.phases).map(p => Date.parse(String(field(p, 'at') ?? ''))).filter(t => !Number.isNaN(t))
  return times.length ? Math.min(...times) : null
}

/** @param {unknown} a @param {unknown} b @returns {boolean} */
function sameHead(a, b) {
  const x = typeof a === 'string' ? a : '', y = typeof b === 'string' ? b : ''
  if (Math.min(x.length, y.length) < MIN_HEAD) return false
  return x.startsWith(y) || y.startsWith(x)
}

/** One review of one project's branch at one head. @param {RunRec} p @param {RunRec} c */
const sameReview = (p, c) => c.name === 'review' && p.name === 'review' && c.project === p.project &&
  typeof p.branch === 'string' && p.branch !== '' && c.branch === p.branch && sameHead(p.head, c.head)

/** A checkpoint's identity: its phase and the instant it was written. @param {unknown} p @returns {string} */
const checkpointId = p => `${String(field(p, 'phase') ?? '')}@${String(field(p, 'at') ?? '')}`

/**
 * A record recovered from checkpoints (`recover`): its `ts` is the run's START, and its phases are that
 * run's own. It is `c`'s run only if `c` folded in every one of them (finalize keeps each checkpoint
 * whole). Ledger shards never reach a complete record's phases (finalize drops them), so they are no
 * evidence either way; a record with nothing else is never matched.
 * @param {RunRec} p @param {RunRec} c
 */
function foldedInto(p, c) {
  const own = listOf(p.phases).filter(x => field(x, 'ledgerShard') == null).map(checkpointId)
  const folded = new Set(listOf(c.phases).map(checkpointId))
  return own.length > 0 && own.every(id => folded.has(id))
}

/**
 * A record rebuilt from a journal (`from-journal`, no phases): its `ts` is when it was rebuilt, so `c`'s
 * run is its run if that run was already going then.
 * @param {RunRec} p @param {RunRec} c
 */
function runningThrough(p, c) {
  const pTs = storeTsMs(p.ts), started = startedMs(c)
  return pTs !== null && started !== null && started < pTs
}

/** `c` was filed after `p`. @param {RunRec} p @param {RunRec} c */
function newer(p, c) {
  const pTs = storeTsMs(p.ts), cTs = storeTsMs(c.ts)
  return pTs !== null && cTs !== null && cTs > pTs
}

/**
 * Whether complete record `c` is the finished form of the run partial record `p` was rebuilt from. A
 * complete record with no phases never is: without them the run's identity is too weak to tell.
 * @param {RunRec} p @param {RunRec} c
 */
const finishedAs = (p, c) => sameReview(p, c) && newer(p, c) && listOf(c.phases).length > 0 &&
  (listOf(p.phases).length > 0 ? foldedInto(p, c) : runningThrough(p, c))

/**
 * Partials split into those still listed and those a complete record shows finished.
 * @param {RunRec[]} partials @param {RunRec[]} complete
 * @returns {{ kept: RunRec[], hidden: Array<{ partial: RunRec, by: RunRec }> }}
 */
export function splitSuperseded(partials, complete) {
  /** @type {RunRec[]} */
  const kept = []
  /** @type {Array<{ partial: RunRec, by: RunRec }>} */
  const hidden = []
  for (const p of partials) {
    const by = complete.find(c => finishedAs(p, c))
    if (by) hidden.push({ partial: p, by })
    else kept.push(p)
  }
  return { kept, hidden }
}
