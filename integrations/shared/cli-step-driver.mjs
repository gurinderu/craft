// The Claude Code driver of a kind of run on the CLI's step protocol that ends in files the launching session reads —
// the triage's plan (integrations/claude-code/src/triage-findings.js; realm @nick/craft, node #616), the audit's report
// (integrations/claude-code/src/audit.js; #588): the `craft` binary decides every step, and this driver runs the
// agents each step hands out and hands their answers back, holding none of the kind's logic. The sandbox reads no file
// and spawns no process (#134), so a service agent runs the binary and returns its small JSON verbatim; prompts,
// schemas, answers and what the run ends in travel as files in the run directory. The binary files the run's record
// itself; this driver files only that of a run the binary never finished (integrations/shared/cli-step-record.mjs).
import { normalizeArgs } from './workflow-args.mjs'
import { stepCommands } from './cli-step-commands.mjs'
import { readStepWith } from './cli-step-read.mjs'
import { SUBMIT_TIMEOUT, failureOf, recovered, roundsOf, runCommand } from './cli-step-rounds.mjs'
import { incompleteAnswer, withNotes } from './cli-step-answer.mjs'
import { stepRecorder } from './cli-step-record.mjs'
import { binAndRoot } from './cli-step-binary.mjs'
import { serveWith, serviceOf } from './cli-step-service.mjs'
import { stepRounds } from './cli-step-loop.mjs'
import { taskRunner } from './cli-review-task.mjs'
import { argumentRefused } from './cli-review-step.mjs'
import { UNKNOWN_COMPLETION, stopCause } from './cli-review-stop.mjs'

/** @typedef {import('./cli-review-steps.mjs').Sandbox} Sandbox @typedef {import('./cli-step-service.mjs').Serve} Serve */
/** @typedef {import('./cli-step-read.mjs').KindPending} KindPending @typedef {import('./cli-step-read.mjs').KindFinished} KindFinished */
/** @typedef {import('./cli-step-read.mjs').KindOptions} KindOptions */
/** @template {KindOptions} O @template {KindFinished} F @typedef {import('./cli-step-read.mjs').StepKind<O, F>} StepKind */
/** @template {KindFinished} F @typedef {import('./cli-step-rounds.mjs').Ending<F>} Ending */
/** @typedef {{ craftRoot: string, repo: string }} At  the record's keys */

/** Why no record was filed for a resumed run with no repository named. */
const UNKEYED = "No run record was filed: the resumed run's repository is unknown (no repo= was given)."

/**
 * One run of the kind `k`, then its answer: where what it ended in is, or why there is none.
 * @template {KindOptions} O @template {KindFinished} F
 * @param {Sandbox} sb @param {string} craftVersion @param {StepKind<O, F>} k @returns {Promise<string>}
 */
export async function runCliSteps(sb, craftVersion, k) {
  const read = k.readOptions(normalizeArgs(sb.args, sb.log))
  if ('refused' in read)
    return refusedAnswer(
      sb,
      stepRecorder(sb, k.engine, craftVersion, () => ({ craftRoot: '', repo: '' })),
      read.refused,
    )
  const o = read.options
  const at = { craftRoot: o.craftRoot, repo: o.repo }
  const recorder = stepRecorder(sb, k.engine, craftVersion, () => at)
  return endedAnswer(k, sb, o, at, recorder, await drive(k, sb, o, craftVersion, at))
}

/**
 * A refusal filed, then its report. @param {Sandbox} sb @param {ReturnType<typeof stepRecorder>} recorder
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
 * @template {KindOptions} O @template {KindFinished} F
 * @param {StepKind<O, F>} k @param {Sandbox} sb @param {O} o @param {At} at @param {ReturnType<typeof stepRecorder>} recorder @param {Ending<F>} ending
 * @returns {Promise<string>}
 */
async function endedAnswer(k, sb, o, at, recorder, ending) {
  if ('finished' in ending) return k.answer(ending.finished)
  // The `notRun` line of a run whose start the binary refused an argument of: a fixed line, tallied by exact text.
  if ('argument' in ending) return refusedAnswer(sb, recorder, [[ending.argument, `an argument value ${k.kind} cannot use was refused, nothing ran`]])
  if ('unknown' in ending) return withNotes(incompleteAnswer(k.title, ending.unknown), [UNKNOWN_COMPLETION, recorder.notes()])
  sb.phase('Record')
  const keyed = !o.run || !!at.repo
  if (keyed) await recorder.unfinished(ending.cause)
  return withNotes(incompleteAnswer(k.title, ending.stopped), [keyed ? '' : UNKEYED, recorder.notes()])
}

/**
 * The binary got, the run started or resumed, then rounds of agents and submits until the binary is done.
 * @template {KindOptions} O @template {KindFinished} F
 * @param {StepKind<O, F>} k @param {Sandbox} sb @param {O} o @param {string} craftVersion @param {At} at  the plugin root filled in
 * @returns {Promise<Ending<F>>}
 */
async function drive(k, sb, o, craftVersion, at) {
  const { limit, service } = serviceOf(sb)
  const serve = serveWith(service, limit)
  sb.log(`${k.engine} ${craftVersion}: ${o.craftBin ?? `the released binary ${craftVersion}`} over ${o.repo || 'the session checkout'}`)
  const where = await binaryOf(k, sb, o, craftVersion, serve, at)
  if ('stopped' in where) return where
  const first = await opening(k, serve, where.bin, o, craftVersion, where.recordRoot || where.root, limit)
  if (!('step' in first)) return first
  // A resumed run's repository, when none was given, is the one the binary names.
  if (!first.step.done && first.step.repo) at.repo ||= first.step.repo
  const tasks = taskRunner({ ...sb, agent: limit.tasks(sb.agent) }, () => !!limit.seen())
  return stepRounds(first.step, roundsOf(k, sb, serve, where.bin, first.step.run, { tasks, limit }))
}

/**
 * The binary to run and the plugin root the record is stamped with, filled into `at` — or why the binary was not got.
 * @template {KindOptions} O @template {KindFinished} F
 * @param {StepKind<O, F>} k @param {Sandbox} sb @param {O} o @param {string} craftVersion @param {Serve} serve @param {At} at
 * @returns {Promise<{ bin: string, root: string, recordRoot?: string } | { stopped: string, cause: import('./cli-review-stop.mjs').StopCause }>}
 */
async function binaryOf(k, sb, o, craftVersion, serve, at) {
  sb.phase('Start')
  const where = await binAndRoot(k.kind, o, craftVersion, serve)
  if ('incomplete' in where) return { stopped: where.incomplete, cause: where.cause }
  if (where.note) sb.log(where.note)
  at.craftRoot ||= where.recordRoot || where.root
  return where
}

/**
 * The run's first step — a resume's or a start's —, or how the run ended before any: an argument the binary refused,
 * or a step that could not be read.
 * @template {KindOptions} O @template {KindFinished} F
 * @param {StepKind<O, F>} k @param {Serve} serve @param {string} bin @param {O} o @param {string} craftVersion @param {string} recordRoot
 * @param {{ seen: () => string }} limit
 * @returns {Promise<{ step: KindPending | F } | Ending<F>>}
 */
async function opening(k, serve, bin, o, craftVersion, recordRoot, limit) {
  const got = o.run
    ? await runCommand(serve, 'step:resume', 'Start', stepCommands(k.kind).submit(bin, o.run, { resume: true }), SUBMIT_TIMEOUT)
    : await runCommand(serve, 'step:start', 'Start', k.start(bin, o, craftVersion, recordRoot), k.startTimeout(o))
  const argument = o.run ? null : argumentRefused(got, k.kind)
  if (argument) return { argument }
  const first = readStepWith(got, k.finished)
  if (!('error' in first)) return first
  if (o.run) return recovered(k, serve, bin, o.run, first, limit)
  return { stopped: `${k.kind} stopped: ${failureOf(k.kind, first)}`, cause: stopCause(first, 'start') }
}
