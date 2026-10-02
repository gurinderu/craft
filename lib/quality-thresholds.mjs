// Lint problems at the gate's settings for the two measuring rules (realm @nick/craft, #147). The measure
// overrides `complexity` and `sonarjs/cognitive-complexity` to threshold 0, which hides what the gate
// itself reports for them; so the checkout's own config is read per file (ESLint's resolved config, no
// override) and every measured value over its threshold counts as the lint problem the gate would raise.
import { errText, failed, ok } from './quality-result.mjs'

/** @typedef {import('./quality-result.mjs').LintResult} LintResult */
/** @typedef {import('./quality-result.mjs').EslintCtor} EslintCtor */
/** @template T @typedef {import('./quality-result.mjs').Result<T>} Result */

/** Each rule's threshold when it is on without one: ESLint's for `complexity`, sonarjs's for its rule. */
const DEFAULTS = { complexity: 20, 'sonarjs/cognitive-complexity': 15 }

/**
 * The threshold a resolved rule entry enforces; null when the rule is off or absent.
 * @param {unknown} entry `2`, `'error'`, `[2, 10]`, `['warn', { max: 10 }]`… @param {number} fallback
 * @returns {number | null}
 */
export function ruleThreshold(entry, fallback) {
  const [severity, option] = Array.isArray(entry) ? /** @type {unknown[]} */ (entry) : [entry]
  if (severity === undefined || severity === 0 || severity === 'off') return null
  if (typeof option === 'number') return option
  if (option && typeof option === 'object') {
    const o = /** @type {Record<string, unknown>} */ (option)
    const v = o['max'] ?? o['maximum']
    if (typeof v === 'number') return v
  }
  return fallback
}

/**
 * Measured values over the threshold each file's own config sets, counted.
 * @param {EslintCtor} ESLint @param {string} dir @param {LintResult[]} results
 * @param {Record<string, RegExp>} valueOf each measuring rule → its value in the message
 * @returns {Promise<Result<number>>}
 */
export async function thresholdProblems(ESLint, dir, results, valueOf) {
  try {
    const plain = new ESLint({ cwd: dir })
    let n = 0
    for (const r of results) {
      const config = await plain.calculateConfigForFile(r.filePath)
      const rules = config && typeof config === 'object' ? /** @type {Record<string, unknown>} */ (config)['rules'] : null
      if (!rules || typeof rules !== 'object') continue
      for (const [rule, fallback] of Object.entries(DEFAULTS)) {
        const max = ruleThreshold(/** @type {Record<string, unknown>} */ (rules)[rule], fallback)
        const re = valueOf[rule]
        if (max == null || !re) continue
        for (const m of r.messages) if (m.ruleId === rule && Number(re.exec(m.message)?.[1]) > max) n++
      }
    }
    return ok(n)
  } catch (e) {
    return failed(`could not read the gate's complexity thresholds: ${errText(e)}`)
  }
}
