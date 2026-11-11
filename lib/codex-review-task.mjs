// One task of the CLI's step protocol run in Codex (realm @nick/craft, node #491): its own `codex exec` process,
// ephemeral and read-only, in the reviewed repository, the prompt on stdin, the answer written by Codex itself to the
// task's answer file in the shape `--output-schema` holds it to (a strict copy where the binary's schema is not:
// lib/codex-review-schema.mjs). The login is the Codex session's own; no key is passed. A process past its kind's
// deadline (lib/cli-review-deadline.mjs, the same table the Claude Code driver races) is killed and abandoned; one
// that fails on the account's usage limit says so by the patterns every driver reads it with (lib/usage-limit.mjs).
import fs from 'node:fs'
import path from 'node:path'
import { taskDeadlineMs } from './cli-review-deadline.mjs'
import { usageLimitText } from './usage-limit.mjs'
import { dropOptionalNulls, strictSchema } from './codex-review-schema.mjs'
import { modelArgs, rubricOf } from './codex-review-agents.mjs'
import { runProcess } from './codex-review-spawn.mjs'

/** @typedef {import('./cli-review-step.mjs').Task} Task */
/** @typedef {{ codex: string, pluginRoot: string, repo: string, models: import('./codex-review-agents.mjs').ModelTable, env: NodeJS.ProcessEnv, deadlineMs?: (kind: string | undefined) => number }} TaskContext  deadlineMs: a task kind's deadline, by default the review engine's table */
/** @typedef {{ id: string, outcome: 'answered' | 'abandoned' | 'failed' | 'limit', why: string, rubricless: string }} Outcome  why: what a failure said; rubricless: the agent the task named whose prompt body was not found ('' none) */

/**
 * What the task's process reads on stdin: the agent's prompt body, if any, then the task's own prompt, which is the
 * whole task — the body's own gate, verdict and run record are not asked for.
 * @param {string} body @param {string} prompt @returns {string}
 */
export function taskInput(body, prompt) {
  const task = `${prompt.trim()}\n\nYour final message is your answer: the JSON the output schema describes, and nothing else.\n`
  if (!body) return task
  return `${body}\n\n---\n\nThe task below is your whole task: use the guidance above for how to review, but run no gate, give no verdict and write no run record of your own beyond what the task asks.\n\n${task}`
}

/**
 * The schema file Codex is given: the task's own when it is strict already, else a strict copy beside it.
 * @param {Task} t @returns {{ file: string, schema: unknown, copied: boolean }}
 */
function codexSchema(t) {
  const schema = JSON.parse(fs.readFileSync(t.schemaFile, 'utf8'))
  const strict = strictSchema(schema)
  if (JSON.stringify(strict) === JSON.stringify(schema)) return { file: t.schemaFile, schema, copied: false }
  const file = t.schemaFile.replace(/(\.schema)?\.json$/, '.codex.schema.json')
  fs.writeFileSync(file, `${JSON.stringify(strict, null, 2)}\n`)
  return { file, schema, copied: true }
}

/** The answer Codex wrote, its optional nulls dropped; false when there is none to read. @param {string} file @param {unknown} schema */
function settleAnswer(file, schema) {
  let text
  try { text = fs.readFileSync(file, 'utf8') } catch { return false }
  try {
    fs.writeFileSync(file, `${JSON.stringify(dropOptionalNulls(JSON.parse(text), schema))}\n`)
  } catch { /* not JSON: left for the binary to refuse in its own words */ }
  return true
}

/** The `codex exec` arguments of a task. @param {Task} t @param {string} schemaFile @param {TaskContext} ctx @returns {string[]} */
export const codexArgs = (t, schemaFile, ctx) => ['exec', '--ephemeral', '-s', 'read-only', '--output-schema', schemaFile, '-o', t.answerFile, '-C', ctx.repo, ...modelArgs(ctx.models, t.model), '-']

/** @param {string} id @param {Outcome['outcome']} outcome @param {string} why @param {string} rubricless @returns {Outcome} */
const outcomeOf = (id, outcome, why, rubricless) => ({ id, outcome, why, rubricless })

/**
 * The task's schema for Codex and its stdin, or why they cannot be read.
 * @param {Task} t @param {string} body @returns {{ schema: { file: string, schema: unknown }, input: string } | { error: string }}
 */
function prepare(t, body) {
  try {
    return { schema: codexSchema(t), input: taskInput(body, fs.readFileSync(t.promptFile, 'utf8')) }
  } catch (e) {
    return { error: `its prompt or schema could not be read: ${e instanceof Error ? e.message : String(e)}` }
  }
}

/**
 * Run one task to its outcome. A schema or prompt the driver cannot read fails the task, as a dead agent.
 * @param {Task} t @param {TaskContext} ctx @returns {Promise<Outcome>}
 */
export async function runTask(t, ctx) {
  const { agent, body } = rubricOf(t, ctx)
  const rubricless = agent && !body ? agent : ''
  const prepared = prepare(t, body)
  if ('error' in prepared) return outcomeOf(t.id, 'failed', prepared.error, rubricless)
  const { schema, input } = prepared
  fs.rmSync(t.answerFile, { force: true })
  fs.mkdirSync(path.dirname(t.answerFile), { recursive: true })
  const ran = await runProcess(ctx.codex, codexArgs(t, schema.file, ctx), { cwd: ctx.repo, env: ctx.env, stdin: input, timeoutMs: (ctx.deadlineMs ?? taskDeadlineMs)(t.kind) })
  if (ran.timedOut) return outcomeOf(t.id, 'abandoned', 'past its deadline', rubricless)
  if (ran.exitCode !== 0) {
    const limit = usageLimitText(`${ran.stderr}\n${ran.stdout}`)
    return outcomeOf(t.id, limit ? 'limit' : 'failed', limit || `codex exited ${ran.exitCode}: ${ran.stderr.trim().split('\n').slice(-3).join(' ').slice(0, 300)}`, rubricless)
  }
  return settleAnswer(t.answerFile, schema.schema) ? outcomeOf(t.id, 'answered', '', rubricless) : outcomeOf(t.id, 'failed', 'codex wrote no answer file', rubricless)
}
