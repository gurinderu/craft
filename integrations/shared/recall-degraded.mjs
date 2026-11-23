// A recall that may not have read the project's memory store (realm @nick/craft, node #203): its backend query failed
// (`queryError`, all of it or part) or its agent gave no answer, it read only part of what the backend held
// (`truncated`), or the launcher's own recall was such (`recallDegraded`, the binary's `--recall-degraded`). Each is a
// bounded one-line note and makes the run's memory degraded, never read as the project having none, as the craft
// binary words it (cli/crates/craft-review/src/memory/degraded.rs).

/** The most UTF-16 units of a recall's note a run keeps, its `…` included. */
export const RECALL_NOTE_MAX = 300

/**
 * A recall's note as one line: control characters dropped, whitespace collapsed, cut by code points to RECALL_NOTE_MAX
 * UTF-16 units (or `max`), its `…` included, as the binary's `clip` cuts it (no lone surrogate); '' when blank — the
 * same rule the binary's `--recall-degraded` refuses a blank note by.
 * @param {unknown} v @param {number} [max] @returns {string}
 */
export function recallNote(v, max = RECALL_NOTE_MAX) {
  if (typeof v !== 'string') return ''
  const s = Array.from(v, c => (isControl(c.charCodeAt(0)) ? ' ' : c))
    .join('')
    .replace(/\s+/g, ' ')
    .trim()
  return cutUnits(s, max)
}

/**
 * A launcher's `_recallDegraded` as the note a launching engine keeps and hands on: '' when not given (null or absent),
 * and one that cannot be read — not a string, or nothing but whitespace and control characters, which the binary and
 * the review driver refuse — is itself a degradation, named by its cleaned, cut value, never read as clean.
 * @param {unknown} v @returns {string}
 */
export function launcherDegradedNote(v) {
  if (v == null) return ''
  // JSON.stringify gives no text for a function or a symbol: its type names it.
  const shown = typeof v === 'function' || typeof v === 'symbol' ? typeof v : JSON.stringify(v)
  return recallNote(v) || `the launcher passed an unreadable _recallDegraded (${recallNote(shown, 60) || 'blank'})`
}

/**
 * `s` when it is at most `max` UTF-16 units, else cut by code points to `max`, its `…` included.
 * @param {string} s @param {number} max @returns {string}
 */
function cutUnits(s, max) {
  if (s.length <= max) return s
  let kept = ''
  for (const c of s) {
    if (kept.length + c.length > max - 1) break
    kept += c
  }
  return `${kept}…`
}

/** A C0 or C1 control character, or DEL. @param {number} code @returns {boolean} */
const isControl = code => code < 0x20 || (code >= 0x7f && code <= 0x9f)

/**
 * The `why` of a recall whose backend query `q` may have failed; `found` when it still returned records.
 * @param {string} why @param {string} q @param {boolean} found @returns {string}
 */
export const failedWhy = (why, q, found) => `${why}; ${found ? 'recall partly failed' : 'recall found nothing'} — backend query may have failed: ${q}`

/**
 * What applied in place of a recall that read nothing. @param {{ passed?: number }} m @returns {string}
 */
const appliedInstead = m =>
  m.passed
    ? `only the launcher's own records were applied (${String(m.passed)} accepted, less any the store's inactive records held back)`
    : "none of the project's decisions or rules were applied"

/** What a partly failed recall returned and applied. @param {{ count?: number, externals?: number }} m @returns {string} */
const returned = m =>
  !m.count && m.externals
    ? `the ${String(m.externals)} external system(s) it returned were read`
    : `the ${String(m.count ?? 0)} record(s) it returned were applied`

/** @typedef {{ source?: string, count?: number, externals?: number, queryError?: string, recallDied?: string, truncated?: string, recallDegraded?: string, passed?: number }} DegradedSource */

/**
 * A failed query's note: partly, beside the records it returned, or not read at all. @param {DegradedSource} m @param {string} q
 * @returns {string}
 */
const failedNote = (m, q) =>
  m.source === 'recalled'
    ? `recall partly failed — backend query may have failed: ${q}; ${returned(m)}, others may be missing`
    : `not read — recall found nothing, backend query may have failed: ${q}; ${appliedInstead(m)}`

/**
 * The degraded notes of a memory source without their `memory: ` lead: a failed query (all of it, or part), a recall
 * agent that gave no answer, a truncated answer, a launcher's degraded recall; [] when it read the store whole.
 * @param {DegradedSource} m @returns {string[]}
 */
function degradedCauses(m) {
  return [
    ...(m.queryError ? [failedNote(m, m.queryError)] : []),
    ...(m.recallDied ? [`not read — ${m.recallDied}; ${appliedInstead(m)}`] : []),
    ...(m.truncated ? [`recall read only part of the backend's answer (${m.truncated}): the records past it were not applied`] : []),
    ...(m.recallDegraded ? [`the launcher's recall may not have read the whole store (${m.recallDegraded}): only the records it handed on were applied`] : []),
  ]
}

/** The degraded notes of a memory source, as the binary words them. @param {DegradedSource} m @returns {string[]} */
export const memoryDegradedNotes = m => degradedCauses(m).map(n => `memory: ${n}`)

/**
 * Whether a source that recalled nothing read none of the store it meant to: its query failed, its answer was truncated
 * (nothing of what the backend held was read), its agent died, or its launcher's recall was degraded. Its memory line then
 * leads `not read`; a recall that returned records leads with what it recalled, its degraded notes saying what was missed.
 * @param {DegradedSource} m @returns {boolean}
 */
export const notRead = m => Boolean(m.queryError || m.truncated || m.recallDied || m.recallDegraded)

/**
 * What a launching engine tells the reviews it starts of its own recall's degradation (`_recallDegraded`): each cause
 * bounded on its own, so a long one does not push out the others, joined in one line; '' when it read the store whole.
 * @param {DegradedSource} m @returns {string}
 */
export const forwardedDegraded = m => {
  const causes = degradedCauses(m)
  const each = Math.floor((RECALL_NOTE_MAX - 2 * Math.max(causes.length - 1, 0)) / Math.max(causes.length, 1))
  return causes.map(c => cutUnits(c, each)).join('; ')
}
