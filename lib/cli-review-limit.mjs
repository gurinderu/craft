// The account's usage limit as the cli-review driver sees it (lib/cli-review-steps.mjs; realm @nick/craft, nodes
// #299, #300): the binary sees a dead agent only as a missing answer file and stops on a round that died whole, but
// the limit's own text — an agent's thrown error, or an answer short enough to be one — reaches only this driver. Read
// with lib/usage-limit.mjs's patterns, so a transient 429 is not one; once seen, no further task agent is dispatched,
// and the driver hands the text to the binary on its submit (`--limit`), which keeps the answers that came in and
// ends the run INCOMPLETE with how to resume it.
import { LIMIT_ANSWER_MAX, errorText, usageLimitText } from './usage-limit.mjs'

/** @typedef {(prompt: string, opts?: Record<string, unknown>) => Promise<unknown>} Agent */

/**
 * One run's watch: `seen` the limit's text ('' until one), `tasks` an agent callback for the step's tasks that
 * dispatches nothing once a limit is seen, `service` one for the service steps that is only observed — the submit
 * that reports the limit must still run.
 * @returns {{ seen: () => string, tasks: (call: Agent) => Agent, service: (call: Agent) => Agent }}
 */
export function limitWatch() {
  let seen = ''
  /** @param {string} text @returns {boolean} */
  const see = text => {
    if (text && !seen) seen = text
    return !!text
  }
  /** A limit failure of the call is answered null, as a dead agent; any other throw stands. @param {Agent} call @returns {Agent} */
  const observe = call => async (prompt, opts) => {
    try {
      const got = await call(prompt, opts)
      return typeof got === 'string' && got.length <= LIMIT_ANSWER_MAX && see(usageLimitText(got)) ? null : got
    } catch (e) {
      if (see(usageLimitText(errorText(e)))) return null
      throw e
    }
  }
  return {
    seen: () => seen,
    tasks: call => {
      const watched = observe(call)
      return async (prompt, opts) => (seen ? null : watched(prompt, opts))
    },
    service: observe,
  }
}
