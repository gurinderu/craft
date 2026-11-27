// The Claude Code driver of the triage on the CLI's step protocol (integrations/claude-code/src/triage-findings.js; realm
// @nick/craft, node #616): the `craft` binary decides what a triage needs — the gatherers, the memory's recall and
// judges, the validators, the plan — and this driver runs the agents each step hands out and hands their answers
// back, holding no triage logic. The sandbox reads no file and spawns no process (#134), so a service agent runs the
// binary and returns its small JSON verbatim; prompts, schemas, answers and the plan travel as files in the run
// directory. The binary files the run's record itself; this driver files only that of a run the binary never finished
// (integrations/shared/cli-triage-record.mjs).
import { normalizeArgs } from './workflow-args.mjs'
import { readTriageOptions } from './cli-triage-options.mjs'
import { triageStart, triageSubmit } from './cli-triage-commands.mjs'
import { START_TIMEOUT, SUBMIT_TIMEOUT, failureOf, recovered, roundsOf, runCommand } from './cli-triage-rounds.mjs'
import { readTriageStep } from './cli-triage-step.mjs'
import { finishedTriageAnswer, incompleteAnswer, withNotes } from './cli-triage-answer.mjs'
import { triageRecorder } from './cli-triage-record.mjs'
import { binAndRoot } from './cli-step-binary.mjs'
import { serveWith, serviceOf } from './cli-step-service.mjs'
import { stepRounds } from './cli-step-loop.mjs'
import { taskRunner } from './cli-review-task.mjs'
import { argumentRefused } from './cli-review-step.mjs'
import { stopCause } from './cli-review-stop.mjs'

/** @typedef {import('./cli-review-steps.mjs').Sandbox} Sandbox @typedef {import('./cli-step-service.mjs').Serve} Serve */
/** @typedef {import('./cli-triage-options.mjs').TriageOptions} TriageOptions */
/** @typedef {import('./cli-triage-step.mjs').TriagePending} TriagePending @typedef {import('./cli-triage-step.mjs').TriageFinished} TriageFinished */
/** @typedef {{ finished: TriageFinished } | { stopped: string, cause: import('./cli-review-stop.mjs').StopCause } | { argument: string }} Ending */

/** The `notRun` line of a run whose start the binary refused an argument of: a fixed line, tallied by exact text. */
const VALUE_REFUSED_CLASS = 'an argument value triage cannot use was refused, nothing ran'

/** Why no record was filed for a resumed run with no repository named. */
const UNKEYED = "No run record was filed: the resumed run's repository is unknown (no repo= was given)."

/**
 * One triage run, then its answer: where the plan is, or why there is none.
 * @param {Sandbox} sb @param {string} craftVersion @returns {Promise<string>}
 */
export async function runCliTriage(sb, craftVersion) {
  const read = readTriageOptions(normalizeArgs(sb.args, sb.log))
  if ('refused' in read)
    return refusedAnswer(
      sb,
      triageRecorder(sb, craftVersion, () => ({ craftRoot: '', repo: '' })),
      read.refused,
    )
  const o = read.options
  const at = { craftRoot: o.craftRoot, repo: o.repo }
  const recorder = triageRecorder(sb, craftVersion, () => at)
  return endedAnswer(sb, o, at, recorder, await drive(sb, o, craftVersion, at))
}

/**
 * A refusal filed, then its report. @param {Sandbox} sb @param {ReturnType<typeof triageRecorder>} recorder
 * @param {Array<[string, string]>} refused @returns {Promise<string>}
 */
async function refusedAnswer(sb, recorder, refused) {
  sb.phase('Record')
  return withNotes(await recorder.refusal(refused), [recorder.notes()])
}

/**
 * The answer of how the run ended; a run the binary never finished filed INCOMPLETE first — but a resumed run whose
 * repository was not named, which has none to key a record to: filed under the session's, it would sit in another
 * repository's history.
 * @param {Sandbox} sb @param {TriageOptions} o @param {{ craftRoot: string, repo: string }} at  the record's keys @param {ReturnType<typeof triageRecorder>} recorder @param {Ending} ending
 * @returns {Promise<string>}
 */
async function endedAnswer(sb, o, at, recorder, ending) {
  if ('finished' in ending) return finishedTriageAnswer(ending.finished)
  if ('argument' in ending) return refusedAnswer(sb, recorder, [[ending.argument, VALUE_REFUSED_CLASS]])
  sb.phase('Record')
  const keyed = !o.run || !!at.repo
  if (keyed) await recorder.unfinished(ending.cause)
  return withNotes(incompleteAnswer(ending.stopped), [keyed ? '' : UNKEYED, recorder.notes()])
}

/**
 * The binary got, the run started or resumed, then rounds of agents and submits until the binary is done.
 * @param {Sandbox} sb @param {TriageOptions} o @param {string} craftVersion @param {{ craftRoot: string, repo: string }} at  the record's keys, the plugin root filled in
 * @returns {Promise<Ending>}
 */
async function drive(sb, o, craftVersion, at) {
  const { limit, service } = serviceOf(sb)
  const serve = serveWith(service, limit)
  sb.log(`triage-findings ${craftVersion}: ${o.craftBin ?? `the released binary ${craftVersion}`} over ${o.repo || 'the session checkout'}`)
  const where = await binaryOf(sb, o, craftVersion, serve, at)
  if ('stopped' in where) return where
  const first = await opening(serve, where.bin, o, craftVersion, where.recordRoot || where.root, limit)
  if (!('step' in first)) return first
  // A resumed run's repository, when none was given, is the one the binary names.
  if (!first.step.done && first.step.repo) at.repo ||= first.step.repo
  const tasks = taskRunner({ ...sb, agent: limit.tasks(sb.agent) }, () => !!limit.seen())
  return stepRounds(first.step, roundsOf(sb, serve, where.bin, first.step.run, { tasks, limit }))
}

/**
 * The binary to run and the plugin root the record is stamped with, filled into `at` — or why the binary was not got.
 * @param {Sandbox} sb @param {TriageOptions} o @param {string} craftVersion @param {Serve} serve @param {{ craftRoot: string, repo: string }} at
 * @returns {Promise<{ bin: string, root: string, recordRoot?: string } | { stopped: string, cause: import('./cli-review-stop.mjs').StopCause }>}
 */
async function binaryOf(sb, o, craftVersion, serve, at) {
  sb.phase('Start')
  const where = await binAndRoot('triage', o, craftVersion, serve)
  if ('incomplete' in where) return { stopped: where.incomplete, cause: where.cause }
  if (where.note) sb.log(where.note)
  at.craftRoot ||= where.recordRoot || where.root
  return where
}

/**
 * The run's first step — a resume's or a start's —, or how the run ended before any: an argument the binary refused,
 * or a step that could not be read.
 * @param {Serve} serve @param {string} bin @param {TriageOptions} o @param {string} craftVersion @param {string} recordRoot
 * @param {{ seen: () => string }} limit
 * @returns {Promise<{ step: TriagePending | TriageFinished } | Ending>}
 */
async function opening(serve, bin, o, craftVersion, recordRoot, limit) {
  const got = o.run
    ? await runCommand(serve, 'step:resume', 'Start', triageSubmit(bin, o.run, { resume: true }), SUBMIT_TIMEOUT)
    : await runCommand(
        serve,
        'step:start',
        'Start',
        triageStart(bin, o, craftVersion, recordRoot),
        o.priorLedger || o.priorDecisions ? `${START_TIMEOUT}, the JSON inside each \`printf\` copied character for character` : START_TIMEOUT,
      )
  const argument = o.run ? null : argumentRefused(got, 'triage')
  if (argument) return { argument }
  const first = readTriageStep(got)
  if (!('error' in first)) return first
  if (o.run) return recovered(serve, bin, o.run, first, limit)
  return { stopped: `triage stopped: ${failureOf(first)}`, cause: stopCause(first, 'start') }
}
