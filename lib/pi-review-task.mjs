// One task of the CLI's step protocol run in pi (realm @nick/craft, nodes #453, #465): its own `pi -p` process, with
// no session saved and no context files, skills or prompt templates of its own, in the reviewed repository. Its
// message is the task's agent prompt body, if any, then the instruction to read the task's prompt file and write the
// answer file with pi's own write tool — pi has no schema output, and needs none: the binary validates the answer and
// hands an invalid one back for a retry. The login and the default model are the pi session's own; no key is passed.
// A process past its kind's deadline (lib/cli-review-deadline.mjs, the table the Claude Code driver races) is killed
// and abandoned; one that fails on the account's usage limit says so by the patterns every driver reads it with
// (lib/usage-limit.mjs).
import fs from 'node:fs'
import path from 'node:path'
import { taskDeadlineMs } from './cli-review-deadline.mjs'
import { usageLimitText } from './usage-limit.mjs'
import { rubricOf } from './task-process-agents.mjs'
import { runProcess } from './task-process-spawn.mjs'

/** @typedef {import('./cli-review-step.mjs').Task} Task */
/** @typedef {import('./task-process-round.mjs').Outcome} Outcome */
/** @typedef {{ pi: string, pluginRoot: string, repo: string, models: import('./task-process-agents.mjs').ModelTable, env: NodeJS.ProcessEnv, deadlineMs?: (kind: string | undefined) => number }} TaskContext  pi: the pi command; deadlineMs: a task kind's deadline, by default the review engine's table */

// The tools a task needs: reading the change and the task files, git through bash, and writing its answer file.
const TOOLS = 'read,bash,write,grep,find,ls'

/**
 * The message a task's process is given: the agent's prompt body, if any, then the task itself, which reads its prompt
 * file and writes its answer file — the body's own gate, verdict and run record are not asked for.
 * @param {string} body @param {Task} t @returns {string}
 */
export function taskMessage(body, t) {
  const task = `Read the file ${t.promptFile} and do exactly what it says: it is your whole task — run no gate, give no verdict and write no run record of your own beyond what it asks. When done, write your final answer as JSON matching the schema in ${t.schemaFile} to ${t.answerFile} with your write tool, and nothing else, then reply with the single word done.`
  if (!body) return task
  return `${body}\n\n---\n\nThe task below is your whole task: use the guidance above for how to review, but run no gate, give no verdict and write no run record of your own beyond what the task asks.\n\n${task}`
}

/** The `--model` arguments for a tier: none when the table leaves it to pi's own. @param {TaskContext['models']} table @param {string} tier @returns {string[]} */
const modelArgs = (table, tier) => {
  const model = table.get(tier)
  return model ? ['--model', model] : []
}

/** The `pi` arguments of a task. @param {Task} t @param {string} message @param {TaskContext} ctx @returns {string[]} */
export const piArgs = (t, message, ctx) => ['-p', '--no-session', '--no-context-files', '--no-skills', '--no-prompt-templates', '--tools', TOOLS, ...modelArgs(ctx.models, t.model), '--', message]

/** @param {string} id @param {Outcome['outcome']} outcome @param {string} why @param {string} rubricless @returns {Outcome} */
const outcomeOf = (id, outcome, why, rubricless) => ({ id, outcome, why, rubricless })

/** The last lines of what a failed process said. @param {import('./task-process-spawn.mjs').Ran} ran */
const tail = ran => `${ran.stderr}\n${ran.stdout}`.trim().split('\n').slice(-3).join(' ').slice(0, 300)

/**
 * Run one task to its outcome: answered when pi exited and left the answer file, else left for the binary to ask again.
 * @param {Task} t @param {TaskContext} ctx @returns {Promise<Outcome>}
 */
export async function runTask(t, ctx) {
  const { agent, body } = rubricOf(t, ctx)
  const rubricless = agent && !body ? agent : ''
  fs.rmSync(t.answerFile, { force: true })
  fs.mkdirSync(path.dirname(t.answerFile), { recursive: true })
  const ran = await runProcess(ctx.pi, piArgs(t, taskMessage(body, t), ctx), { cwd: ctx.repo, env: ctx.env, timeoutMs: (ctx.deadlineMs ?? taskDeadlineMs)(t.kind) })
  if (ran.timedOut) return outcomeOf(t.id, 'abandoned', 'past its deadline', rubricless)
  if (ran.exitCode !== 0) {
    // No answer from a failed process, whatever it wrote: the binary is told it failed.
    fs.rmSync(t.answerFile, { force: true })
    const limit = usageLimitText(`${ran.stderr}\n${ran.stdout}`)
    return outcomeOf(t.id, limit ? 'limit' : 'failed', limit || `pi exited ${ran.exitCode}: ${tail(ran)}`, rubricless)
  }
  return fs.existsSync(t.answerFile) ? outcomeOf(t.id, 'answered', '', rubricless) : outcomeOf(t.id, 'unanswered', `pi wrote no answer file: ${tail(ran)}`, rubricless)
}
