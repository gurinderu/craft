// One task of the CLI's step protocol run in OpenCode (realm @nick/craft, nodes #453, #465): its own child session
// through the plugin's host (integrations/opencode/plugin/host.ts, `runChild`), on either OpenCode runtime. The task
// is the binary's: its prompt file, then its schema, and the session's final message is the answer, which the driver
// writes to the task's answer file for the binary to validate — as Codex writes its last message there (`-o`). A
// task naming `rust-reviewer` runs on the OpenCode agent of that name (integrations/opencode/agents/, read-only); any
// other on the session's default agent, with the Claude Code agent's prompt body first (lib/codex-review-agents.mjs,
// rubricOf). The model is the tier's from the driver's table, else the session's. A session past its kind's deadline
// (lib/cli-review-deadline.mjs) is abandoned; one that fails on the usage limit says so (lib/usage-limit.mjs).
import fs from 'node:fs'
import path from 'node:path'
import { taskDeadlineMs } from './cli-review-deadline.mjs'
import { usageLimitText } from './usage-limit.mjs'
import { rubricOf } from './codex-review-agents.mjs'
import { taskInput } from './codex-review-task.mjs'

/** @typedef {import('./cli-review-step.mjs').Task} Task */
/** @typedef {{ providerID: string, modelID: string }} ModelRef */
/** @typedef {{ title: string, agent: string, prompt: string, model?: ModelRef }} ChildRequest */
/** @typedef {{ runChild: (req: ChildRequest) => Promise<string>, pluginRoot: string, repo: string, models: Map<string, string>, deadlineMs?: (kind: string | undefined) => number }} TaskContext  models: an OpenCode `provider/model` per tier mapped */
/** @typedef {import('./codex-review-task.mjs').Outcome} Outcome */

/** The binary's agent kinds that run on an OpenCode agent of their own, by its name in integrations/opencode/agents/. */
export const OPENCODE_AGENTS = new Map([['rust-reviewer', 'rust-reviewer']])

const WHOLE_TASK = 'The task below is your whole task: use your own guidance for how to review, but run no gate, give no verdict and write no run record of your own beyond what the task asks.'

/**
 * The OpenCode agent a task runs on ('' the session's default) and the prompt body it runs with.
 * @param {Task} t @param {TaskContext} ctx @returns {{ agent: string, body: string, rubricless: string }}
 */
export function placementOf(t, ctx) {
  const own = t.consumerAgent === undefined ? OPENCODE_AGENTS.get(t.agentType ?? '') : undefined
  if (own) return { agent: own, body: '', rubricless: '' }
  const { agent, body } = rubricOf(t, ctx)
  return { agent: '', body, rubricless: agent && !body ? agent : '' }
}

/** A tier's model from the table as OpenCode names it, none when the table leaves it to the session. @param {Map<string, string>} models @param {string} tier */
export function modelOf(models, tier) {
  const spec = models.get(tier) ?? ''
  const slash = spec.indexOf('/')
  return slash > 0 ? { providerID: spec.slice(0, slash), modelID: spec.slice(slash + 1) } : undefined
}

/** The child's prompt: the binary's task and schema, after the agent's body or the note that the task is the whole task. @param {Task} t @param {{ agent: string, body: string }} place @param {string} pluginRoot */
export function childPrompt(t, place, pluginRoot) {
  const schema = fs.readFileSync(t.schemaFile, 'utf8').trim()
  const task = `${fs.readFileSync(t.promptFile, 'utf8').trim()}\n\nThe JSON schema your answer must satisfy:\n\n\`\`\`json\n${schema}\n\`\`\``
  return place.agent ? `${WHOLE_TASK}\n\n${taskInput('', task, pluginRoot)}` : taskInput(place.body, task, pluginRoot)
}

/** The JSON object a final message carries: its last fenced block, else from its first `{` to its last `}`. @param {string} text @returns {object | undefined} */
export function answerOf(text) {
  const fenced = [...text.matchAll(/```(?:json)?\s*\n([\s\S]*?)```/g)].at(-1)?.[1]
  const body = fenced ?? text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)
  try {
    const value = JSON.parse(body)
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? value : undefined
  } catch {
    return undefined
  }
}

/** `work` raced against `ms`. @param {Promise<string>} work @param {number} ms @returns {Promise<{ text: string } | { timedOut: true } | { error: string }>} */
async function within(work, ms) {
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let timer
  const late = new Promise(resolve => { timer = setTimeout(() => resolve({ timedOut: true }), ms) })
  const done = work.then(text => ({ text }), e => ({ error: e instanceof Error ? e.message : String(e) }))
  return /** @type {Promise<{ text: string } | { timedOut: true } | { error: string }>} */ (Promise.race([done, late])).finally(() => clearTimeout(timer))
}

/** @param {string} id @param {Outcome['outcome']} outcome @param {string} why @param {string} rubricless @returns {Outcome} */
const outcomeOf = (id, outcome, why, rubricless) => ({ id, outcome, why, rubricless })

/** @param {Task} t @param {{ agent: string, body: string }} place @param {string} pluginRoot @returns {{ prompt: string } | { error: string }} */
function prepare(t, place, pluginRoot) {
  try {
    return { prompt: childPrompt(t, place, pluginRoot) }
  } catch (e) {
    return { error: `its prompt or schema could not be read: ${e instanceof Error ? e.message : String(e)}` }
  }
}

/**
 * Run one task to its outcome. A prompt or schema the driver cannot read fails the task, as a dead agent.
 * @param {Task} t @param {TaskContext} ctx @returns {Promise<Outcome>}
 */
export async function runTask(t, ctx) {
  const place = placementOf(t, ctx)
  const prepared = prepare(t, place, ctx.pluginRoot)
  if ('error' in prepared) return outcomeOf(t.id, 'failed', prepared.error, place.rubricless)
  fs.rmSync(t.answerFile, { force: true })
  const model = modelOf(ctx.models, t.model)
  const req = { title: `craft:review ${t.label}`, agent: place.agent, prompt: prepared.prompt, ...(model ? { model } : {}) }
  const ran = await within(ctx.runChild(req), (ctx.deadlineMs ?? taskDeadlineMs)(t.kind))
  if ('timedOut' in ran) return outcomeOf(t.id, 'abandoned', 'past its deadline', place.rubricless)
  if ('error' in ran) {
    const limit = usageLimitText(ran.error)
    return outcomeOf(t.id, limit ? 'limit' : 'failed', limit || `the child session failed: ${ran.error.slice(0, 300)}`, place.rubricless)
  }
  const answer = answerOf(ran.text)
  if (!answer) return outcomeOf(t.id, 'failed', 'the child session\'s final message held no JSON answer', place.rubricless)
  fs.mkdirSync(path.dirname(t.answerFile), { recursive: true })
  fs.writeFileSync(t.answerFile, `${JSON.stringify(answer)}\n`)
  return outcomeOf(t.id, 'answered', '', place.rubricless)
}
