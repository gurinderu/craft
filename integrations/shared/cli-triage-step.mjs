// The step `craft triage start | submit | status` prints, as the triage driver reads it (integrations/shared/cli-triage-steps.mjs;
// realm @nick/craft, node #616): a pending step's tasks, the same tasks every kind hands out; a finished step's plan file,
// record file, the plan's summary — or the text of a plan that failed —, what filing the record did and what the host
// said; a stopped one's line and how to resume it; a status's phase. The plan itself is read from its file, by the
// session that launched the triage, never copied through a model.
import { absolutePath, commandOutput, filingOf, isObject, pendingTasks } from './cli-review-step.mjs'
import { stepText, strings } from './cli-review-step-fields.mjs'

/** @typedef {import('./cli-review-step.mjs').Task} Task @typedef {import('./cli-review-step.mjs').Filing} Filing */
/** @typedef {{ run: string, done: false, tasks: Task[], phase: string, repo: string }} TriagePending */
/** @typedef {{ run: string, done: true, planFile: string, recordFile: string, summary: string, failed: string, stopped: boolean, line: string, resume: string, degraded: string[], notes: string[], filing: Filing | null }} TriageFinished  stopped: the binary held the run on the usage limit — no plan, `line` says why and `resume` how to go on; failed: the text of a plan that failed, '' else */
/** @typedef {TriagePending | TriageFinished} TriageStep */

/** An absolute path an agent can quote, else ''. @param {unknown} v @returns {string} */
const pathOf = v => absolutePath(v) ?? ''

/**
 * The JSON object a command printed, or why there is none. @param {unknown} got @param {string} what  what printed it
 * @returns {{ v: Record<string, unknown> } | { error: string, harness?: string }}
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
 * task, or a finished one that is neither stopped nor names its plan file.
 * @param {unknown} got @returns {{ step: TriageStep } | { error: string, harness?: string }}
 */
export function readTriageStep(got) {
  const read = printed(got, 'command')
  if ('error' in read) return read
  const { v } = read
  if (!pathOf(v['run'])) return { error: 'the step names no run directory' }
  return v['done'] === true ? finished(v) : pending(v)
}

/** @param {Record<string, unknown>} v @returns {{ step: TriagePending } | { error: string }} */
function pending(v) {
  const read = pendingTasks(v)
  if ('error' in read) return read
  return { step: { run: String(v['run']), done: false, tasks: read.tasks, phase: stepText(v['phase']), repo: stepText(v['repo']) } }
}

/** @param {Record<string, unknown>} v @returns {{ step: TriageFinished } | { error: string }} */
function finished(v) {
  const stopped = isObject(v['stopped'])
  const planFile = pathOf(v['planFile'])
  if (!stopped && !planFile) return { error: 'a finished step names no plan file' }
  return {
    step: {
      run: String(v['run']),
      done: true,
      planFile,
      recordFile: pathOf(v['recordFile']),
      summary: stepText(v['summary']),
      failed: stepText(v['failed']),
      stopped,
      line: stepText(v['line']),
      resume: stepText(v['resume']),
      degraded: strings(v['degraded']),
      notes: strings(v['notes']),
      filing: filingOf(v['filing']),
    },
  }
}

/**
 * Where a run stands by its status, for a driver that lost the step that said it: its phase, and whether it is done —
 * its plan file named when it is.
 * @param {unknown} got @returns {{ done: true, step: TriageFinished } | { done: false, phase: string } | { error: string, harness?: string }}
 */
export function readTriageStatus(got) {
  const read = printed(got, 'status')
  if ('error' in read) return read
  const { v } = read
  if (v['done'] !== true) return { done: false, phase: stepText(v['phase']) }
  const ended = finished(v)
  return 'error' in ended ? ended : { done: true, step: ended.step }
}
