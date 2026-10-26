// Which unfinished records the run-store report lists (lib/analyze-runs.mjs, "Runs that did not finish").
//
// Two questions, both about the list and never about the store: rebuilt records stay a valid source of
// a prior-round ledger (realm @nick/craft, node #61) and are not touched here.
// - Did that run finish after all? A record rebuilt from a run's transcript can be written while the
//   run is still alive, and the run then files its own complete record. Listing the rebuilt one would
//   report an outage that did not happen.
// - Which engine wrote it? A rebuilt record carries no craftVersion of its own; a record recovered from
//   phase checkpoints carries it in each checkpoint. Without either the engine cannot be told, and a
//   slice says how many such records it left out rather than dropping them in silence.

import { engineKey, engineRevisionToken } from './run-record.mjs'

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
const listOf = v => (Array.isArray(v) ? v : [])

/** @param {unknown} v @param {string} key @returns {unknown} */
const field = (v, key) => (v && typeof v === 'object' ? /** @type {Record<string, unknown>} */ (v)[key] : undefined)

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

/** `c` was filed after `p`, by a run already going when `p` was written. @param {RunRec} p @param {RunRec} c */
function runningThrough(p, c) {
  const pTs = storeTsMs(p.ts), cTs = storeTsMs(c.ts), started = startedMs(c)
  return pTs !== null && cTs !== null && started !== null && cTs > pTs && started < pTs
}

/** Whether complete record `c` is the finished form of the run partial record `p` was rebuilt from. @param {RunRec} p @param {RunRec} c */
const finishedAs = (p, c) => sameReview(p, c) && runningThrough(p, c)

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

/** The craft version a record names, or the one all its phase checkpoints agree on, or null. @param {RunRec} r @returns {string | null} */
export function partialVersion(r) {
  if (typeof r.craftVersion === 'string' && r.craftVersion) return r.craftVersion
  const seen = new Set(listOf(r.phases).map(p => field(p, 'craftVersion')).filter(v => typeof v === 'string' && v))
  return seen.size === 1 ? /** @type {string} */ ([...seen][0]) : null
}

/** @typedef {{ engine: string } | { version: string } | null} Slice */

/**
 * Whether a record belongs to the slice: true, false, or null when its version is unknown and the rest of
 * its engine does not rule it out.
 * @param {RunRec} r @param {Exclude<Slice, null>} slice @returns {boolean | null}
 */
export function inSlice(r, slice) {
  const version = partialVersion(r)
  if ('version' in slice) return version === null ? null : version === slice.version
  if (version !== null) return engineKey({ ...r, craftVersion: version }) === slice.engine
  if (engineKey(r) === slice.engine) return true
  const parts = slice.engine.split(' ')
  const sameRest = parts[0] === String(r.runtime || 'unknown-runtime') && parts[parts.length - 1] === engineRevisionToken(r)
  return sameRest ? null : false
}

/**
 * The partials a slice lists, and how many it could not attribute.
 * @param {RunRec[]} partials @param {Slice} slice @returns {{ shown: RunRec[], unattributed: number }}
 */
export function slicePartials(partials, slice) {
  if (!slice) return { shown: partials, unattributed: 0 }
  const shown = partials.filter(p => inSlice(p, slice) === true)
  return { shown, unattributed: partials.filter(p => inSlice(p, slice) === null).length }
}
