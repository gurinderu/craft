// Cyclomatic and cognitive complexity and lint problems for the quality delta (realm @nick/craft, #147):
// one ESLint run through the checkout's own ESLint and config, the measuring rules overridden to 0.
// Complexity is summed over source only — test files (*.test.*) are scaffolding, not code under review —
// while lint problems count every linted file, as the gate does. The engines (workflows/*.js), outside
// lint's scope, are added to the complexity through lib/quality-engines.mjs and also reported alone.
import path from 'node:path'
import { errText, failed, lintScope, notMeasured, ok, scriptsOf } from './quality-result.mjs'
import { engineResults } from './quality-engines.mjs'
import { thresholdProblems } from './quality-thresholds.mjs'

/** @typedef {import('./quality-result.mjs').LintResult} LintResult */
/** @typedef {import('./quality-result.mjs').Deps} Deps */
/** @template T @typedef {import('./quality-result.mjs').Result<T>} Result */
/** @typedef {{ key: string, name: string, file: string, line: number, value: number }} FnEntry */
/** @typedef {{ total: number, functions: FnEntry[] }} Complexity */
/**
 * @typedef {{ complexity: Result<Complexity>, cognitive: Result<Complexity>, lint: Result<number>,
 *   engines: Result<Complexity> }} EslintMeasure  `engines`: the engines' cyclomatic share, included in `complexity`
 */

const COMPLEXITY = 'complexity'
const COGNITIVE = 'sonarjs/cognitive-complexity'
/** Each measuring rule's value in its message. */
const VALUE = { [COMPLEXITY]: /complexity of (\d+)/, [COGNITIVE]: /Complexity from (\d+)/ }

/** A test file by name: left out of the complexity sums and risers. @param {string} file */
export const isTestFile = file => /\.test\.[cm]?[jt]s$/.test(file)

/**
 * Per-function values from one rule's messages at threshold 0. `complexity` names the function in its
 * message ("Function 'x' has a complexity of 3."); the cognitive rule does not, so its entries borrow the
 * name of the complexity entry reported on the same line. Keys are file + name + ordinal among same-named
 * functions in that file (line numbers move with every edit above a function; names mostly do not).
 * Test files are skipped.
 * @param {LintResult[]} results @param {string} cwd @param {string} ruleId @param {RegExp} valueRe
 * @param {Map<string, string>} [namesByLine] file:line → name, filled from the complexity pass
 * @returns {Complexity}
 */
export function functionsFromMessages(results, cwd, ruleId, valueRe, namesByLine) {
  /** @type {FnEntry[]} */
  const functions = []
  let total = 0
  for (const r of results) {
    const file = path.relative(cwd, r.filePath).split(path.sep).join('/')
    if (isTestFile(file)) continue
    /** @type {Map<string, number>} */
    const seen = new Map()
    for (const m of r.messages) {
      if (m.ruleId !== ruleId) continue
      const v = valueRe.exec(m.message)
      if (!v) continue
      const value = Number(v[1])
      const name = ruleId === COMPLEXITY
        ? m.message.slice(0, m.message.indexOf(' has a complexity')).trim()
        : namesByLine?.get(`${file}:${m.line}`) ?? `function at line ${m.line}`
      namesByLine?.set(`${file}:${m.line}`, name)
      const n = (seen.get(name) ?? 0) + 1
      seen.set(name, n)
      functions.push({ key: `${file} ${name} #${n}`, name, file, line: m.line, value })
      total += value
    }
  }
  return { total, functions }
}

/**
 * Lint problems but the two measuring rules (parse errors included); the gate's own threshold violations
 * of those rules are added from the measured values (lib/quality-thresholds.mjs).
 * @param {LintResult[]} results
 */
export function lintProblems(results) {
  let n = 0
  for (const r of results) for (const m of r.messages) if (m.ruleId !== COMPLEXITY && m.ruleId !== COGNITIVE) n++
  return n
}

/**
 * Complexity, cognitive complexity and lint problems from ONE ESLint run with the checkout's own config,
 * `complexity` (and the cognitive rule, when the plugin is installed) overridden to threshold 0.
 * @param {string} dir @param {Deps} deps
 * @returns {Promise<EslintMeasure>}
 */
export async function measureEslint(dir, deps) {
  /** @param {string} reason */
  const allFailed = reason => ({ complexity: failed(reason), cognitive: failed(reason), lint: failed(reason), engines: failed(reason) })
  let scope
  try { scope = lintScope(scriptsOf(dir)['lint']) } catch (e) { return allFailed(errText(e)) }
  let ESLint
  try { ESLint = await deps.loadEslint(dir) } catch (e) { return allFailed(`eslint failed to load: ${errText(e)}`) }
  if (!ESLint) return allFailed('eslint is not installed in the checkout (run npm ci)')
  /** @type {unknown} */
  let sonar = null
  let sonarError = ''
  try { sonar = await deps.loadSonar(dir) } catch (e) { sonarError = errText(e) }
  /** @type {Record<string, unknown>} */
  const rules = { [COMPLEXITY]: ['warn', 0] }
  if (sonar) rules[COGNITIVE] = ['warn', 0]
  // The plugin is registered here unless the checkout's config already registers it (ESLint refuses a
  // second, different object under the same name): then the rule alone is turned on.
  const attempts = sonar ? [{ plugins: { sonarjs: sonar }, rules }, { rules }] : [{ rules }]
  /** @type {LintResult[] | null} */
  let results = null
  let lastError = ''
  for (const override of attempts) {
    try {
      results = await new ESLint({ cwd: dir, overrideConfig: [override] }).lintFiles(scope)
      break
    } catch (e) {
      lastError = errText(e)
      if (!/redefine plugin/i.test(lastError)) break
    }
  }
  if (!results) return allFailed(`eslint failed: ${lastError}`)
  const overThreshold = await thresholdProblems(ESLint, dir, results, VALUE)
  const engines = await engineResults(dir, ESLint, /** @type {Record<string, unknown>} */ (attempts[0]), deps)
  const measured = [...results, ...(engines.status === 'ok' ? engines.value : [])]
  /** @type {Map<string, string>} */
  const names = new Map()
  return {
    complexity: ok(functionsFromMessages(measured, dir, COMPLEXITY, VALUE[COMPLEXITY], names)),
    engines: engines.status === 'ok' ? ok(functionsFromMessages(engines.value, dir, COMPLEXITY, VALUE[COMPLEXITY])) : engines,
    cognitive: sonar
      ? ok(functionsFromMessages(measured, dir, COGNITIVE, VALUE[COGNITIVE], names))
      : sonarError ? failed(`eslint-plugin-sonarjs failed to load: ${sonarError}`) : notMeasured('eslint-plugin-sonarjs not installed'),
    lint: overThreshold.status === 'ok' ? ok(lintProblems(results) + overThreshold.value) : overThreshold,
  }
}
