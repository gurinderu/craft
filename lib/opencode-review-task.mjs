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
/** @typedef {{ title: string, agent: string, prompt: string, model?: ModelRef, signal?: AbortSignal }} ChildRequest  signal: aborted at the task's deadline — the host stops the session */
/** @typedef {{ runChild: (req: ChildRequest) => Promise<string>, pluginRoot: string, repo: string, models: Map<string, string>, agents?: Set<string> | null, deadlineMs?: (kind: string | undefined) => number }} TaskContext  models: an OpenCode `provider/model` per tier mapped; agents: the runtime's agents, null when unknown */
/** @typedef {{ agent: string, body: string, rubricless: string, degraded: string }} Placement */

/** The binary's agent kinds that run on an OpenCode agent of their own, by its name in integrations/opencode/agents/. */
export const OPENCODE_AGENTS = new Map([['rust-reviewer', 'rust-reviewer']])
/** The read-only OpenCode agent every other task runs on. */
export const TASK_AGENT = 'review-task'
// What a runtime says of an agent it does not have. Not observed: 1.19.5 answers an unknown agent with an opaque server
// error, 2.2.7 accepts one at creation (both observed) — the agent list (`agents`) is the check that works; this is
// its backstop for a runtime that names the cause.
const AGENT_MISSING = /agent\b[^\n]*\b(not found|unknown|does not exist|no such)|(unknown|no such) agent/i

/**
 * The OpenCode agent a task runs on and the prompt body it runs with first. A task whose own OpenCode agent the
 * runtime lacks runs on `review-task` with that agent's Claude Code body instead, said degraded (realm @nick/craft, #465).
 * @param {Task} t @param {{ pluginRoot: string, repo: string }} where @param {Set<string> | null} [agents]
 * @returns {Placement}
 */
export function placementOf(t, where, agents = null) {
  const own = t.consumerAgent === undefined ? OPENCODE_AGENTS.get(t.agentType ?? '') : undefined
  if (own && (!agents || agents.has(own))) return { agent: own, body: '', rubricless: '', degraded: '' }
  const { agent, body } = rubricOf(t, where)
  const degraded = own ? `named \`${own}\`, an agent this OpenCode does not have, and ran on \`${TASK_AGENT}\` with its prompt body` : ''
  return { agent: TASK_AGENT, body, rubricless: agent && !body ? agent : '', degraded }
}

/** A tier's model from the table as OpenCode names it, none when the table leaves it to the calling session's. @param {Map<string, string>} models @param {string} tier */
export function modelOf(models, tier) {
  const spec = models.get(tier) ?? ''
  const slash = spec.indexOf('/')
  return slash > 0 ? { providerID: spec.slice(0, slash), modelID: spec.slice(slash + 1) } : undefined
}

/**
 * `start(signal)` raced against `ms`; past it the signal is aborted, which stops the child session.
 * @param {(signal: AbortSignal) => Promise<string>} start @param {number} ms
 * @returns {Promise<{ text: string } | { timedOut: true } | { error: string }>}
 */
async function within(start, ms) {
  const stop = new AbortController()
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let timer
  const late = new Promise(resolve => { timer = setTimeout(() => { stop.abort(); resolve({ timedOut: true }) }, ms) })
  const done = start(stop.signal).then(text => ({ text }), e => ({ error: e instanceof Error ? e.message : String(e) }))
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

/** An outcome with what the placement made weaker. @param {Outcome} o @param {Placement} place @returns {Outcome} */
const noted = (o, place) => (place.degraded ? { ...o, degraded: place.degraded } : o)

/**
 * One attempt of a task on `place`; `missing` when the runtime said the agent is not there.
 * @param {Task} t @param {TaskContext} ctx @param {Placement} place @returns {Promise<{ outcome: Outcome, missing: boolean }>}
 */
async function attempt(t, ctx, place) {
  const read = messageOf(t, place.body, ctx.pluginRoot)
  if ('error' in read) return { outcome: outcomeOf(t.id, 'unanswered', read.error, place.rubricless), missing: false }
  fs.rmSync(t.answerFile, { force: true })
  fs.mkdirSync(path.dirname(t.answerFile), { recursive: true })
  const model = modelOf(ctx.models, t.model)
  const req = { title: `craft:review ${t.label}`, agent: place.agent, prompt: read.message, ...(model ? { model } : {}) }
  const ran = await within(signal => ctx.runChild({ ...req, signal }), (ctx.deadlineMs ?? taskDeadlineMs)(t.kind))
  if ('timedOut' in ran) return { outcome: outcomeOf(t.id, 'abandoned', 'past its deadline', place.rubricless), missing: false }
  if ('error' in ran) return { outcome: failed(t, ran.error, place.rubricless), missing: AGENT_MISSING.test(ran.error) }
  if (settle(t, ran.text)) return { outcome: outcomeOf(t.id, 'answered', '', place.rubricless), missing: false }
  return { outcome: outcomeOf(t.id, 'unanswered', `the child session gave no answer: ${ran.text.trim().slice(-300)}`, place.rubricless), missing: false }
}

/**
 * Run one task to its outcome: on its placement, and once more on `review-task` when its own agent turned out missing.
 * @param {Task} t @param {TaskContext} ctx @returns {Promise<Outcome>}
 */
export async function runTask(t, ctx) {
  const place = placementOf(t, ctx, ctx.agents ?? null)
  const first = await attempt(t, ctx, place)
  if (!first.missing || place.agent === TASK_AGENT) return noted(first.outcome, place)
  const fallback = placementOf(t, ctx, new Set())
  return noted((await attempt(t, ctx, fallback)).outcome, fallback)
}
