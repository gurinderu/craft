// Per-function complexity tallies for the quality delta (realm @nick/craft, #147): what one measuring rule
// reported, function by function, summed over source only — test files (*.test.*) are scaffolding, not code
// under review — and the totals over lint's scope plus the engines, marked partial when a part is missing.
import path from 'node:path'

/** @typedef {import('./quality-result.mjs').LintResult} LintResult */
/** @typedef {import('./quality-result.mjs').LintMessage} LintMessage */
/** @template T @typedef {import('./quality-result.mjs').Result<T>} Result */
/** @typedef {{ key: string, name: string, file: string, line: number, value: number }} FnEntry */
/** @typedef {{ total: number, functions: FnEntry[] }} Tally */
/** A part of the source that could not be measured, so the total lacks it. @typedef {{ part: string, reason: string, prefix: string }} Gap */
/**
 * A total with the bar a new function is held to (the checkout's own threshold) and, when a part is
 * missing, which one: such a total is partial, not comparable.
 * @typedef {Tally & { bar: number, partial?: Gap }} Complexity
 */

export const COMPLEXITY = 'complexity'
export const COGNITIVE = 'sonarjs/cognitive-complexity'
/** Each measuring rule's value in its message. */
/** @type {Record<string, RegExp>} */
export const VALUE = { [COMPLEXITY]: /complexity of (\d+)/, [COGNITIVE]: /Complexity from (\d+)/ }

/** A test file by name: left out of the complexity sums and risers. @param {string} file */
export const isTestFile = file => /\.test\.[cm]?[jt]s$/.test(file)

/**
 * The function a message is about: `complexity` names it ("Function 'x' has a complexity of 3."); the
 * cognitive rule does not, so it borrows the name the complexity rule gave the same line.
 * @param {LintMessage} m @param {string} ruleId @param {string} at file:line @param {Map<string, string> | undefined} namesByLine
 */
function functionName(m, ruleId, at, namesByLine) {
  if (ruleId === COMPLEXITY) return m.message.slice(0, m.message.indexOf(' has a complexity')).trim()
  return namesByLine?.get(at) ?? `function at line ${m.line}`
}

/**
 * Per-function values from one rule's messages at threshold 0, test files skipped. Keys are file + name +
 * ordinal among same-named functions in that file (line numbers move with every edit above a function;
 * names mostly do not).
 * @param {LintResult[]} results @param {string} cwd @param {string} ruleId @param {RegExp} valueRe
 * @param {Map<string, string>} [namesByLine] file:line → name, filled from the complexity pass
 * @returns {Tally}
 */
export function functionsFromMessages(results, cwd, ruleId, valueRe, namesByLine) {
  /** @type {FnEntry[]} */
  const functions = []
  for (const r of results) {
    const file = path.relative(cwd, r.filePath).split(path.sep).join('/')
    if (isTestFile(file)) continue
    /** @type {Map<string, number>} */
    const seen = new Map()
    for (const m of r.messages) {
      const v = m.ruleId === ruleId ? valueRe.exec(m.message) : null
      if (!v) continue
      const name = functionName(m, ruleId, `${file}:${m.line}`, namesByLine)
      namesByLine?.set(`${file}:${m.line}`, name)
      const n = (seen.get(name) ?? 0) + 1
      seen.set(name, n)
      functions.push({ key: `${file} ${name} #${n}`, name, file, line: m.line, value: Number(v[1]) })
    }
  }
  return { total: functions.reduce((s, f) => s + f.value, 0), functions }
}

/**
 * The two complexity totals over lint's scope plus the engines; when the engines were not measured the
 * totals say so (`partial`) instead of passing for whole ones.
 * @param {{ dir: string, measured: LintResult[], engines: Result<LintResult[]>, bars: Record<string, number> }} at
 * @param {boolean} cognitive whether the cognitive rule ran
 * @returns {{ complexity: Complexity, cognitive: Complexity | null }}
 */
export function tallies({ dir, measured, engines, bars }, cognitive) {
  /** @type {Map<string, string>} */
  const names = new Map()
  const gap = engines.status === 'ok' ? null : { part: 'engines (workflows/*.js)', reason: engines.reason, prefix: 'workflows/' }
  /** @param {string} rule @returns {Complexity} */
  const tally = rule => {
    const t = { ...functionsFromMessages(measured, dir, rule, /** @type {RegExp} */ (VALUE[rule]), names), bar: bars[rule] ?? 0 }
    return gap ? { ...t, partial: gap } : t
  }
  return { complexity: tally(COMPLEXITY), cognitive: cognitive ? tally(COGNITIVE) : null }
}
