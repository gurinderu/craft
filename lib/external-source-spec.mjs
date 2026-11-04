// The external systems a review reads the source of (realm @nick/craft, node #430 for the cache and its CLI,
// node #431 for the memory record kind `external`): what a record must carry, the spec the ENGINE builds from
// the records for lib/craft-source.mjs (never typed by a model, #375), and the checks both sides share — a
// system's name, its repository URL and the revision read from the consumer's file. Pure: the engine imports
// it inside the Workflow sandbox (no Buffer, no Node API), the CLI beside its own I/O.
import { utf8Bytes } from './lens-scope.mjs'

// How many systems one review prepares; records past it are named and dropped.
export const EXTERNALS_MAX = 8
// The bounds of a record's text fields, and of a revision.
const FIELD_MAX = 300
const REF_MAX = 128
// The longest version pattern a record may carry: the pattern is compiled and run, so it is held short.
const VERSION_MATCH_MAX = 200

/** @typedef {{ system: string, repo: string, versionFrom: string, versionMatch: string, scope: string }} ExternalRecord */
/** @typedef {{ system: string, repo: string, versionFrom: string, versionMatch: string }} SpecEntry  one system of the CLI's spec */

// A system's name: what the report and the lens prompts print, and a finding's `externalSystem` matches.
export const SYSTEM_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

/** @param {unknown} v @returns {string} */
const fieldText = v => (typeof v === 'string' ? v.trim() : '')

/**
 * The recalled `external` records the review can use, and why each other one cannot: an object with a
 * well-formed `system` and `repo`, `versionFrom` and `versionMatch` as text within FIELD_MAX, not withdrawn
 * or superseded; one per system (the first kept), at most EXTERNALS_MAX. The URL and the pattern are the
 * CLI's to judge, per system, so a bad one is reported where it fails.
 * @param {unknown} list @returns {{ records: ExternalRecord[], refused: string[] }}
 */
export function externalRecords(list) {
  /** @type {ExternalRecord[]} */
  const records = []
  /** @type {string[]} */
  const refused = []
  for (const [i, x] of (Array.isArray(list) ? list : []).entries()) {
    const r = /** @type {Record<string, unknown>} */ (x && typeof x === 'object' && !Array.isArray(x) ? x : {})
    const rec = { system: fieldText(r['system']), repo: fieldText(r['repo']), versionFrom: fieldText(r['versionFrom']), versionMatch: fieldText(r['versionMatch']), scope: fieldText(r['scope']) }
    const why = recordFault(rec, fieldText(r['status']), records)
    if (why) refused.push(`external record #${i}${SYSTEM_NAME.test(rec.system) ? ` (${rec.system})` : ''}: ${why}`)
    else records.push(rec)
  }
  return { records, refused }
}

/** Why a record is not used, '' when it is. @param {ExternalRecord} rec @param {string} status @param {ExternalRecord[]} kept */
function recordFault(rec, status, kept) {
  if (status && status !== 'active') return `status ${status}`
  if (!SYSTEM_NAME.test(rec.system)) return 'no system name of letters, digits, `.`, `_` or `-`'
  const missing = /** @type {const} */ (['repo', 'versionFrom', 'versionMatch']).find(k => !rec[k] || rec[k].length > FIELD_MAX)
  if (missing) return `${missing} missing or over ${FIELD_MAX} characters`
  if (kept.some(k => k.system === rec.system)) return 'a second record of the same system'
  if (kept.length >= EXTERNALS_MAX) return `past the bound of ${EXTERNALS_MAX} systems`
  return ''
}

// ---- the spec: JSON, as base64url, so it rides in the shell command as one inert word ----
const B64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'

/** A value as a list: itself when it is one, else none. @param {unknown} v @returns {unknown[]} */
export const asList = v => (Array.isArray(v) ? v : [])

/** Unpadded base64url of a string's UTF-8 bytes. @param {string} s @returns {string} */
export function base64url(s) {
  const b = utf8Bytes(s)
  let out = ''
  for (let i = 0; i < b.length; i += 3) {
    const n = ((b[i] ?? 0) << 16) | ((b[i + 1] ?? 0) << 8) | (b[i + 2] ?? 0)
    const chars = [18, 12, 6, 0].map(sh => B64URL[(n >> sh) & 63])
    out += chars.slice(0, Math.min(4, b.length - i + 1)).join('')
  }
  return out
}

/** The CLI's `--spec` for these records: their fields the CLI reads, as base64url JSON. @param {ExternalRecord[]} records */
export function encodeSpec(records) {
  return base64url(JSON.stringify(records.map(r => ({ system: r.system, repo: r.repo, versionFrom: r.versionFrom, versionMatch: r.versionMatch }))))
}

// ---- the checks the CLI applies to each system ----
const HTTPS = /^https:\/\/([A-Za-z0-9.-]+)(?::\d{1,5})?\/([A-Za-z0-9._~/-]+)$/
const SSH = /^ssh:\/\/(?:[A-Za-z0-9._-]+@)?([A-Za-z0-9.-]+)(?::\d{1,5})?\/([A-Za-z0-9._~/-]+)$/
const SCP = /^[A-Za-z0-9._-]+@([A-Za-z0-9.-]+):([A-Za-z0-9._~][A-Za-z0-9._~/-]*)$/

/**
 * A repository URL the CLI clones: https://, ssh:// or git@host:path, no option-like start, no whitespace,
 * no credentials in an https URL, no `..` segment — its host and path, or why it is refused.
 * @param {string} url @returns {{ host: string, path: string } | { error: string }}
 */
export function repoUrlParts(url) {
  if (!url || url.startsWith('-') || /\s/.test(url)) return { error: 'repo is empty, starts with "-" or holds whitespace' }
  const m = HTTPS.exec(url) ?? SSH.exec(url) ?? SCP.exec(url)
  if (!m || !/^[A-Za-z0-9]/.test(String(m[1]))) return { error: 'repo is not an https://, ssh:// or git@host:path URL' }
  const segs = String(m[2]).replace(/\.git$/, '').split('/').filter(Boolean)
  if (!segs.length || segs.some(s => s === '.' || s === '..')) return { error: 'repo has no path, or a "." or ".." segment' }
  return { host: String(m[1]).toLowerCase(), path: segs.join('/') }
}

/** Why `ref` is not a revision the CLI fetches, '' when it is: a tag, branch name or commit in a safe charset. @param {string} ref */
export function refFault(ref) {
  if (!ref) return 'no revision'
  if (ref.length > REF_MAX) return `revision over ${REF_MAX} characters`
  if (!/^[A-Za-z0-9][A-Za-z0-9._+/-]*$/.test(ref)) return 'revision outside [A-Za-z0-9._+/-] or starting with a non-alphanumeric'
  if (ref.includes('..') || ref.includes('//') || ref.endsWith('/') || ref.endsWith('.lock')) return 'revision with "..", "//", a trailing "/" or ".lock"'
  return ''
}

/** Whether the revision is a full commit id, fetched by sha rather than cloned by name. @param {string} ref */
export const isCommitId = ref => /^[0-9a-f]{40}$/.test(ref)

/**
 * The pattern that reads the revision, compiled: one capture group exactly, else why not.
 * @param {string} src @returns {{ re: RegExp } | { error: string }}
 */
export function versionPattern(src) {
  if (src.length > VERSION_MATCH_MAX) return { error: `versionMatch over ${VERSION_MATCH_MAX} characters` }
  /** @type {RegExp} */
  let re
  // The consumer's own memory record, run on the consumer's own file, length-capped above: no outside party's regex.
  // Each marker is a legal comment (`//!`) trailing its line, so it survives into the bundled engines and ends the
  // bundled line there too (lib/engine-bundle.mjs).
  try { re = new RegExp(src, 'm') } catch (e) { return { error: `versionMatch does not compile: ${e instanceof Error ? e.message : String(e)}` } } //! nosemgrep: javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp
  // An alternation with the empty pattern matches '' and reports every group, so its length counts them.
  // The same capped pattern of the consumer's own record, run once on the empty string.
  const groups = (/** @type {RegExpExecArray} */ (new RegExp(`${src}|`, 'm').exec(''))).length - 1 //! nosemgrep: javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp
  return groups === 1 ? { re } : { error: `versionMatch has ${groups} capture groups, not exactly one` }
}

/** The revision `re` reads from `text`, or why none. @param {RegExp} re @param {string} text @returns {{ ref: string } | { error: string }} */
export function readRef(re, text) {
  const m = re.exec(text)
  const ref = m ? String(m[1] ?? '').trim() : ''
  if (!ref) return { error: 'versionMatch found no version in versionFrom' }
  const why = refFault(ref)
  return why ? { error: `${why}: ${JSON.stringify(ref.slice(0, 60))}` } : { ref }
}

/** One path segment of the cache, filename-safe. @param {string} s */
const segment = s => s.replace(/[^A-Za-z0-9._+-]/g, '_')

/**
 * The cache-relative directory of a system at a revision: `<host>/<path>@<ref>`, a `/` in the revision
 * spelled `~` (git refuses `~` in a ref name, so two revisions never share a directory).
 * @param {{ host: string, path: string }} parts @param {string} ref @returns {string[]}
 */
export function cacheSegments(parts, ref) {
  const segs = [parts.host, ...parts.path.split('/')].map(segment)
  segs[segs.length - 1] = `${segs[segs.length - 1]}@${ref.replace(/\//g, '~')}`
  return segs
}
