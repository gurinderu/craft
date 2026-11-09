// The recalled memory records of kind `external` (realm @nick/craft, node #431) a review can use, and why each other
// one cannot. A record reads its deployed version from a file of the consumer's (`versionFrom`, `versionMatch`), or
// carries the version the human stated when no file names it (node #440). Pure: the engine bundles it.
// The CLI review reads integration points from the reviewer's profile instead (node #467), and `craft init --propose`
// imports these records into it (lib/craft-externals-memory.mjs). The memory's write path for them went away with the JS
// review engine (realm @nick/craft, node #470); this read stays for that import and for rust-audit's memory line.
import { EXTERNALS_MAX, SYSTEM_NAME } from './external-source-spec.mjs'

/** @typedef {import('./external-source-spec.mjs').ExternalRecord} ExternalRecord */

// The bound of a record's text fields.
const FIELD_MAX = 300

/** @param {unknown} v @returns {string} */
const fieldText = v => (typeof v === 'string' ? v.trim() : '')

/**
 * The recalled `external` records the review can use, and why each other one cannot: a well-formed `system` and
 * `repo`, and either `versionFrom` and `versionMatch` or a `version` the human stated (realm @nick/craft, node #440),
 * the file winning when a record carries both, as text within FIELD_MAX, not withdrawn or superseded; one per system (the first kept), at most
 * EXTERNALS_MAX. The URL, the pattern and the revision are the CLI's to judge, per system, where they fail.
 * @param {unknown} list @returns {{ records: ExternalRecord[], refused: string[] }}
 */
export function externalRecords(list) {
  /** @type {ExternalRecord[]} */
  const records = []
  /** @type {string[]} */
  const refused = []
  for (const [i, x] of (Array.isArray(list) ? list : []).entries()) {
    const r = /** @type {Record<string, unknown>} */ (x && typeof x === 'object' && !Array.isArray(x) ? x : {})
    const rec = recordOf(r)
    const why = recordFault(rec, fieldText(r['status']), records)
    if (why) refused.push(`external record #${i}${SYSTEM_NAME.test(rec.system) ? ` (${rec.system})` : ''}: ${why}`)
    else records.push(rec)
  }
  return { records, refused }
}

/**
 * A record's text fields. The file is the source of truth: a stated version stands only where the record names no
 * file (node #440). @param {Record<string, unknown>} r @returns {ExternalRecord}
 */
function recordOf(r) {
  const versionFrom = fieldText(r['versionFrom'])
  const versionMatch = fieldText(r['versionMatch'])
  const version = versionFrom || versionMatch ? '' : fieldText(r['version'])
  return { system: fieldText(r['system']), repo: fieldText(r['repo']), versionFrom, versionMatch, scope: fieldText(r['scope']), ...(version ? { version } : {}) }
}

/** Why a record is not used, '' when it is. @param {ExternalRecord} rec @param {string} status @param {ExternalRecord[]} kept */
function recordFault(rec, status, kept) {
  if (status && status !== 'active') return `status ${status}`
  if (!SYSTEM_NAME.test(rec.system)) return 'no system name of letters, digits, `.`, `_` or `-`'
  const fields = fieldFault(rec)
  if (fields) return fields
  if (kept.some(k => k.system === rec.system)) return 'a second record of the same system'
  if (kept.length >= EXTERNALS_MAX) return `past the bound of ${EXTERNALS_MAX} systems`
  return ''
}

/** Why its fields fail: a field missing or too long (node #440). @param {ExternalRecord} rec */
function fieldFault(rec) {
  const need = rec.version ? /** @type {const} */ (['repo', 'version']) : /** @type {const} */ (['repo', 'versionFrom', 'versionMatch'])
  const missing = need.find(k => !rec[k] || String(rec[k]).length > FIELD_MAX)
  return missing ? `${missing} missing or over ${FIELD_MAX} characters` : ''
}
