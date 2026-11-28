// The rounds of a kind of run on the CLI's step protocol that ends in files (integrations/shared/cli-step-driver.mjs;
// realm @nick/craft, nodes #616, #588): the service step that runs one binary command, a step's tasks dispatched, their
// answers submitted with what the host saw of them, and a lost step recovered by the binary's status before anything
// is filed.
import { stepCommands } from './cli-step-commands.mjs'
import { readStatusWith, readStepWith } from './cli-step-read.mjs'
import { resumeHint } from './cli-step-answer.mjs'
import { servicePrompt } from './cli-step-service.mjs'
import { dispatchTasks } from './cli-step-loop.mjs'
import { harnessRefused } from './cli-review-refusal.mjs'
import { recoveryFailure, stopCause, stopRead } from './cli-review-stop.mjs'

/** @typedef {import('./cli-step-service.mjs').Serve} Serve @typedef {import('./cli-review-steps.mjs').Sandbox} Sandbox */
/** @typedef {import('./cli-step-read.mjs').KindPending} KindPending @typedef {import('./cli-step-read.mjs').KindFinished} KindFinished */
/** @typedef {import('./cli-step-read.mjs').KindOptions} KindOptions @typedef {import('./cli-step-read.mjs').Unread} Unread */
/** @typedef {import('./cli-review-task.mjs').taskRunner} TaskRunner */
/** @template {KindOptions} O @template {KindFinished} F @typedef {import('./cli-step-read.mjs').StepKind<O, F>} StepKind */
/** @template {KindFinished} F @typedef {{ finished: F } | { stopped: string, cause: import('./cli-review-stop.mjs').StopCause } | { unknown: string } | { argument: string }} Ending */

// A submit may file the record, waiting at most 45 s on the store's index lock (cli/crates/craft-store/src/lock.rs):
// past a Bash call's default two minutes, so five with headroom.
export const SUBMIT_TIMEOUT = "in one Bash call with a timeout of 300000 ms (it may file the run's record)"

/** A service step that runs `cmd`. @param {Serve} serve @param {string} label @param {string} title @param {string} cmd @param {string} timeout */
export const runCommand = (serve, label, title, cmd, timeout) => serve(label, title, servicePrompt(`Run exactly this one command, ${timeout}:\n\n${cmd}`), cmd)

/** Why a read failed, the harness's refusal said as one. @param {string} kind @param {Unread} read */
export const failureOf = (kind, read) => (read.harness === undefined ? read.error : harnessRefused(read.harness, null, `a \`craft ${kind}\` command`))

/**
 * The kind's part of the step rounds: its tasks dispatched, their answers submitted with what the host saw of them,
 * a lost step recovered by the binary's status.
 * @template {KindOptions} O @template {KindFinished} F
 * @param {StepKind<O, F>} k @param {Sandbox} sb @param {Serve} serve @param {string} bin @param {string} runDir
 * @param {{ tasks: ReturnType<TaskRunner>, limit: { seen: () => string } }} with_
 * @returns {import('./cli-step-loop.mjs').Rounds<KindPending, F, Ending<F>>}
 */
export function roundsOf(k, sb, serve, bin, runDir, { tasks, limit }) {
  const { submit } = stepCommands(k.kind)
  return {
    maxRounds: k.maxRounds,
    dispatch: (step, round) => dispatchTasks(sb, tasks, step, round, step.phase || k.kind),
    submit: async (step, round) => {
      sb.phase('Submit')
      const said = { degraded: tasks.degraded(round), abandoned: tasks.abandoned(), limit: limit.seen() }
      return readStepWith(await runCommand(serve, `step:submit:${round}`, 'Submit', submit(bin, step.run, said), SUBMIT_TIMEOUT), k.finished)
    },
    heard: () => {},
    lost: async lostRead => recovered(k, serve, bin, runDir, lostRead, limit),
    gaveUp: step => ({
      stopped: `${k.kind} gave up after ${k.maxRounds} rounds; the run is in ${step.run}. ${resumeHint(k.engine, step.run)}`,
      cause: 'rounds',
    }),
    finished: step => ({ finished: step }),
  }
}

/**
 * A submit whose output could not be read may still have ended the run: the binary's status is asked before anything
 * is filed. A run it ended ends as it says; one it did not, stops where it stands, to be resumed.
 * @template {KindOptions} O @template {KindFinished} F
 * @param {StepKind<O, F>} k @param {Serve} serve @param {string} bin @param {string} runDir @param {Unread} lostRead
 * @param {{ seen: () => string }} limit
 * @returns {Promise<Ending<F>>}
 */
export async function recovered(k, serve, bin, runDir, lostRead, limit) {
  const command = stepCommands(k.kind).status(bin, runDir)
  const got = await runCommand(serve, 'step:status', 'Submit', command, SUBMIT_TIMEOUT)
  const status = readStatusWith(got, k.finished)
  if (!('error' in status) && status.done) return { finished: await refiled(k, serve, bin, status.step) }
  const standing = 'error' in status ? '' : ` (the binary reports the ${status.phase || 'current'} phase)`
  const why = stopRead(lostRead, limit.seen())
  const note = failureOf(k.kind, why)
  const stopped = note.startsWith('stopped: ') ? `${note}${standing}` : `${k.kind} stopped${standing}: ${note}`
  const text = `${stopped}. The run is in ${runDir}. ${resumeHint(k.engine, runDir)}`
  const failed = recoveryFailure(got, command)
  if (failed) return { unknown: `${text}\n\nStatus recovery failed: ${failureOf(k.kind, failed)}` }
  return { stopped: text, cause: stopCause(why, 'step') }
}

/**
 * A finished run read back from its status, its record filed again when it did not land (`--resume`), as the binary's
 * re-file ends it; a re-file that cannot be read leaves the run as the status said, never filed a second way.
 * @template {KindOptions} O @template {KindFinished} F
 * @param {StepKind<O, F>} k @param {Serve} serve @param {string} bin @param {F} step @returns {Promise<F>}
 */
async function refiled(k, serve, bin, step) {
  if (step.stopped || !step.filing || step.filing.record === 'filed') return step
  const cmd = stepCommands(k.kind).submit(bin, step.run, { resume: true })
  const again = readStepWith(await runCommand(serve, 'step:refile', 'Submit', cmd, SUBMIT_TIMEOUT), k.finished)
  return 'step' in again && again.step.done ? again.step : step
}
