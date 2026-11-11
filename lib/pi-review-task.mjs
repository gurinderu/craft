// One task of the CLI's step protocol run in pi (realm @nick/craft, nodes #453, #465): its own `pi -p` process, with
// no session saved and no context files, skills or prompt templates of its own, in the reviewed repository. Its
// message is the task's agent prompt body, if any, then the instruction to read the task's prompt file and write the
// answer file with pi's own write tool — pi has no schema output, and needs none: the binary validates the answer and
// hands an invalid one back for a retry. The login and the default model are the pi session's own; no key is passed.
// A process past its kind's deadline (lib/cli-review-deadline.mjs, the table the Claude Code driver races) is killed
// and abandoned; one that fails on the account's usage limit says so by the patterns every driver reads it with
// (lib/usage-limit.mjs), one that fails for want of a login stops the run, and any other failure is left unanswered.
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
 * file and writes its answer file — the body's own gate, verdict and run record are not asked for — then where a skill
 * the prompt names is, since pi loads none of craft's. The literal `${CLAUDE_PLUGIN_ROOT}` is the package root.
 * @param {string} body @param {Task} t @param {string} root  the package root @returns {string}
 */
export function taskMessage(body, t, root) {
  const task = `Read the file ${t.promptFile} and do exactly what it says: it is your whole task — run no gate, give no verdict and write no run record of your own beyond what it asks. When done, write your final answer as JSON matching the schema in ${t.schemaFile} to ${t.answerFile} with your write tool, and nothing else, then reply with the single word done.`
  const skills = `A skill named in the prompt or the guidance (such as \`rust-review\`) is the file ${path.join(root, 'skills', '<name>', 'SKILL.md')}: read it from there.`
  const head = body ? `${body}\n\n---\n\nThe task below is your whole task: use the guidance above for how to review, but run no gate, give no verdict and write no run record of your own beyond what the task asks.\n\n` : ''
  return `${head}${task}\n\n${skills}`.replaceAll('${CLAUDE_PLUGIN_ROOT}', root)
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

// What pi says when no provider is logged in: no task can answer until the human logs in.
const NOT_LOGGED_IN = /No API key found[^\n]*/

/**
 * A failed process's outcome: the usage limit and a missing login stop the run; anything else is left unanswered,
 * which the binary asks for again.
 * @param {Task} t @param {import('./task-process-spawn.mjs').Ran} ran @param {string} rubricless @returns {Outcome}
 */
function failedOutcome(t, ran, rubricless) {
  const said = `${ran.stderr}\n${ran.stdout}`
  const limit = usageLimitText(said)
  if (limit) return outcomeOf(t.id, 'limit', limit, rubricless)
  const login = NOT_LOGGED_IN.exec(said)
  if (login) return outcomeOf(t.id, 'login', `pi is not logged in (${login[0].trim()}): log in to pi — run \`pi\` and \`/login\` — then resume the run`, rubricless)
  return outcomeOf(t.id, 'unanswered', `pi exited ${ran.exitCode}: ${tail(ran)}`, rubricless)
}

/**
 * Run one task to its outcome: answered when pi exited and left the answer file; past its deadline abandoned; else
 * left for the binary to ask again, unless it stops the run.
 * @param {Task} t @param {TaskContext} ctx @returns {Promise<Outcome>}
 */
export async function runTask(t, ctx) {
  const { agent, body } = rubricOf(t, ctx)
  const rubricless = agent && !body ? agent : ''
  fs.rmSync(t.answerFile, { force: true })
  fs.mkdirSync(path.dirname(t.answerFile), { recursive: true })
  const ran = await runProcess(ctx.pi, piArgs(t, taskMessage(body, t, ctx.pluginRoot), ctx), { cwd: ctx.repo, env: ctx.env, timeoutMs: (ctx.deadlineMs ?? taskDeadlineMs)(t.kind) })
  if (ran.timedOut) return outcomeOf(t.id, 'abandoned', 'past its deadline', rubricless)
  if (ran.exitCode !== 0) {
    // No answer from a failed process, whatever it wrote.
    fs.rmSync(t.answerFile, { force: true })
    return failedOutcome(t, ran, rubricless)
  }
  return fs.existsSync(t.answerFile) ? outcomeOf(t.id, 'answered', '', rubricless) : outcomeOf(t.id, 'unanswered', `pi wrote no answer file: ${tail(ran)}`, rubricless)
}
