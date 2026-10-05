// The compiler's output read back onto the engines it checked (lib/check-workflow-types.mjs): each
// `error TS` line at its line of workflows/<file>.js, its elaboration kept. A compile that failed
// with nothing to show for it never reads as a pass.
import { realOrResolved } from './script-main.mjs'

/** @typedef {{ file: string, offset: number, lines: number }} Wrapped  an engine's wrapped copy: its file, the lines the wrapper adds above it, its own line count */

/**
 * Every problem of one compile: those found before it, then tsc's errors. Fail closed: tsc that
 * exited non-zero checked nothing we can vouch for, whatever it printed, so with no problem to show
 * the exit itself is one.
 * @param {{ status: number, text: string }} run @param {Map<string, Wrapped>} byReal  engines by real path of their wrapped copy
 * @param {string[]} earlier @returns {string[]}
 */
export function compileProblems({ status, text }, byReal, earlier) {
  const problems = [...earlier, ...tscProblems(text, byReal)]
  if (status !== 0 && !problems.length) problems.push(`tsc exited ${status} with no diagnostic to report: ${text.trim().split('\n').slice(0, 3).join(' | ') || '(no output)'}`)
  return problems
}

/**
 * tsc's errors, each at its line of workflows/<file>.js where it falls in an engine's own lines.
 * @param {string} out @param {Map<string, Wrapped>} byReal @returns {string[]}
 */
function tscProblems(out, byReal) {
  /** @type {string[]} */
  const problems = []
  const outLines = out.split('\n')
  for (let k = 0; k < outLines.length; k++) {
    const line = /** @type {string} */ (outLines[k])
    if (!/(^|\s)error TS\d+/.test(line)) continue
    // tsc's elaboration ("Types of property … are incompatible") follows on indented lines.
    let more = ''
    while (k + 1 < outLines.length && /^\s+\S/.test(/** @type {string} */ (outLines[k + 1]))) more += `\n  ${/** @type {string} */ (outLines[++k]).trim()}`
    problems.push(locateTscError(line, byReal) + more)
  }
  return problems
}

/** @param {string} line  one `error TS` line of tsc's output @param {Map<string, Wrapped>} byReal @returns {string} */
function locateTscError(line, byReal) {
  const m = /^(.*?)\((\d+),(\d+)\): (.*)$/.exec(line)
  const at = m && byReal.get(realOrResolved(/** @type {string} */ (m[1])))
  if (!m || !at) return line.trim()
  const n = Number(m[2]) - at.offset
  return n >= 1 && n <= at.lines
    ? `${at.file}:${n}:${m[3]} ${m[4]}`
    : `${at.file} (lines the checker adds: a craft-inline import or the sandbox wrapper): ${m[4]}`
}
