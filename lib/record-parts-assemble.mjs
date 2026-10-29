// A record sent in parts (lib/record-parts.mjs), put back by finalize from the part checkpoints in the run's
// own directory (realm @nick/craft, node #396) — on the terms #245 set for the ledger's shards: all of them,
// the record exactly; some or none, what they hold, the declaration kept and a warning. The parts arrive
// through a model's copy, so every entry is checked before it is placed. Kept apart from the cutting side,
// so the logger's closure carries none of what the engines need to cut.
import { settleParts, markShortLedger } from './record-parts-settle.mjs'

// A record's content id, computed on the cut side over its JSON and checked again on the rebuilt record:
// two FNV-1a passes and the length, since the sandbox has no crypto.
/** @param {string} text @returns {string} */
export function recordContentId(text) {
  let a = 0x811c9dc5, b = 0x01000193 ^ 0x5bd1e995
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i)
    a = Math.imul(a ^ c, 0x01000193) >>> 0
    b = Math.imul(b ^ c, 0x5bd1e995) >>> 0
  }
  return `${a.toString(16).padStart(8, '0')}${b.toString(16).padStart(8, '0')}-${text.length.toString(36)}`
}

/** @param {Record<string, unknown>} record @returns {{ of: number, id: string, ledger?: number } | null} */
export function declaredParts(record) {
  const d = /** @type {{ of?: unknown, id?: unknown, ledger?: unknown } | null | undefined} */ (record['recordInParts'])
  if (!d || typeof d !== 'object' || typeof d.id !== 'string') return null
  return { of: Number(d.of) || 0, id: d.id, ...(Number.isInteger(d.ledger) ? { ledger: Number(d.ledger) } : {}) }
}

// A checkpoint that carries a part of a record or a shard of its ledger: transport, not a phase of the run.
/** @param {unknown} p @returns {boolean} */
export function isTransportSlice(p) {
  const s = /** @type {{ ledgerShard?: unknown, recordPart?: unknown } | null} */ (p && typeof p === 'object' ? p : null)
  return !!(s && (s.ledgerShard || s.recordPart))
}

/** @param {object} at @param {string | number} k @param {unknown} v */
function put(at, k, v) {
  // Defined, never assigned: a key named `__proto__` stays a key.
  Object.defineProperty(at, k, { value: v, writable: true, enumerable: true, configurable: true })
}

/** @param {Record<string | number, unknown>} at @param {string | number} k @returns {unknown} */
function own(at, k) {
  return Object.prototype.hasOwnProperty.call(at, k) ? at[k] : undefined
}

/** @param {unknown} e @returns {e is [(string | number)[], unknown, unknown?]} */
function wellFormed(e) {
  if (!Array.isArray(e) || !Array.isArray(e[0]) || !e[0].length) return false
  return e[0].every(k => typeof k === 'string' || (Number.isInteger(k) && Number(k) >= 0))
}

// The container one entry's last key goes into, a missing parent made by its key's type, so a part that
// lost its container's marker still places its own values; null when the path crosses a scalar's kind.
/** @param {Record<string, unknown>} root @param {(string | number)[]} keys @returns {Record<string | number, unknown> | null} */
function containerFor(root, keys) {
  /** @type {Record<string | number, unknown>} */
  let at = root
  for (let i = 0; i < keys.length - 1; i++) {
    const k = /** @type {string | number} */ (keys[i])
    // The next level is read through `own` and the container made here, never `at[k]`: a part's key could
    // otherwise walk into a prototype (`__proto__`, `constructor`).
    let next = own(at, k)
    if (!next || typeof next !== 'object') { next = typeof keys[i + 1] === 'number' ? [] : {}; put(at, k, next) }
    at = /** @type {Record<string | number, unknown>} */ (next)
  }
  return Array.isArray(at) === (typeof keys.at(-1) === 'number') ? at : null
}

// Sets one entry into `root`; false when its shape is not one cutRecord makes.
/** @param {Record<string, unknown>} root @param {unknown} e @returns {boolean} */
function place(root, e) {
  if (!wellFormed(e)) return false
  const at = containerFor(root, e[0])
  if (!at) return false
  const last = /** @type {string | number} */ (e[0].at(-1))
  const prev = own(at, last)
  put(at, last, e[2] === 1 && typeof prev === 'string' ? prev + String(e[1]) : e[1])
  return true
}

// Arrays without the holes a missing part left.
/** @param {unknown} v @returns {unknown} */
function compact(v) {
  if (Array.isArray(v)) return v.filter((_, i) => i in v).map(compact)
  if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) put(v, k, compact(x))
  return v
}

// One checkpoint read as a part of the declared record: its index and entries; null when it is not one.
/** @param {unknown} p @param {{ of: number, id: string }} decl @returns {{ index: number, entries: unknown[] } | null} */
function partOf(p, decl) {
  const part = /** @type {{ recordPart?: { index?: unknown, id?: unknown }, recordEntries?: unknown }} */ (p && typeof p === 'object' ? p : {})
  if (part.recordPart?.id !== decl.id) return null
  const index = Number(part.recordPart.index)
  if (!Number.isInteger(index) || index < 1 || index > decl.of) return null
  return { index, entries: Array.isArray(part.recordEntries) ? part.recordEntries : [] }
}

// The entries of each declared part found, by index; the first copy of an index wins (a retried part).
/** @param {unknown[]} phases @param {{ of: number, id: string }} decl @returns {Map<number, unknown[]>} */
function partsByIndex(phases, decl) {
  /** @type {Map<number, unknown[]>} */
  const byIndex = new Map()
  for (const p of phases) {
    const part = partOf(p, decl)
    if (part && !byIndex.has(part.index)) byIndex.set(part.index, part.entries)
  }
  return byIndex
}

/**
 * The record to file: the header as it came when it declares no parts; otherwise the record put back from
 * this run's parts (`unusable` '' — the directory is present, read and proven its own).
 * @param {Record<string, unknown>} header @param {unknown[]} phases @param {string} unusable
 * @returns {{ record: Record<string, unknown>, warning: string }}
 */
export function recordFromParts(header, phases, unusable) {
  const decl = declaredParts(header)
  if (!decl) return { record: header, warning: '' }
  const byIndex = partsByIndex(unusable ? [] : phases, decl)
  /** @type {Record<string, unknown>} */
  const built = {}
  let bad = 0
  for (const k of [...byIndex.keys()].sort((a, b) => a - b)) bad += (byIndex.get(k) ?? []).filter(e => !place(built, e)).length
  // Every part present is not every entry present: a copy can drop or alter one and stay valid JSON. Only
  // the content id the cut side computed proves the record whole (a sparse array changes it too).
  const intact = recordContentId(JSON.stringify(built)) === decl.id
  const disagreed = settleParts(built, header)
  const complete = byIndex.size === decl.of && !bad
  if (complete && intact) return { record: built, warning: disagreed }
  const rest = { ...header }
  delete rest['recordInParts']
  const record = markShortLedger({ ...rest, .../** @type {Record<string, unknown>} */ (compact(built)), recordInParts: { ...decl, seen: byIndex.size, ...(complete ? { altered: true } : {}) } }, decl)
  // A dispute the parts raised stands over the header's revision, as on the whole record.
  if (record['workflowEngineRevisionDisputed'] !== undefined) delete record['workflowEngineRevision']
  return { record, warning: [disagreed, shortWarning(decl, { seen: byIndex.size, bad, unusable, complete })].filter(Boolean).join('\n') }
}

/** @param {{ of: number }} decl @param {{ seen: number, bad: number, unusable: string, complete: boolean }} got @returns {string} */
function shortWarning(decl, { seen, bad, unusable, complete }) {
  if (complete) return `craft-log-run WARNING: the record's ${decl.of} part(s) all came back, but what they hold is not the record that was cut (its content id differs) — record written with what they hold`
  const why = unusable ? `but ${unusable}` : `${seen} found${bad ? `, ${bad} entr(ies) unreadable` : ''}`
  return `craft-log-run WARNING: the record was declared in ${decl.of} part(s), ${why} — record written with what they hold`
}
