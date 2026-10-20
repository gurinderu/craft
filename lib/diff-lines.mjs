// The lines a diff changed, per file, for the "outside the diff" sign of the sorting before publication
// (realm @nick/craft, node #277). The engine runs in a sandbox with no shell of its own, so one cheap agent
// runs the fixed command `diffLinesScript` builds and returns its printed lines verbatim; everything after
// that is read here, deterministically. A hunk header `@@ -a,b +c,d @@` names the new-side lines c..c+d-1;
// d = 0 is a pure deletion after line c, whose site is c and c+1. Inlined into src/review.js.

/** @typedef {Map<string, Array<[number, number]>>} ChangedLines  file → [first, last] new-side line ranges */

// Each printed line: the tag, the `+c,d` field of a hunk header, the `+++` path (as git printed it).
export const HUNK_LINE = /^HUNK\t\+(\d+)(?:,(\d+))?\t(.*)$/

/**
 * The shell command that prints one `HUNK<TAB>+c,d<TAB><path>` line per hunk of the diff of `range` over
 * `files` (each single-quoted): `git diff -U0`, headers only, so a large diff prints a line per hunk.
 * @param {string} range the git diff range argument, already shell-safe (`--merge-base '<ref>'` or `HEAD`)
 * @param {string[]} files @returns {string}
 */
export function diffLinesScript(range, files) {
  /** @param {string} s */
  const q = s => `'${s.replace(/'/g, `'\\''`)}'`
  return `git diff -U0 --no-color --no-ext-diff ${range} -- ${files.map(q).join(' ')} | awk '/^\\+\\+\\+ /{f=substr($0,5)} /^@@ /{print "HUNK\\t" $3 "\\t" f}'`
}

export const DIFF_LINES_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['lines', 'reason'],
  properties: {
    lines: { type: 'array', items: { type: 'string' }, description: 'every line the command printed, verbatim, in order' },
    reason: { type: 'string', description: 'one line: anything that did not run' },
  },
}

/** The diff-lines agent's prompt. @param {string} range @param {string[]} files @returns {string} */
export function diffLinesPrompt(range, files) {
  return `Run this command in the repository under review, exactly as written (shell only, read only). It prints one line per changed hunk: the word HUNK, the new-side line field of the hunk header and the file path, separated by tabs.
${diffLinesScript(range, files)}
Return {lines: [every printed line, verbatim, tabs kept], reason: one line on anything that did not run}.`
}

/**
 * The changed new-side line ranges an answer names, or null when the answer is absent or unreadable — then
 * no finding can be placed inside or outside the diff. A path git quoted (a space, a non-ASCII byte) or a
 * deleted file (`/dev/null`) is left out, so its findings read as outside the diff — the side that goes to
 * the reviewer, never the one that is posted unasked.
 * @param {unknown} ans @returns {ChangedLines | null}
 */
export function readDiffLines(ans) {
  const lines = ans && typeof ans === 'object' ? /** @type {Record<string, unknown>} */ (ans)['lines'] : undefined
  if (!Array.isArray(lines)) return null
  /** @type {ChangedLines} */
  const out = new Map()
  for (const l of lines) {
    const h = hunkOf(l)
    if (h) out.set(h.file, [...(out.get(h.file) || []), h.range])
  }
  return out
}

/**
 * One printed line read: the file (git's `b/` prefix dropped) and its new-side range, or null for a line
 * that is not a hunk of a file this diff keeps.
 * @param {unknown} l @returns {{ file: string, range: [number, number] } | null}
 */
export function hunkOf(l) {
  const m = typeof l === 'string' ? HUNK_LINE.exec(l.trim()) : null
  const path = m ? String(m[3]).trim() : ''
  if (!m || !path.startsWith('b/')) return null
  const start = Number(m[1])
  const count = m[2] === undefined ? 1 : Number(m[2])
  return { file: path.slice(2), range: count > 0 ? [start, start + count - 1] : [start, start + 1] }
}

/**
 * Whether `line` of `file` is among the lines the diff changed: true or false, or null when it cannot be
 * told (no changed-lines answer, no line). A file the answer does not name was not changed: false.
 * @param {ChangedLines | null} changed @param {unknown} file @param {unknown} line @returns {boolean | null}
 */
export function lineInDiff(changed, file, line) {
  const n = Number(line)
  if (!changed || typeof file !== 'string' || !file || !Number.isInteger(n) || n <= 0) return null
  return (changed.get(file) || []).some(([a, b]) => n >= a && n <= b)
}
