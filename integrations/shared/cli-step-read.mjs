// The step `craft <kind> start | submit | status` prints, as a driver of the CLI's step protocol reads it (realm
// @nick/craft, node #453), for any kind that ends in files the launching session reads — the triage's plan, the audit's
// report: a pending step's tasks, the same every kind hands out; a finished step's fields, which are the kind's
// (`StepKind.finished`); a status's phase, and a run stopped on the usage limit read as the finished step that says so.
import { absolutePath, commandOutput, filingOf, isObject, pendingTasks } from './cli-review-step.mjs'
import { stepText, stopNoteOf, strings } from './cli-review-step-fields.mjs'

/** @typedef {import('./cli-review-step.mjs').Task} Task @typedef {import('./cli-review-step.mjs').Filing} Filing */
/** @typedef {import('./cli-review-stop.mjs').StopCause} StopCause */
/** @typedef {{ run: string, done: false, tasks: Task[], phase: string, repo: string }} KindPending  repo: the repository the binary audits or triages, '' when it names none */
/** @typedef {{ run: string, done: true, stopped: boolean, line: string, notes: string[], filing: Filing | null }} KindFinished  stopped: the binary held the run on the usage limit, `line` says why */
/** @typedef {{ repo: string, craftBin: string | null, craftRoot: string, run: string }} KindOptions  what every kind's driver takes: the repository ('' the session's), the binary (null the released one), the plugin root, a run to resume ('' to start one) */
/** @typedef {{ error: string, harness?: string }} Unread */

/**
 * One kind of run the shared driver (integrations/shared/cli-step-driver.mjs) drives: the Workflow it is, the binary's
 * command, its answer's heading, how it reads its arguments and starts, and what its finished step holds and says.
 * @template {KindOptions} O @template {KindFinished} F
 * @typedef {object} StepKind
 * @property {string} engine  the Workflow's name, the record's, and the one a resume is launched by
 * @property {string} kind  the binary's command: `craft <kind> start | submit | status`
 * @property {string} title  the heading of the answer
 * @property {number} maxRounds  the rounds after which the driver gives up, a backstop: the binary decides when the run is done
 * @property {(a: Record<string, unknown>) => { options: O } | { refused: Array<[string, string]> }} readOptions
 * @property {(bin: string, o: O, version: string, recordRoot: string, root: string) => string} start  the start's command line: the
 *   run filed through `recordRoot`, its prompts naming the skills under `root` ('' when the binary looks above itself)
 * @property {(o: O) => string} startTimeout  how the service agent runs the start
 * @property {(v: Record<string, unknown>) => { step: F } | { error: string }} finished  a finished step's fields, or why it cannot be read
 * @property {(step: F) => string} answer  the answer of a run the binary ended
 */

/** An absolute path an agent can quote, else ''. @param {unknown} v @returns {string} */
export const pathOf = v => absolutePath(v) ?? ''

/**
 * The fields every kind's finished step carries: its run, whether the binary held it on the usage limit and the line
 * saying so, how to resume it, the record file, what the host said and the run noted, and what filing the record did.
 * @param {Record<string, unknown>} v
 * @returns {KindFinished & { recordFile: string, resume: string, degraded: string[] }}
 */
export const finishedFields = v => ({
  run: String(v['run']),
  done: true,
  stopped: isObject(v['stopped']),
  recordFile: pathOf(v['recordFile']),
  line: stepText(v['line']),
  resume: stepText(v['resume']),
  degraded: strings(v['degraded']),
  notes: strings(v['notes']),
  filing: filingOf(v['filing']),
})

/**
 * The JSON object a command printed, or why there is none. @param {unknown} got @param {string} what  what printed it
 * @returns {{ v: Record<string, unknown> } | Unread}
 */
function printed(got, what) {
  const out = commandOutput(got)
  if ('error' in out) return out
  try {
    /** @type {unknown} */
    const v = JSON.parse(out.stdout)
    return isObject(v) ? { v } : { error: `the ${what} is no JSON object` }
  } catch {
    return { error: `the ${what} printed no JSON: ${out.stdout.slice(0, 200)}` }
  }
}

/**
 * The step the binary printed, or why it cannot be read: no JSON, no run directory, a pending step with no well-formed
 * task, or a finished one its kind cannot read.
 * @template {KindFinished} F
 * @param {unknown} got @param {(v: Record<string, unknown>) => { step: F } | { error: string }} finished
 * @returns {{ step: KindPending | F } | Unread}
 */
export function readStepWith(got, finished) {
  const read = printed(got, 'command')
  if ('error' in read) return read
  const { v } = read
  if (!pathOf(v['run'])) return { error: 'the step names no run directory' }
  return v['done'] === true ? finished(v) : pending(v)
}

/** @param {Record<string, unknown>} v @returns {{ step: KindPending } | { error: string }} */
function pending(v) {
  const read = pendingTasks(v)
  if ('error' in read) return read
  return { step: { run: String(v['run']), done: false, tasks: read.tasks, phase: stepText(v['phase']), repo: stepText(v['repo']) } }
}

/**
 * Where a run stands by its status, for a driver that lost the step that said it: its phase, and whether it is done —
 * its finished step read when it is. A run the binary stopped on the usage limit is not done, but stopped: it ends as
 * its finished step would, the stop's note as its line.
 * @template {KindFinished} F
 * @param {unknown} got @param {(v: Record<string, unknown>) => { step: F } | { error: string }} finished
 * @returns {{ done: true, step: F } | { done: false, phase: string } | Unread}
 */
export function readStatusWith(got, finished) {
  const read = printed(got, 'status')
  if ('error' in read) return read
  const { v } = read
  const stopped = isObject(v['stopped']) && v['done'] !== true
  if (!stopped && v['done'] !== true) return { done: false, phase: stepText(v['phase']) }
  const ended = finished(stopped ? { ...v, run: String(v['run'] ?? ''), done: true, line: stopNoteOf(v['stopped']), resume: '' } : v)
  return 'error' in ended ? ended : { done: true, step: ended.step }
}
