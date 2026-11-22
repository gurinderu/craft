// A recall that may not have read the project's memory store (realm @nick/craft, node #203): an empty one whose backend
// query may have failed (`queryError`, never read as the project having no memory) and one that read only part of what
// the backend held (`truncated`). Both are bounded one-line notes; each makes the run's memory degraded, as the craft
// binary's `MemorySource::degraded_notes` words it (cli/crates/craft-review/src/memory/source.rs).

/** The most characters of a query error or truncation note a run keeps. */
export const RECALL_NOTE_MAX = 300

/**
 * A recall's one-line note: its whitespace collapsed, '' when blank, cut to RECALL_NOTE_MAX characters.
 * @param {unknown} v @returns {string}
 */
export function recallNote(v) {
  const s = typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : ''
  const chars = Array.from(s)
  return chars.length > RECALL_NOTE_MAX ? `${chars.slice(0, RECALL_NOTE_MAX).join('')}…` : s
}

/**
 * The degraded notes of a memory source: its failed query, what the launcher's records still applied, and a
 * truncated answer; [] when it read the store whole.
 * @param {{ queryError?: string, truncated?: string, passed?: number }} m @returns {string[]}
 */
export function memoryDegradedNotes(m) {
  const applied = m.passed ? `only the ${m.passed} record(s) the launcher passed were applied` : "none of the project's decisions or rules were applied"
  return [
    ...(m.queryError ? [`memory: not read — recall found nothing, backend query may have failed: ${m.queryError}; ${applied}`] : []),
    ...(m.truncated ? [`memory: recall read only part of the backend's answer (${m.truncated}): the records past it were not applied`] : []),
  ]
}
