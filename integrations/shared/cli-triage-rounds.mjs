// The triage's rounds on the CLI's step protocol (integrations/shared/cli-triage-steps.mjs; realm @nick/craft, node #616): the
// service step that runs one binary command, a step's tasks dispatched, their answers submitted with what the host saw
// of them, and a lost step recovered by the binary's status before anything is filed.
import { MAX_ROUNDS, triageStatus, triageSubmit } from './cli-triage-commands.mjs'
import { readTriageStatus, readTriageStep } from './cli-triage-step.mjs'
import { triageResumeHint } from './cli-triage-answer.mjs'
import { servicePrompt } from './cli-step-service.mjs'
import { dispatchTasks } from './cli-step-loop.mjs'
import { harnessRefused } from './cli-review-refusal.mjs'
import { stopCause, stopRead } from './cli-review-stop.mjs'

/** @typedef {import('./cli-step-service.mjs').Serve} Serve @typedef {import('./cli-review-steps.mjs').Sandbox} Sandbox */
/** @typedef {import('./cli-triage-step.mjs').TriagePending} TriagePending @typedef {import('./cli-triage-step.mjs').TriageFinished} TriageFinished */
/** @typedef {import('./cli-triage-steps.mjs').Ending} Ending */
/** @typedef {import('./cli-review-task.mjs').taskRunner} TaskRunner */

// A start reads the report and asks gh for the PR's threads; a submit may file the record, waiting at most 45 s on the
// store's index lock (cli/crates/craft-store/src/lock.rs): past a Bash call's default two minutes, so five with headroom.
export const START_TIMEOUT = "in one Bash call with a timeout of 300000 ms (it may read the PR's review threads through gh)"
export const SUBMIT_TIMEOUT = "in one Bash call with a timeout of 300000 ms (it may file the run's record)"

/** A service step that runs `cmd`. @param {Serve} serve @param {string} label @param {string} title @param {string} cmd @param {string} timeout */
export const runCommand = (serve, label, title, cmd, timeout) => serve(label, title, servicePrompt(`Run exactly this one command, ${timeout}:\n\n${cmd}`), cmd)

/** Why a read failed, the harness's refusal said as one. @param {{ error: string, harness?: string }} read */
export const failureOf = read => (read.harness === undefined ? read.error : harnessRefused(read.harness, null, 'a `craft triage` command'))

/**
 * The triage's part of the step rounds: its tasks dispatched, their answers submitted with what the host saw of them,
 * a lost step recovered by the binary's status.
 * @param {Sandbox} sb @param {Serve} serve @param {string} bin @param {string} runDir
 * @param {{ tasks: ReturnType<TaskRunner>, limit: { seen: () => string } }} with_
 * @returns {import('./cli-step-loop.mjs').Rounds<TriagePending, TriageFinished, Ending>}
 */
export function roundsOf(sb, serve, bin, runDir, { tasks, limit }) {
  return {
    maxRounds: MAX_ROUNDS,
    dispatch: (step, round) => dispatchTasks(sb, tasks, step, round, step.phase || 'triage'),
    submit: async (step, round) => {
      sb.phase('Submit')
      const said = { degraded: tasks.degraded(round), abandoned: tasks.abandoned(), limit: limit.seen() }
      return readTriageStep(await runCommand(serve, `step:submit:${round}`, 'Submit', triageSubmit(bin, step.run, said), SUBMIT_TIMEOUT))
    },
    heard: () => {},
    lost: async lostRead => recovered(serve, bin, runDir, lostRead, limit),
    gaveUp: step => ({ stopped: `triage gave up after ${MAX_ROUNDS} rounds; the run is in ${step.run}. ${triageResumeHint(step.run)}`, cause: 'rounds' }),
    finished: step => ({ finished: step }),
  }
}

/**
 * A submit whose output could not be read may still have ended the run: the binary's status is asked before anything
 * is filed. A run it ended ends as it says; one it did not, stops where it stands, to be resumed.
 * @param {Serve} serve @param {string} bin @param {string} runDir @param {{ error: string, harness?: string }} lostRead
 * @param {{ seen: () => string }} limit
 * @returns {Promise<Ending>}
 */
export async function recovered(serve, bin, runDir, lostRead, limit) {
  const status = readTriageStatus(await runCommand(serve, 'step:status', 'Submit', triageStatus(bin, runDir), SUBMIT_TIMEOUT))
  if (!('error' in status) && status.done) return { finished: await refiled(serve, bin, status.step) }
  const standing = 'error' in status ? '' : ` (the binary reports the ${status.phase || 'current'} phase)`
  const why = stopRead(lostRead, limit.seen())
  const note = failureOf(why)
  const stopped = note.startsWith('stopped: ') ? `${note}${standing}` : `triage stopped${standing}: ${note}`
  return {
    stopped: `${stopped}. The run is in ${runDir}. ${triageResumeHint(runDir)}`,
    cause: stopCause(why, 'step'),
  }
}

/**
 * A finished run read back from its status, its record filed again when it did not land (`--resume`), as the binary's
 * re-file ends it; a re-file that cannot be read leaves the run as the status said, never filed a second way.
 * @param {Serve} serve @param {string} bin @param {TriageFinished} step @returns {Promise<TriageFinished>}
 */
async function refiled(serve, bin, step) {
  if (step.stopped || !step.filing || step.filing.record === 'filed') return step
  const again = readTriageStep(await runCommand(serve, 'step:refile', 'Submit', triageSubmit(bin, step.run, { resume: true }), SUBMIT_TIMEOUT))
  return 'step' in again && again.step.done ? again.step : step
}
