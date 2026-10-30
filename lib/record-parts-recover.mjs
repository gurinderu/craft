// `recover`'s side of a record sent in parts (realm @nick/craft, node #396): a run whose finalize died after
// its parts landed is put back from them on finalize's own terms (lib/record-parts-assemble.mjs, the content
// id deciding "whole"), and the parts, like the ledger's shards, stay out of the record's `phases`. The header
// finalize would have read never reaches the directory, so it is read off the parts themselves: each one went
// through `checkpoint`, which settled the engine revision it carries against the command line.
import { recordFromParts, isTransportSlice } from './record-parts-assemble.mjs'
import { ledgerFromShards } from './ledger-in-shards.mjs'
import { honestVerdict } from './honest-verdict.mjs'

/** @typedef {Record<string, unknown>} Rec */
/** @typedef {{ record: Rec, complete: boolean, warning: string }} FromParts */

/** @param {unknown} p @returns {{ index?: unknown, of?: unknown, id: string } | null} */
function partDecl(p) {
  const d = p && typeof p === 'object' ? /** @type {Rec} */ (p)['recordPart'] : null
  return d && typeof d === 'object' && typeof (/** @type {Rec} */ (d)['id']) === 'string' ? /** @type {{ id: string }} */ (d) : null
}

// The parts of the record the run sent last (a retried record is cut again under another id), and its count.
/** @param {unknown[]} phases @returns {{ id: string, of: number, parts: Rec[] } | null} */
function lastRecordParts(phases) {
  const all = /** @type {Rec[]} */ (phases.filter(p => partDecl(p)))
  const last = all.at(-1)
  const decl = last ? partDecl(last) : null
  const of = Number(decl?.of)
  if (!decl || !Number.isInteger(of) || of < 1) return null
  return { id: decl.id, of, parts: all.filter(p => partDecl(p)?.id === decl.id) }
}

// The revision the parts agree on, or the dispute their checkpoints filed, or a dispute of their own when
// they disagree with each other: a basis only when every part attests the same one (#396).
/** @param {Rec[]} parts @returns {Rec} */
function revisionOf(parts) {
  const disputed = parts.find(p => p['workflowEngineRevisionDisputed'] !== undefined)
  if (disputed) return { workflowEngineRevisionDisputed: disputed['workflowEngineRevisionDisputed'] }
  const revs = [...new Set(parts.map(p => p['workflowEngineRevision']))]
  if (revs.length === 1) return revs[0] === undefined ? {} : { workflowEngineRevision: revs[0] }
  return { workflowEngineRevisionDisputed: { argv: null, payload: null, parts: revs.map(r => r ?? null) } }
}

// What finalize's header would have said of the record, read off its parts: what every part carries besides
// its entries (lib/run-logging.mjs, partHead) and the declaration.
/** @param {{ id: string, of: number, parts: Rec[] }} got @returns {Rec} */
function headerOf({ id, of, parts }) {
  const first = /** @type {Rec} */ (parts[0])
  /** @type {Rec} */
  const header = {}
  for (const k of ['kind', 'name', 'craftVersion', 'round']) if (first[k] !== undefined) header[k] = first[k]
  return { ...header, ...revisionOf(parts), recordInParts: { of, id } }
}

/**
 * The record a dead run's parts put back: whole when every declared part came back and the content id
 * proves it, else what they hold, still declared; null when the directory holds no part.
 * @param {unknown[]} phases @returns {FromParts | null}
 */
export function recordFromRecoveredParts(phases) {
  const got = lastRecordParts(phases)
  if (!got) return null
  const parts = recordFromParts(headerOf(got), phases, '')
  const shards = ledgerFromShards(parts.record, phases, '')
  return {
    record: shards.record,
    complete: parts.record['recordInParts'] === undefined,
    warning: [parts.warning, shards.warning].filter(Boolean).join('\n'),
  }
}

/** @template T @param {T[]} phases @returns {T[]} */
export function runPhases(phases) {
  return phases.filter(p => !isTransportSlice(p))
}

// What the checkpoint reconstruction keeps over the parts on a short record: what marks it partial and decides
// its basis, and a journal ledger with its trust marker; any other value the parts hold is the engine's own.
const RECONSTRUCTION_KEEPS = ['partial', 'runEngineRevision']
const JOURNAL_LEDGER = ['ledger', 'ledgerSource', 'journalFile']

/**
 * The record `recover` files for a run whose record was sent in parts. Whole: the record exactly, with the
 * run's own phases (never its parts) as finalize folds them. Short: the checkpoint reconstruction `base`
 * under what the parts hold, still partial and declared, its phases the run's own.
 * @param {Rec} base @param {unknown[]} phases @param {FromParts} got @returns {Rec}
 */
export function recordWithParts(base, phases, got) {
  const folded = runPhases(phases)
  if (got.complete) return folded.length && !got.record['phases'] ? { ...got.record, phases: folded } : got.record
  const decl = /** @type {{ of?: unknown, seen?: unknown, altered?: unknown }} */ (got.record['recordInParts'])
  const merged = { ...base, ...got.record }
  for (const k of RECONSTRUCTION_KEEPS) if (base[k] !== undefined) merged[k] = base[k]
  merged['phases'] = folded
  if (base['ledgerSource'] === 'journal') for (const k of JOURNAL_LEDGER) merged[k] = base[k]
  else delete merged['ledgerSource']
  const notRun = [...listOf(base['notRun']), ...listOf(got.record['notRun'])]
  merged['notRun'] = notRun
  merged['verdict'] = honestVerdict(/** @type {string | undefined} */ (merged['verdict']), notRun)
  merged['partialReason'] = `run ended before its record was filed — its final record was sent in ${String(decl.of)} part(s) and ${String(decl.seen)} came back${decl.altered ? ' altered' : ''}, filed with what they hold; ${String(base['partialReason'])}`
  return merged
}

/** @param {unknown} v @returns {unknown[]} */
function listOf(v) {
  return Array.isArray(v) ? v : []
}
