// Cyclomatic and cognitive complexity and lint problems for the quality delta (realm @nick/craft, #147):
// one ESLint run through the checkout's own ESLint and config, the measuring rules overridden to 0.
// The per-function tallies are lib/quality-tally.mjs's; lint problems count every linted file, as the gate
// does. The engines (src/*.js), outside lint's scope, are linted through lib/quality-engines.mjs.
import { errText, failed, lintScope, notMeasured, ok, scriptsOf } from './quality-result.mjs'
import { engineResults } from './quality-engines.mjs'
import { BARS, gateThresholds } from './quality-thresholds.mjs'
import { COGNITIVE, COMPLEXITY, VALUE, functionsFromMessages, tallies } from './quality-tally.mjs'

/** @typedef {import('./quality-result.mjs').LintResult} LintResult */
/** @typedef {import('./quality-result.mjs').EslintCtor} EslintCtor */
/** @typedef {import('./quality-result.mjs').Deps} Deps */
/** @template T @typedef {import('./quality-result.mjs').Result<T>} Result */
/** @typedef {import('./quality-tally.mjs').Tally} Tally */
/** @typedef {import('./quality-tally.mjs').Complexity} Complexity */
/**
 * @typedef {{ complexity: Result<Complexity>, cognitive: Result<Complexity>, lint: Result<number>,
 *   engines: Result<Tally> }} EslintMeasure  `engines`: the engines' cyclomatic share, included in `complexity`
 */

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

/** @param {Complexity | null} measured @param {string} sonarError @returns {Result<Complexity>} */
function cognitiveResult(measured, sonarError) {
  if (measured) return ok(measured)
  return sonarError ? failed(`eslint-plugin-sonarjs failed to load: ${sonarError}`) : notMeasured('eslint-plugin-sonarjs not installed')
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
  const gate = await gateThresholds(ESLint, dir, results, VALUE)
  const engines = await engineResults(dir, ESLint, /** @type {Record<string, unknown>} */ (attempts[0]), deps)
  const measured = engines.status === 'ok' ? [...results, ...engines.value] : results
  const t = tallies({ dir, measured, engines, bars: gate.status === 'ok' ? gate.value.bars : BARS }, Boolean(sonar))
  return {
    complexity: ok(t.complexity),
    engines: engines.status === 'ok' ? ok(functionsFromMessages(engines.value, dir, COMPLEXITY, /** @type {RegExp} */ (VALUE[COMPLEXITY]))) : engines,
    cognitive: cognitiveResult(t.cognitive, sonarError),
    lint: gate.status === 'ok' ? ok(lintProblems(results) + gate.value.over) : gate,
  }
}
