// The harm levels a review finding names, one per row of skills/review-rules/severity.md and in its
// order (realm @nick/craft, node #379). The lens picks the first row its finding honestly fills; the
// schema's `harmLevel` enum, the deletion/recovery path floor and the harm cap all read this list.

/** Every level, worst first: the `harmLevel` column of severity.md's table, top down. */
export const HARM_LEVELS = ['data-loss', 'security', 'outage', 'irreversible', 'intent-unmet', 'repo-rule', 'operator-recovery', 'self-healing', 'text', 'none']

/**
 * The highest severity each level allows: severity.md's "Highest allowed" column, must-fix as
 * Critical, should-fix as Medium, optional as Low.
 * @type {Readonly<Record<string, 'Critical' | 'Medium' | 'Low'>>}
 */
export const HARM_CEILING = Object.freeze({
  'data-loss': 'Critical',
  security: 'Critical',
  outage: 'Critical',
  irreversible: 'Critical',
  // The change does not achieve its stated purpose, and a written rule of the consumer's own
  // repository broken: both must-fix by the owner's decision (realm @nick/craft, node #379).
  'intent-unmet': 'Critical',
  'repo-rule': 'Critical',
  'operator-recovery': 'Medium',
  'self-healing': 'Low',
  text: 'Low',
  none: 'Low',
})

/** The levels at or above operator recovery: the ones a severity floor may honour. */
const OPERATOR_RECOVERY_OR_WORSE = HARM_LEVELS.slice(0, HARM_LEVELS.indexOf('operator-recovery') + 1)

/**
 * Whether a finding's named harm is operator recovery or worse. An absent or unknown level is not:
 * a floor does not invent a harm the finding did not name.
 * @param {unknown} level
 * @returns {boolean}
 */
export function harmAtLeastOperatorRecovery(level) {
  return typeof level === 'string' && OPERATOR_RECOVERY_OR_WORSE.includes(level)
}
