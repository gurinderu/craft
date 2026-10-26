// The Workflow tool's line numbers for an engine file (realm @nick/craft, #348): it cuts the `export const meta = {…}`
// statement out and runs the rest with one wrapper line in its place, so a line it reports after meta is the file
// line less the meta statement's lines but one. Read from the shipped text, never a fixed count: meta grows with
// its description. Node's standard library only, like the source-map reader that calls it.

/** @typedef {{ start: number, end: number }} Span  1-based, inclusive */

/** The index just past the end `close` of a comment opened at `i`, or the end of the text. @param {string} text @param {number} i @param {string} close */
function pastComment(text, i, close) {
  const n = text.indexOf(close, i + 2)
  return n < 0 ? text.length : n + (close === '\n' ? 0 : close.length)
}

/**
 * The index just past the string or comment that `i` opens, or `i + 1`.
 * @param {string} text @param {number} i @returns {number}
 */
function skipQuoted(text, i) {
  const ch = text[i]
  const two = text.slice(i, i + 2)
  if (two === '//') return pastComment(text, i, '\n')
  if (two === '/*') return pastComment(text, i, '*/')
  if (ch !== "'" && ch !== '"' && ch !== '`') return i + 1
  let j = i + 1
  while (j < text.length && text[j] !== ch) j += text[j] === '\\' ? 2 : 1
  return j + 1
}

/**
 * The lines of the top-level `export const meta = {…}` statement, or null when the file has none.
 * @param {string} text @returns {Span | null}
 */
export function metaSpan(text) {
  const m = /^export const meta\s*=\s*\{/m.exec(text)
  if (!m) return null
  let depth = 0
  let i = m.index + m[0].length - 1
  while (i < text.length) {
    const ch = text[i]
    if (ch === '{') depth++
    else if (ch === '}' && --depth === 0) break
    i = ch === '{' || ch === '}' ? i + 1 : skipQuoted(text, i)
  }
  const lineAt = (/** @type {number} */ at) => text.slice(0, at).split('\n').length
  return { start: lineAt(m.index), end: lineAt(i) }
}

/**
 * The file line the harness calls `line`; null for the wrapper line that stands where meta was.
 * @param {string} text  the engine as it ships @param {number} line  1-based, as the harness reports it
 * @returns {number | null}
 */
export function fileLine(text, line) {
  const span = metaSpan(text)
  if (!span || line < span.start) return line
  return line === span.start ? null : line + span.end - span.start
}
