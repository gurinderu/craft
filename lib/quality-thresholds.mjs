// Lint problems at the gate's settings for the two measuring rules (realm @nick/craft, #147). The measure
// overrides `complexity` and `sonarjs/cognitive-complexity` to threshold 0, which hides what the gate
// itself reports for them; so the checkout's own config is read per file (ESLint's resolved config, no
// override) and every measured value over its threshold counts as the lint problem the gate would raise.
// The same thresholds give the bar a new function is held to among the risers.
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

/** The `rules` of a resolved config, or an empty record. @param {unknown} config @returns {Record<string, unknown>} */
function rulesOf(config) {
  const rules = config && typeof config === 'object' ? /** @type {Record<string, unknown>} */ (config)['rules'] : null
  return rules && typeof rules === 'object' ? /** @type {Record<string, unknown>} */ (rules) : {}
}

/** The bar a new function is held to when no linted file's config sets the rule: #155's bars. */
export const BARS = { complexity: 10, 'sonarjs/cognitive-complexity': 15 }

/**
 * One file's measured values over the thresholds its config sets, and those thresholds.
 * @param {LintResult} r @param {Record<string, unknown>} rules @param {Record<string, RegExp>} valueOf
 * @returns {{ over: number, thresholds: Record<string, number | null> }}
 */
function overInFile(r, rules, valueOf) {
  let over = 0
  /** @type {Record<string, number | null>} */
  const thresholds = {}
  for (const [rule, fallback] of Object.entries(DEFAULTS)) {
    const max = ruleThreshold(rules[rule], fallback)
    thresholds[rule] = max
    const re = valueOf[rule]
    if (max == null || !re) continue
    over += r.messages.filter(m => m.ruleId === rule && Number(re.exec(m.message)?.[1]) > max).length
  }
  return { over, thresholds }
}

/**
 * Measured values over the threshold each file's own config sets, counted; and per rule the bar a new
 * function is held to — the lowest threshold any linted file's config sets, else #155's bar.
 * @param {EslintCtor} ESLint @param {string} dir @param {LintResult[]} results
 * @param {Record<string, RegExp>} valueOf each measuring rule → its value in the message
 * @returns {Promise<Result<{ over: number, bars: Record<string, number> }>>}
 */
export async function gateThresholds(ESLint, dir, results, valueOf) {
  try {
    const plain = new ESLint({ cwd: dir })
    let over = 0
    /** @type {Record<string, number>} */
    const bars = {}
    for (const r of results) {
      const f = overInFile(r, rulesOf(await plain.calculateConfigForFile(r.filePath)), valueOf)
      over += f.over
      for (const [rule, t] of Object.entries(f.thresholds)) if (t != null) bars[rule] = Math.min(bars[rule] ?? t, t)
    }
    return ok({ over, bars: { ...BARS, ...bars } })
  } catch (e) {
    return failed(`could not read the gate's complexity thresholds: ${errText(e)}`)
  }
}
