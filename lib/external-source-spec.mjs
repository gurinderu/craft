// The external systems a review reads the source of (realm @nick/craft, node #430 for the cache and its CLI, node
// #431 for the memory record kind `external`, read by lib/external-record.mjs): the checks lib/craft-source.mjs and the
// record reader share — a system's name, its repository URL and the revision. Pure (no Buffer, no Node API).

// How many systems one review prepares; records past it are named and dropped.
export const EXTERNALS_MAX = 8
// The bounds of a revision, and of its version pattern (compiled and run, so held short).
const REF_MAX = 128
const VERSION_MATCH_MAX = 200

/** @typedef {{ system: string, repo: string, versionFrom: string, versionMatch: string, scope: string, version?: string }} ExternalRecord  `version` only when stated (node #440) */

// A system's name: what the report and the lens prompts print, and a finding's `externalSystem` matches.
export const SYSTEM_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

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
