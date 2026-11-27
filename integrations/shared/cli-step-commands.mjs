// The command lines every kind of run of the CLI's step protocol shares (realm @nick/craft, node #453), as shell text:
// `craft <kind> submit` and `craft <kind> status`, the kind's own start aside (integrations/shared/cli-review-commands.mjs
// for the review). Each flag only when it differs from the binary's default.
import { shq } from './plugin-script.mjs'

/** @typedef {{ degraded?: string[], limit?: string, resume?: boolean, abandoned?: string[] }} Said  what a submit tells the binary of the step's tasks */

/**
 * The submit and status commands of the run kind `kind`: `submit` with a `--degraded` note for each way the
 * step's tasks ran weaker than asked, an `--abandoned` for each task abandoned at its deadline, the usage limit's text
 * when a task ran into it (`--limit`), and `--resume` when it resumes a run. Review-specific telemetry is added by
 * cli-review-commands.mjs, never sent to triage (realm @nick/craft, node #616). `status` says where the run stands,
 * and `briefStatus` where it stands in fields no finding count grows (#522).
 * @param {string} kind
 */
export function stepCommands(kind) {
  /** @param {string} bin @param {string} run @returns {string} */
  const status = (bin, run) => `${bin} ${kind} status --run ${shq(run)}`
  return {
    /** @param {string} bin @param {string} run @param {Said} said @returns {string} */
    submit: (bin, run, { degraded = [], limit = '', resume = false, abandoned = [] }) =>
      `${bin} ${kind} submit --run ${shq(run)}${degraded.map(n => ` --degraded ${shq(n)}`).join('')}${abandoned.map(id => ` --abandoned ${shq(id)}`).join('')}${limit ? ` --limit ${shq(limit)}` : ''}${resume ? ' --resume' : ''}`,
    status,
    /** @param {string} bin @param {string} run @returns {string} */
    briefStatus: (bin, run) => `${status(bin, run)} --brief`,
  }
}
