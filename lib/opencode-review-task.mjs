// One task of the CLI's step protocol run in OpenCode (realm @nick/craft, nodes #453, #465): the OpenCode host's
// `runTask` for the shared driver (lib/task-process-entry.mjs, lib/task-process-round.mjs). A task is one child
// session through the plugin's host (integrations/opencode/plugin/host.ts, `runChild`), nested under the session that
// called the tool, on either OpenCode runtime, and always read-only: a task naming `rust-reviewer` runs on the OpenCode
// agent of that name, every other on `review-task` (integrations/opencode/agents/: both have write and edit off), with
// the Claude Code agent's prompt body first (lib/task-process-agents.mjs, rubricOf). Its message is pi's
// (lib/pi-review-task.mjs, taskMessage): read the prompt file, print the answer as one JSON object at the end, which
// the driver writes to the task's answer file (lib/pi-review-answer.mjs) for the binary to validate. The model is the
// tier's from the driver's table, else the calling session's. A session past its kind's deadline
// (lib/cli-review-deadline.mjs) is abandoned; one that fails on the usage limit says so (lib/usage-limit.mjs); any
// other failure, and a reply with no answer, is left unanswered for the binary to hand out again.
import fs from 'node:fs'
import path from 'node:path'
import { taskDeadlineMs } from './cli-review-deadline.mjs'
import { usageLimitText } from './usage-limit.mjs'
import { rubricOf } from './task-process-agents.mjs'
import { outcomeOf } from './task-process-task.mjs'
import { promptOf, taskMessage } from './pi-review-task.mjs'
import { answerOf } from './pi-review-answer.mjs'

/** @typedef {import('./cli-review-step.mjs').Task} Task */
/** @typedef {import('./task-process-round.mjs').Outcome} Outcome */
/** @typedef {{ providerID: string, modelID: string }} ModelRef */
/** @typedef {{ title: string, agent: string, prompt: string, model?: ModelRef }} ChildRequest */
/** @typedef {{ runChild: (req: ChildRequest) => Promise<string>, pluginRoot: string, repo: string, models: Map<string, string>, deadlineMs?: (kind: string | undefined) => number }} TaskContext  models: an OpenCode `provider/model` per tier mapped */

/** The binary's agent kinds that run on an OpenCode agent of their own, by its name in integrations/opencode/agents/. */
export const OPENCODE_AGENTS = new Map([['rust-reviewer', 'rust-reviewer']])
/** The read-only OpenCode agent every other task runs on. */
export const TASK_AGENT = 'review-task'

/**
 * The OpenCode agent a task runs on and the prompt body it runs with first.
 * @param {Task} t @param {{ pluginRoot: string, repo: string }} where @returns {{ agent: string, body: string, rubricless: string }}
 */
export function placementOf(t, where) {
  const own = t.consumerAgent === undefined ? OPENCODE_AGENTS.get(t.agentType ?? '') : undefined
  if (own) return { agent: own, body: '', rubricless: '' }
  const { agent, body } = rubricOf(t, where)
  return { agent: TASK_AGENT, body, rubricless: agent && !body ? agent : '' }
}

/** A tier's model from the table as OpenCode names it, none when the table leaves it to the calling session's. @param {Map<string, string>} models @param {string} tier */
export function modelOf(models, tier) {
  const spec = models.get(tier) ?? ''
  const slash = spec.indexOf('/')
  return slash > 0 ? { providerID: spec.slice(0, slash), modelID: spec.slice(slash + 1) } : undefined
}

/** `work` raced against `ms`. @param {Promise<string>} work @param {number} ms @returns {Promise<{ text: string } | { timedOut: true } | { error: string }>} */
async function within(work, ms) {
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let timer
  const late = new Promise(resolve => { timer = setTimeout(() => resolve({ timedOut: true }), ms) })
  const done = work.then(text => ({ text }), e => ({ error: e instanceof Error ? e.message : String(e) }))
  return /** @type {Promise<{ text: string } | { timedOut: true } | { error: string }>} */ (Promise.race([done, late])).finally(() => clearTimeout(timer))
}

/** The task's message, or why its prompt cannot be read. @param {Task} t @param {string} body @param {string} root */
function messageOf(t, body, root) {
  try {
    return { message: taskMessage(body, t, root, promptOf(t, root)) }
  } catch (e) {
    return { error: `its prompt could not be read: ${e instanceof Error ? e.message : String(e)}` }
  }
}

/** The answer a reply printed, written to the task's answer file; false when it printed none. @param {Task} t @param {string} text */
function settle(t, text) {
  const answer = answerOf(text)
  if (answer) fs.writeFileSync(t.answerFile, `${JSON.stringify(answer)}\n`)
  return answer !== null
}

/** A failed session's outcome: the usage limit stops the run, anything else is left unanswered. @param {Task} t @param {string} error @param {string} rubricless */
function failed(t, error, rubricless) {
  const limit = usageLimitText(error)
  const said = error.slice(0, 300)
  return limit ? outcomeOf(t.id, 'limit', limit, rubricless) : outcomeOf(t.id, 'unanswered', `the child session failed: ${said}`, rubricless, said)
}

/**
 * Run one task to its outcome.
 * @param {Task} t @param {TaskContext} ctx @returns {Promise<Outcome>}
 */
export async function runTask(t, ctx) {
  const place = placementOf(t, ctx)
  const read = messageOf(t, place.body, ctx.pluginRoot)
  if ('error' in read) return outcomeOf(t.id, 'unanswered', read.error, place.rubricless)
  fs.rmSync(t.answerFile, { force: true })
  fs.mkdirSync(path.dirname(t.answerFile), { recursive: true })
  const model = modelOf(ctx.models, t.model)
  const req = { title: `craft:review ${t.label}`, agent: place.agent, prompt: read.message, ...(model ? { model } : {}) }
  const ran = await within(ctx.runChild(req), (ctx.deadlineMs ?? taskDeadlineMs)(t.kind))
  if ('timedOut' in ran) return outcomeOf(t.id, 'abandoned', 'past its deadline', place.rubricless)
  if ('error' in ran) return failed(t, ran.error, place.rubricless)
  if (settle(t, ran.text)) return outcomeOf(t.id, 'answered', '', place.rubricless)
  return outcomeOf(t.id, 'unanswered', `the child session gave no answer: ${ran.text.trim().slice(-300)}`, place.rubricless)
}
