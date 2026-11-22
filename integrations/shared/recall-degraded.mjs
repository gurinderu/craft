// A recall that may not have read the project's memory store (realm @nick/craft, node #203): its backend query failed
// (`queryError`, all of it or part) or its agent gave no answer, it read only part of what the backend held
// (`truncated`), or the launcher's own recall was such (`recallDegraded`, the binary's `--recall-degraded`). Each is a
// bounded one-line note and makes the run's memory degraded, never read as the project having none, as the craft
// binary words it (cli/crates/craft-review/src/memory/degraded.rs).

/** The most UTF-16 units of a recall's note a run keeps, its `…` included. */
export const RECALL_NOTE_MAX = 300

/**
 * A recall's note as one line: control characters dropped, whitespace collapsed, cut to RECALL_NOTE_MAX; '' when blank.
 * @param {unknown} v @returns {string}
 */
export function recallNote(v) {
  if (typeof v !== 'string') return ''
  const s = Array.from(v, c => (isControl(c.charCodeAt(0)) ? ' ' : c))
    .join('')
    .replace(/\s+/g, ' ')
    .trim()
  return s.length > RECALL_NOTE_MAX - 1 ? `${s.slice(0, RECALL_NOTE_MAX - 1)}…` : s
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

/**
 * The degraded notes of a memory source: a failed query (all of it, or part, the records it returned applied), a
 * truncated answer, a launcher's degraded recall; [] when it read the store whole.
 * @param {{ source?: string, count?: number, queryError?: string, truncated?: string, recallDegraded?: string, passed?: number }} m @returns {string[]}
 */
export function memoryDegradedNotes(m) {
  const failed =
    m.source === 'recalled'
      ? `memory: recall partly failed — backend query may have failed: ${m.queryError ?? ''}; the ${String(m.count ?? 0)} record(s) it returned were applied, others may be missing`
      : `memory: not read — recall found nothing, backend query may have failed: ${m.queryError ?? ''}; ${appliedInstead(m)}`
  return [
    ...(m.queryError ? [failed] : []),
    ...(m.truncated ? [`memory: recall read only part of the backend's answer (${m.truncated}): the records past it were not applied`] : []),
    ...(m.recallDegraded
      ? [`memory: the launcher's recall may not have read the whole store (${m.recallDegraded}): only the records it handed on were applied`]
      : []),
  ]
}

/**
 * What a launching engine tells the reviews it starts of its own recall's degradation (`_recallDegraded`): its notes as
 * one bounded line, '' when it read the store whole.
 * @param {Parameters<typeof memoryDegradedNotes>[0]} m @returns {string}
 */
export const forwardedDegraded = m =>
  recallNote(
    memoryDegradedNotes(m)
      .map(n => n.replace(/^memory: /, ''))
      .join('; '),
  )
