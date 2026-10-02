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
/** @typedef {import('./quality-result.mjs').LintMessage} LintMessage */
/** @typedef {import('./quality-result.mjs').EslintCtor} EslintCtor */
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
 * @returns {Complexity}
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
 * Lint's scope, the checkout's ESLint and, when it loads, the sonarjs plugin; a string says why not.
 * @param {string} dir @param {Deps} deps
 * @returns {Promise<string | { scope: string[], ESLint: EslintCtor, sonar: unknown, sonarError: string }>}
 */
async function loadTools(dir, deps) {
  let scope, ESLint
  try { scope = lintScope(scriptsOf(dir)['lint']) } catch (e) { return errText(e) }
  try { ESLint = await deps.loadEslint(dir) } catch (e) { return `eslint failed to load: ${errText(e)}` }
  if (!ESLint) return 'eslint is not installed in the checkout (run npm ci)'
  try { return { scope, ESLint, sonar: await deps.loadSonar(dir), sonarError: '' } } catch (e) {
    return { scope, ESLint, sonar: null, sonarError: errText(e) }
  }
}

/**
 * Lints the scope with each override in turn until one is accepted: the plugin is registered unless the
 * checkout's config already registers it (ESLint refuses a second, different object under the same name).
 * @param {EslintCtor} ESLint @param {string} dir @param {string[]} scope @param {Record<string, unknown>[]} attempts
 * @returns {Promise<LintResult[] | string>} the results, or the last error
 */
async function lintWithOverride(ESLint, dir, scope, attempts) {
  let lastError = 'no override to try'
  for (const override of attempts) {
    try { return await new ESLint({ cwd: dir, overrideConfig: [override] }).lintFiles(scope) } catch (e) {
      lastError = errText(e)
      if (!/redefine plugin/i.test(lastError)) break
    }
  }
  return `eslint failed: ${lastError}`
}

/**
 * Complexity, cognitive complexity and lint problems from ONE ESLint run with the checkout's own config,
 * `complexity` (and the cognitive rule, when the plugin is installed) overridden to threshold 0.
 * @param {string} dir @param {Deps} deps
 * @returns {Promise<EslintMeasure>}
 */
export async function measureEslint(dir, deps) {
  const tools = await loadTools(dir, deps)
  if (typeof tools === 'string') return { complexity: failed(tools), cognitive: failed(tools), lint: failed(tools), engines: failed(tools) }
  const { scope, ESLint, sonar, sonarError } = tools
  /** @type {Record<string, unknown>} */
  const rules = sonar ? { [COMPLEXITY]: ['warn', 0], [COGNITIVE]: ['warn', 0] } : { [COMPLEXITY]: ['warn', 0] }
  const attempts = sonar ? [{ plugins: { sonarjs: sonar }, rules }, { rules }] : [{ rules }]
  const results = await lintWithOverride(ESLint, dir, scope, attempts)
  if (typeof results === 'string') return { complexity: failed(results), cognitive: failed(results), lint: failed(results), engines: failed(results) }
  const overThreshold = await thresholdProblems(ESLint, dir, results, VALUE)
  const engines = await engineResults(dir, ESLint, /** @type {Record<string, unknown>} */ (attempts[0]), deps)
  const measured = engines.status === 'ok' ? [...results, ...engines.value] : results
  /** @type {Map<string, string>} */
  const names = new Map()
  const complexity = ok(functionsFromMessages(measured, dir, COMPLEXITY, VALUE[COMPLEXITY], names))
  /** @type {Result<Complexity>} */
  const cognitive = sonar ? ok(functionsFromMessages(measured, dir, COGNITIVE, VALUE[COGNITIVE], names))
    : sonarError ? failed(`eslint-plugin-sonarjs failed to load: ${sonarError}`) : notMeasured('eslint-plugin-sonarjs not installed')
  return {
    complexity,
    engines: engines.status === 'ok' ? ok(functionsFromMessages(engines.value, dir, COMPLEXITY, VALUE[COMPLEXITY])) : engines,
    cognitive,
    lint: overThreshold.status === 'ok' ? ok(lintProblems(results) + overThreshold.value) : overThreshold,
  }
}
