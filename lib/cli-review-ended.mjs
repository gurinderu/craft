// How a run ended as the binary's `craft review status` says it (cli/crates/craft-review/src/status.rs, `filing`), for
// the cli-review driver when it could not read the step that ended it (lib/cli-review-steps.mjs, recovered): the step
// the run's segment ended with, as the binary filed it, and whether its record is to be filed again.
import { commandOutput, finishedStep, isObject } from './cli-review-step.mjs'

/** @typedef {import('./cli-review-step.mjs').Finished} Finished */

/** The status JSON a service step printed, null when none. @param {unknown} got @returns {Record<string, unknown> | null} */
function statusOf(got) {
  const out = commandOutput(got)
  if ('error' in out) return null
  try {
    const v = JSON.parse(out.stdout)
    return isObject(v) ? v : null
  } catch {
    return null
  }
}

/**
 * The step the run's segment ended with, null when the binary says it has not ended (or said nothing readable).
 * `refile`: a finished run whose record did not land — a resume files it again; a stopped run's is filed by the
 * resume that goes on with it, so it ends as it stands.
 * @param {unknown} got @returns {{ finished: Finished, refile: boolean } | null}
 */
export function endedOf(got) {
  const status = statusOf(got)
  const filing = status?.['filing']
  if (!isObject(filing) || !isObject(filing['finished'])) return null
  const read = finishedStep(filing['finished'])
  if ('error' in read) return null
  return { finished: read.step, refile: status?.['done'] === true && filing['record'] !== 'filed' }
}
