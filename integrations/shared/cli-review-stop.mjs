// Why the Claude Code driver stopped a run the binary had not finished, as the run record says it (realm @nick/craft,
// node #638): `notRun` is tallied by exact line, so a cause is one of a few fixed lines, not the stop's own text, which
// names paths. The same lines the binary's own driver files (content/parity/stop-causes.json,
// cli/crates/craft-review/src/filing/unfinished.rs).
import { commandOutput } from './cli-review-step.mjs'

/** A failed recovery says nothing about the binary's completion (realm @nick/craft, nodes #667, #731). */
export const UNKNOWN_COMPLETION = 'No additional run record was filed by this driver: whether the binary finished the run is unknown.'

/**
 * A status command's own refusal or failed exit, with the issued command preserved. An unread answer or the usage
 * limit keeps the lost-step path; a failed page is handled by the caller's brief fallback first.
 * @param {unknown} got @param {string} command @returns {{ error: string, harness?: string } | null}
 */
export function recoveryFailure(got, command) {
  const read = commandOutput(got)
  if (!('error' in read)) return null
  if (read.harness !== undefined) return read
  return read.error.startsWith('the command exited ') ? { error: `\`${command}\`: ${read.error}` } : null
}

/** The first `notRun` line of such a run. */
export const UNFINISHED = 'the craft binary did not finish the run'

/** @typedef {'start' | 'limit' | 'harness' | 'step' | 'rounds'} StopCause */

/** @type {Record<StopCause, string>} */
export const STOP_CAUSES = {
  start: 'stopped: the run could not start or resume',
  limit: 'stopped: the usage limit was reached',
  harness: 'stopped: the harness refused a service command',
  step: 'stopped: a step of the binary was lost',
  rounds: "stopped: the driver's round backstop was reached",
}

/** The words a step carries when the binary held the run on the usage limit (integrations/shared/cli-review-step.mjs). */
const LIMIT = 'stopped: usage limit reached'

/**
 * The failed read after recovery found no binary ending (realm @nick/craft, node #731).
 * @param {{ error: string, harness?: string }} read @param {string} limit  the limit the driver saw, '' when none
 * @returns {{ error: string, harness?: string }}
 */
export const stopRead = (read, limit) => (limit && read.harness === undefined ? { error: `${LIMIT} (${limit})` } : read)

/**
 * The cause of a stop on a read that failed: the harness's refusal, the usage limit, or else `otherwise`.
 * @param {{ error: string, harness?: string }} read @param {StopCause} otherwise @returns {StopCause}
 */
export function stopCause(read, otherwise) {
  if (read.harness !== undefined) return 'harness'
  return read.error.startsWith(LIMIT) ? 'limit' : otherwise
}

/** The `notRun` lines of a run stopped for `cause`. @param {StopCause} cause @returns {string[]} */
export const stopNotRun = cause => [UNFINISHED, STOP_CAUSES[cause]]
