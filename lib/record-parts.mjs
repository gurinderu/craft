// The final run record, cut into parts no larger than a checkpoint (realm @nick/craft, node #396; the
// ledger's own shards are #245). lib/record-parts-assemble.mjs puts them back at finalize.
//
// The logger agent copies its payload into a heredoc, and whether the harness lets that call finish
// depends on the size of the copy: none under 24 KB was stopped, most above 50 KB were. Checkpoints of
// ~14-17 KB never were. So a record past RECORD_ONE_CALL_MAX_BYTES is cut here into parts that each
// ride one checkpoint into the run's directory, and finalize gets only a small header. Pure and
// sandbox-safe: the engines bundle it.
import { payloadBytes } from './ledger-shards.mjs'
import { utf8Bytes } from './lens-scope.mjs'

// The most bytes of record any one logger call copies, as the prompt carries it (pretty-printed, UTF-8).
export const RECORD_ONE_CALL_MAX_BYTES = 16384
export const RECORD_PART_PHASE = 'record'
// A top-level value whose JSON is longer than this stays out of the header (it is in the parts all the same).
const HEADER_VALUE_MAX = 256

/** @typedef {(string | number)[]} EntryPath */
/** @typedef {[EntryPath, unknown] | [EntryPath, string, 1]} Entry  a path and its value; `1` appends a string piece */
/** @typedef {{ recordPart: { index: number, of: number, id: string }, recordEntries: Entry[] }} RecordPart */

// UTF-8 bytes of a string, by the hand encoder lens-scope already carries: the sandbox has neither
// TextEncoder nor Buffer.
/** @param {string} text @returns {number} */
export function utf8Length(text) {
  return utf8Bytes(text).length
}

/** @param {unknown} record @returns {number} */
export function recordBytes(record) {
  return utf8Length(JSON.stringify(record, null, 2) ?? '')
}

/** @param {unknown} item @returns {number} */
const entryBytes = item => payloadBytes(item, utf8Length)

// A content id the sandbox can compute (no crypto there): two FNV-1a passes and the length.
/** @param {string} text @returns {string} */
function contentId(text) {
  let a = 0x811c9dc5, b = 0x01000193 ^ 0x5bd1e995
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i)
    a = Math.imul(a ^ c, 0x01000193) >>> 0
    b = Math.imul(b ^ c, 0x5bd1e995) >>> 0
  }
  return `${a.toString(16).padStart(8, '0')}${b.toString(16).padStart(8, '0')}-${text.length.toString(36)}`
}

// A value as entries of at most `max` bytes each: whole when it fits, else its container's marker and its
// members, or — a string — its pieces, the first set and the rest appended.
/** @param {unknown} value @param {EntryPath} at @param {number} max @param {Entry[]} out */
function entriesOf(value, at, max, out) {
  if (entryBytes([at, value]) <= max) out.push([at, value])
  else if (Array.isArray(value)) {
    out.push([at, []])
    value.forEach((v, i) => entriesOf(v, [...at, i], max, out))
  } else if (value && typeof value === 'object') {
    out.push([at, {}])
    for (const [k, v] of Object.entries(value)) entriesOf(v, [...at, k], max, out)
  } else if (typeof value === 'string') stringPieces(value, at, max, out)
  else out.push([at, value])
}

/** @param {string} value @param {EntryPath} at @param {number} max @param {Entry[]} out */
function stringPieces(value, at, max, out) {
  const room = Math.max(256, max - entryBytes([at, '']) - 16)
  let rest = value
  for (let first = true; first || rest; first = false) {
    let n = Math.min(rest.length, room)
    // Escapes widen a piece past its length: halve until the escaped piece fits.
    while (n > 1 && utf8Length(JSON.stringify(rest.slice(0, n))) > room) n = Math.ceil(n / 2)
    out.push(first ? [at, rest.slice(0, n)] : [at, rest.slice(0, n), 1])
    rest = rest.slice(n)
  }
}

// Entries packed in order into groups of at most `max` bytes.
/** @param {Entry[]} entries @param {number} max @returns {Entry[][]} */
function packEntries(entries, max) {
  /** @type {Entry[][]} */
  const groups = []
  let bytes = 0
  for (const e of entries) {
    const size = entryBytes(e)
    const last = groups.at(-1)
    if (last && bytes + size <= max) { last.push(e); bytes += size; continue }
    groups.push([e])
    bytes = size
  }
  return groups
}

// The record's small top-level values: what the store reads off any record (kind, name, round, verdict, the
// findings summary, the ledger's shard declaration…), kept on the header so a record short of parts still
// says what it was and where its ledger is. A whole `ledger` array is declared by its length, so a part
// that held some of it lost makes the next round read the ledger as truncated (realm @nick/craft, node #245).
/** @param {Record<string, unknown>} record @returns {Record<string, unknown>} */
function headerOf(record) {
  /** @type {Record<string, unknown>} */
  const header = {}
  for (const [k, v] of Object.entries(record)) if ((JSON.stringify(v) ?? '').length <= HEADER_VALUE_MAX) header[k] = v
  return header
}

/**
 * The record's parts, each a checkpoint payload of at most `max` bytes of entries, and the header finalize
 * gets in the record's place: its short top-level scalars and `recordInParts`. No parts when it fits one call.
 * @param {Record<string, unknown>} recordIn @param {{ max?: number }} [opts]
 * @returns {{ header: Record<string, unknown>, parts: RecordPart[] }}
 */
export function cutRecord(recordIn, { max = RECORD_ONE_CALL_MAX_BYTES } = {}) {
  if (recordBytes(recordIn) <= max) return { header: recordIn, parts: [] }
  const text = JSON.stringify(recordIn)
  const record = /** @type {Record<string, unknown>} */ (JSON.parse(text))
  /** @type {Entry[]} */
  const entries = []
  for (const [k, v] of Object.entries(record)) entriesOf(v, [k], max, entries)
  const groups = packEntries(entries, max)
  const id = contentId(text)
  return {
    header: { ...headerOf(record), recordInParts: { of: groups.length, id, ...(Array.isArray(record['ledger']) ? { ledger: record['ledger'].length } : {}) } },
    parts: groups.map((g, i) => ({ recordPart: { index: i + 1, of: groups.length, id }, recordEntries: g })),
  }
}
