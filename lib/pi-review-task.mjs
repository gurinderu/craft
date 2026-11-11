// One task of the CLI's step protocol run in pi (realm @nick/craft, nodes #453, #465): its own `pi -p` process, with
// no session saved and no context files, skills or prompt templates of its own, in the reviewed repository. Its
// message is the task's agent prompt body, if any, then the instruction to read the task's prompt file and write the
// answer file with pi's own write tool — pi has no schema output, and needs none: the binary validates the answer and
// hands an invalid one back for a retry. The login and the default model are the pi session's own; no key is passed.
// A process past its kind's deadline (lib/cli-review-deadline.mjs, the table the Claude Code driver races) is killed
// and abandoned; one that fails on the account's usage limit says so by the patterns every driver reads it with
// (lib/usage-limit.mjs), one that fails for want of a login stops the run, and any other failure is left unanswered.
import fs from 'node:fs'
import { rubricOf, skillLine, spellRoot } from './task-process-agents.mjs'
import { outcomeOf, runTaskProcess } from './task-process-task.mjs'

/** @typedef {import('./cli-review-step.mjs').Task} Task */
/** @typedef {import('./task-process-round.mjs').Outcome} Outcome */
/** @typedef {{ pi: string, pluginRoot: string, repo: string, models: import('./task-process-agents.mjs').ModelTable, env: NodeJS.ProcessEnv, deadlineMs?: (kind: string | undefined) => number }} TaskContext  pi: the pi command; deadlineMs: a task kind's deadline, by default the review engine's table */

// The tools a task needs: reading the change and the task files, git through bash, and writing its answer file.
const TOOLS = 'read,bash,write,grep,find,ls'

/**
 * The message a task's process is given: the agent's prompt body, if any, then the task itself, which reads its prompt
 * file and writes its answer file — the body's own gate, verdict and run record are not asked for — then where a skill
 * the prompt names is, since pi loads none of craft's. The literal `${CLAUDE_PLUGIN_ROOT}` is the package root.
 * @param {string} body @param {Task} t @param {string} root  the package root @param {string} [promptFile]  the prompt
 *   to read, by default the task's own @returns {string}
 */
export function taskMessage(body, t, root, promptFile = t.promptFile) {
  const task = `Read the file ${promptFile} and do exactly what it says: it is your whole task — run no gate, give no verdict and write no run record of your own beyond what it asks. When done, write your final answer as JSON matching the schema in ${t.schemaFile} to ${t.answerFile} with your write tool, and nothing else, then reply with the single word done.`
  const head = body ? `${body}\n\n---\n\nThe task below is your whole task: use the guidance above for how to review, but run no gate, give no verdict and write no run record of your own beyond what the task asks.\n\n` : ''
  return spellRoot(`${head}${task}\n\n${skillLine(root)}`, root)
}

/**
 * The prompt file pi reads: the task's own, or — where it names craft's files under `${CLAUDE_PLUGIN_ROOT}`, which
 * pi's read tool does not expand — a copy beside it with the root written in, as the Codex driver writes it into its
 * stdin. @param {Task} t @param {string} root @returns {string}
 */
function promptOf(t, root) {
  const text = fs.readFileSync(t.promptFile, 'utf8')
  const spelled = spellRoot(text, root)
  if (spelled === text) return t.promptFile
  const file = t.promptFile.replace(/(\.md)?$/, '.pi.md')
  fs.writeFileSync(file, spelled)
  return file
}

/** The `--model` arguments for a tier: none when the table leaves it to pi's own. @param {TaskContext['models']} table @param {string} tier @returns {string[]} */
const modelArgs = (table, tier) => {
  const model = table.get(tier)
  return model ? ['--model', model] : []
}

/** The `pi` arguments of a task. @param {Task} t @param {string} message @param {TaskContext} ctx @returns {string[]} */
export const piArgs = (t, message, ctx) => ['-p', '--no-session', '--no-context-files', '--no-skills', '--no-prompt-templates', '--tools', TOOLS, ...modelArgs(ctx.models, t.model), '--', message]

// What pi says when no provider is logged in (observed with pi 1.5.2): no task can answer until the human logs in.
const PI = { name: 'pi', login: /No API key found[^\n]*/, how: 'run `pi` and `/login`' }

/**
 * Run one task to its outcome (lib/task-process-task.mjs): answered when pi exited and left the answer file. A prompt
 * the driver cannot read leaves it unanswered.
 * @param {Task} t @param {TaskContext} ctx @returns {Promise<Outcome>}
 */
export async function runTask(t, ctx) {
  const { agent, body } = rubricOf(t, ctx)
  const rubricless = agent && !body ? agent : ''
  let prompt
  try { prompt = promptOf(t, ctx.pluginRoot) } catch (e) { return outcomeOf(t.id, 'unanswered', `its prompt could not be read: ${e instanceof Error ? e.message : String(e)}`, rubricless) }
  const command = { file: ctx.pi, args: piArgs(t, taskMessage(body, t, ctx.pluginRoot, prompt), ctx) }
  return runTaskProcess(t, command, ctx, { host: PI, rubricless, settle: () => fs.existsSync(t.answerFile) })
}
