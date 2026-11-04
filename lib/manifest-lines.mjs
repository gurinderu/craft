// A minimal, line-based reading of YAML for the discovery of external systems (realm @nick/craft, node #435):
// `key: value` lines, their key column and list dash, a mapping's sibling keys, and the `versionMatch` pattern
// that reads a version from such a line or from a pair of sibling lines. Conservative by design: a value that is
// templated, quoted oddly, a flow collection or a block scalar is no value. Pure.

/** @typedef {{ col: number, dash: boolean, key: string, value: string, rest: string }} KeyLine  `col` the key's column, `rest` the line from the key on */

const KEY_LINE = /^([ \t]*)(-[ \t]+)?([A-Za-z_][A-Za-z0-9_.-]*):(?:[ \t]+(.*?))?[ \t\r]*$/
// The capture of a version: unquoted, up to a quote, whitespace, a comment or a digest.
const BARE_CAPTURE = `([^"'\\s#@]+)`
export const VERSION_CAPTURE = `["']?${BARE_CAPTURE}`

/** A string as a literal inside a regular expression. @param {string} s */
export const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** A plain scalar: comment and matching quotes stripped; '' for a template, flow, block, anchor, alias or tag. @param {string} raw */
export function scalarValue(raw) {
  const v = raw.replace(/(^|[ \t])#.*$/, '').trim()
  const unq = /^(["'])(.*)\1$/.exec(v)
  const s = unq ? String(unq[2]) : v
  if (!s || /[{}[\]|>&*!`$\s"']/.test(s.charAt(0)) || /\{\{|\$\{|\s/.test(s)) return ''
  return s
}

/** The `key: value` reading of a line, null when it is none. @param {string} line @returns {KeyLine | null} */
export function keyLine(line) {
  const m = KEY_LINE.exec(line)
  if (!m) return null
  const col = String(m[1]).length + (m[2] ? m[2].length : 0)
  return { col, dash: !!m[2], key: String(m[3]), value: scalarValue(m[4] ?? ''), rest: line.slice(col).replace(/[ \t\r]+$/, '') }
}

/** @param {string} line */
const lead = line => (/^[ \t]*/.exec(line)?.[0].length ?? 0)
/** @param {string} line */
const blank = line => /^[ \t]*(?:#.*)?\r?$/.test(line)

/** Whether line `l` holds `key` at the key column of `at`. @param {KeyLine} at @param {string} key @param {string} l */
function isSibling(at, key, l) {
  const k = keyLine(l)
  return !!k && k.col === at.col && k.key === key
}

/** Whether line `l` opens a list item at the key column of `at`. @param {KeyLine} at @param {string} l */
function isItemHead(at, l) {
  const k = keyLine(l)
  return !!k && k.dash && k.col === at.col
}

/** The sibling `key` after line `i`, -1 when the mapping ends first. @param {string[]} lines @param {number} i @param {KeyLine} at @param {string} key */
function below(lines, i, at, key) {
  for (let j = i + 1; j < lines.length; j++) {
    const l = String(lines[j])
    if (blank(l)) continue
    if (lead(l) < at.col) return -1
    if (isSibling(at, key, l)) return j
  }
  return -1
}

/** The sibling `key` before line `i`, -1 when the mapping or the list item starts first. @param {string[]} lines @param {number} i @param {KeyLine} at @param {string} key */
function above(lines, i, at, key) {
  for (let j = i - 1; j >= 0; j--) {
    const l = String(lines[j])
    if (blank(l)) continue
    if (isSibling(at, key, l)) return j
    if (lead(l) < at.col || isItemHead(at, l)) return -1
  }
  return -1
}

/**
 * The line of `key` in the same mapping as line `i` (the same key column, the same list item), -1 when none:
 * deeper lines are passed over, a shallower one or the next item's dash ends the mapping; a list item's head line
 * looks only below itself.
 * @param {string[]} lines @param {number} i @param {string} key
 */
export function siblingIndex(lines, i, key) {
  const at = keyLine(String(lines[i]))
  if (!at) return -1
  const j = below(lines, i, at, key)
  return j >= 0 || at.dash ? j : above(lines, i, at, key)
}

/**
 * The plain value of the sibling `key` of line `i` and its line; null when there is none, or it is `latest` (a tag
 * that moves) when `tag` is set.
 * @param {string[]} lines @param {number} i @param {string} key @param {{ tag?: boolean }} [o] @returns {{ j: number, value: string } | null}
 */
export function siblingValue(lines, i, key, { tag = false } = {}) {
  const j = siblingIndex(lines, i, key)
  const value = j >= 0 ? keyLine(String(lines[j]))?.value ?? '' : ''
  return value && !(tag && value === 'latest') ? { j, value } : null
}

/** A pattern for one exact line (its text from the key on), at any indent, behind an optional dash. @param {string} rest */
const exactLine = rest => `^[ \\t]*(?:-[ \\t]+)?${escapeRe(rest)}`
/** @param {string} key */
const versionLine = key => `^[ \\t]*(?:-[ \\t]+)?${escapeRe(key)}:[ \\t]*${VERSION_CAPTURE}`

/**
 * The pattern that reads the version on line `v` (its key `key`) as the sibling of the anchor line `a`, the lines
 * between counted exactly, so the first match is that pair. Multiline: `^` starts a line.
 * @param {string[]} lines @param {number} a @param {number} v @param {string} key
 */
export function pairPattern(lines, a, v, key) {
  const anchor = /** @type {KeyLine} */ (keyLine(String(lines[a])))
  const gap = Math.abs(v - a) - 1
  const between = gap ? `(?:[^\\n]*\\n){${gap}}` : ''
  return v > a
    ? `${exactLine(anchor.rest)}[ \\t\\r]*\\n${between}${versionLine(key)}`
    : `${versionLine(key)}[^\\n]*\\n${between}${exactLine(anchor.rest)}[ \\t\\r]*$`
}

/** The pattern that reads the version at the end of one line: `prefix` (the line from its key on, up to the version). @param {string} prefix */
export const linePattern = prefix => `${exactLine(prefix)}${BARE_CAPTURE}`
