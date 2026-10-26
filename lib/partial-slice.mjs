// Which engine's list of unfinished runs a record is on (lib/analyze-runs.mjs, "Runs that did not
// finish"); whether its run finished after all is lib/partial-twins.mjs. About the list, never the store
// (realm @nick/craft, node #61).
//
// A rebuilt record carries no craftVersion of its own; a record recovered from phase checkpoints carries
// it in each checkpoint. Its top-level `engineRevision` is the RECOVERING craft's, so the revision too is
// the run's own (runRevision). Without a version the engine cannot be told, and a slice says how many
// such records it left out rather than dropping them in silence (realm @nick/craft, node #313).

import { engineKey, parseEngineKey, recordEngineRevision } from './run-record.mjs'
import { listOf, field } from './partial-twins.mjs'

/** @typedef {import('./run-record.mjs').RunRecord} RunRec */
/** @typedef {import('./run-record.mjs').EngineParts} EngineParts */

/** The craft version a record names, or the one all its phase checkpoints agree on, or null. @param {RunRec} r @returns {string | null} */
export function partialVersion(r) {
  if (typeof r.craftVersion === 'string' && r.craftVersion) return r.craftVersion
  const seen = new Set(listOf(r.phases).map(p => field(p, 'craftVersion')).filter(v => typeof v === 'string' && v))
  return seen.size === 1 ? /** @type {string} */ ([...seen][0]) : null
}

/** @typedef {{ engine: string, parts: EngineParts }} EngineSlice */
/** @typedef {EngineSlice | { version: string } | null} Slice */

/** The slice an engine key names, its parts read once (parseEngineKey); null for no key engineKey writes. @param {string} engine @returns {EngineSlice | null} */
export function engineSlice(engine) {
  const parts = parseEngineKey(engine)
  return parts ? { engine, parts } : null
}

/**
 * Whether a record belongs to the slice: true, false, or null when its version is unknown and the rest of
 * its engine does not rule it out.
 * @param {RunRec} r @param {Exclude<Slice, null>} slice @returns {boolean | null}
 */
export function inSlice(r, slice) {
  const version = partialVersion(r)
  if ('version' in slice) return version === null ? null : version === slice.version
  // Both sides are read by the one parser, so equal parts are equal keys.
  const own = parseEngineKey(engineKey({ runtime: r.runtime, craftVersion: version, engineRevision: runRevision(r) }))
  const want = slice.parts
  if (!own || own.runtime !== want.runtime || own.revision !== want.revision) return false
  // Version unknown: an unversioned slice is this record's engine; any other is not ruled out.
  if (version === null) return want.version === null ? true : null
  return own.version === want.version
}

/**
 * The revision of the engine that RAN the record's run. On a recovered record the top-level revision is
 * the recovering craft's (lib/craft-log-run.mjs, the store README), so the run's own comes first:
 * `runEngineRevision` (recover stamps it off the checkpoints), else the one revision its checkpoints
 * agree on (the engine's own stamp first, as recordEngineRevision reads a record). Checkpoints that
 * disagree leave it unknown, the `r?` bucket engineKey keeps for absence. Only a record with no revision
 * of the run's own at all — one rebuilt from a journal, or checkpoints written before they carried one —
 * falls back to the top-level field: a journal is rebuilt alongside the run it reads, so the rebuilding
 * craft is the best witness left, and dropping the field would leave the record in no engine at all.
 * @param {RunRec} r @returns {number | null}
 */
function runRevision(r) {
  if (Number.isInteger(r.runEngineRevision)) return /** @type {number} */ (r.runEngineRevision)
  const seen = new Set(listOf(r.phases).map(p => {
    const w = field(p, 'workflowEngineRevision')
    return Number.isInteger(w) ? w : field(p, 'engineRevision')
  }).filter(v => Number.isInteger(v)))
  if (seen.size === 1) return /** @type {number} */ ([...seen][0])
  return seen.size > 1 ? null : recordEngineRevision(r)
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
