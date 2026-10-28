// The harm levels a review finding names, in the order skills/review-rules/severity.md caps them
// (realm @nick/craft, node #379). The lens picks the first row its finding honestly fills; the
// schema's `harmLevel` enum and the deletion/recovery path floor both read this list.

/** Every level, worst first. */
export const HARM_LEVELS = ['data-loss', 'security', 'outage', 'irreversible', 'operator-recovery', 'self-healing', 'text', 'none']

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
