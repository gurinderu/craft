// The one rule every verdict of a review engine passes through before it is filed or shown: an
// Approve is a claim about what was NOT found, so it holds only over what ran. When any dispatched
// lens, verifier or dimension died, returned nothing or was not run, the verdict is INCOMPLETE,
// never Approve; a Block or Warning stays (its findings were made) and carries the (INCOMPLETE)
// marker (realm @nick/craft, node #299). Pure: no agent, no log, no workflow state. Inlined into
// src/review.js, src/adversarial-review.js and src/rust-audit.js.

export const GREEN_WORD = /^\s*(?:Approve|Healthy|Clean)\b/i
export const VERDICT_WORD = /\b(Approve|Healthy|Clean|Block|Warning|Concerns|At-risk|UB-found|INCOMPLETE)\b/i
export const NOTE_MAX = 600

/** @param {unknown} notRun @returns {string[]} */
export function notRunList(notRun) {
  return (Array.isArray(notRun) ? notRun : []).map(n => String(n ?? '').trim()).filter(Boolean)
}

/**
 * The verdict a run may claim: unchanged when nothing failed to run; INCOMPLETE in place of a green
 * one; a red one marked ` (INCOMPLETE)` once.
 * @param {unknown} verdict the verdict over the findings, suffix included or not
 * @param {unknown} notRun what did not run (any entry counts)
 * @returns {string}
 */
export function honestVerdict(verdict, notRun) {
  const v = String(verdict ?? '').trim()
  if (!notRunList(notRun).length) return v
  if (!v || GREEN_WORD.test(v)) return 'INCOMPLETE'
  return /INCOMPLETE/i.test(v) ? v : `${v} (INCOMPLETE)`
}

/** The index of the line carrying the verdict word, or -1. @param {string[]} lines @returns {number} */
export function verdictLineAt(lines) {
  const head = lines.findIndex(l => /verdict/i.test(l))
  if (head < 0) return -1
  const after = String(lines[head]).replace(/^[\s#*_>-]*verdict\b/i, '')
  if (VERDICT_WORD.test(after)) return head
  return lines.findIndex((l, i) => i > head && l.trim())
}

/**
 * A rendered report whose verdict line no longer says Approve when something did not run: the first
 * verdict word of the line under the verdict heading (or on it), when green, becomes INCOMPLETE and
 * the line names what did not run. A red verdict line, and any report when everything ran, is
 * returned as it came.
 * @param {unknown} text
 * @param {unknown} notRun
 * @returns {string}
 */
export function honestVerdictLine(text, notRun) {
  const s = String(text ?? '')
  const missing = notRunList(notRun)
  if (!missing.length) return s
  const lines = s.split('\n')
  const at = verdictLineAt(lines)
  if (at < 0) return s
  const line = String(lines[at])
  const word = VERDICT_WORD.exec(line.replace(/^[\s#*_>-]*verdict\b/i, ''))
  if (!word || !GREEN_WORD.test(String(word[1]))) return s
  const fixed = line.replace(/(?:(?:\u2705|\u26a0\ufe0f?)\s*)?\b(?:Approve|Healthy|Clean)\b(?:\s*\((?:INCOMPLETE|PARTIAL COVERAGE)\))?/i, '\u26a0\ufe0f INCOMPLETE')
  const list = missing.join('; ')
  const named = /did not run/i.test(fixed) ? '' : ` \u00b7 part of this review did not run: ${list.length > NOTE_MAX ? `${list.slice(0, NOTE_MAX)}\u2026` : list}`
  lines[at] = `${fixed}${named}`
  return lines.join('\n')
}
