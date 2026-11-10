// How a run ended as the binary's `craft review status` says it (cli/crates/craft-review/src/status.rs, `filing`), for
// the review driver when it could not read the step that ended it (lib/cli-review-steps.mjs, recovered): the step
// the run's segment ended with, as the binary filed it, and whether its record is to be filed again.
import { commandOutput, finishedStep, isObject } from './cli-review-step.mjs'
import { hasControl } from './cli-review-keys.mjs'

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
 * resume that goes on with it, so it ends as it stands. `unrecorded`: a run the binary finished but whose finished
 * step it never kept — cut between its end and its record — so nothing is left to file its record from.
 * @param {unknown} got @returns {{ finished: Finished, refile: boolean } | { unrecorded: string } | null}
 */
export function endedOf(got) {
  const status = statusOf(got)
  const filing = status?.['filing']
  if (!isObject(filing)) return null
  if (!isObject(filing['finished'])) return status?.['done'] === true ? { unrecorded: unrecordedWhy(status) } : null
  const read = finishedStep(filing['finished'])
  if ('error' in read) return null
  return { finished: read.step, refile: status?.['done'] === true && filing['record'] !== 'filed' }
}

/** Why a finished run has no record, naming its verdict and report. @param {Record<string, unknown> | null} status */
const unrecordedWhy = status => `the craft binary finished the run (${String(status?.['verdict'] ?? 'no verdict')}; its report is ${String(status?.['report'] ?? 'not named')}) but kept no finished step to file its record from, so the run store has no record of it`

/**
 * Where an unfinished run stands as the binary says it — `round N, phase P`, each only when the status names it — for
 * a stop that claims no round or phase the binary does not report (realm @nick/craft, node #485); '' when it says none.
 * @param {unknown} got @returns {string}
 */
export function standingOf(got) {
  const status = statusOf(got)
  const atRound = status?.['round']
  const inPhase = status?.['phase']
  const said = [
    Number.isInteger(atRound) && Number(atRound) > 0 ? `round ${String(atRound)}` : '',
    typeof inPhase === 'string' && inPhase && inPhase.length <= 60 && !hasControl(inPhase) ? `phase ${inPhase}` : '',
  ]
  return said.filter(Boolean).join(', ')
}
