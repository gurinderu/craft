// The Claude Code driver of the CLI's step protocol (src/cli-review.js; realm @nick/craft, node #453): the `craft`
// binary decides what a review needs and starts no agent, this driver runs the agents each step hands out and
// hands their answers back. It holds no review logic: what to ask, of which model, in which shape, and what the
// answers mean are all the binary's. The sandbox reads no file and spawns no process (#134), so a service agent runs
// the binary and returns its small JSON verbatim; the prompts, schemas and answers themselves travel as files in the
// run directory — each task's agent reads its prompt file and writes its answer file — so no model copies them.
// It deliberately imports neither run-logging.mjs nor repo-arg.mjs: it files no run record.
import { SERVICE_AGENT_TYPE, makeDefaultTypeFallback } from './service-agent.mjs'
import { normalizeArgs } from './workflow-args.mjs'

/** @typedef {{ id: string, label: string, model: string, promptFile: string, schemaFile: string, answerFile: string, agentType?: string }} Task */
/** @typedef {{ run: string, done: false, tasks: Task[] } | { run: string, done: true, report: string, verdict: string }} Step */
/** @typedef {{ repo: string, base: string, craftBin: string }} Options */
/** @typedef {(prompt: string, opts?: Record<string, unknown>) => Promise<unknown>} Agent */
/** @typedef {{ args: unknown, agent: Agent, parallel: <T>(thunks: Array<() => Promise<T>>) => Promise<Array<T | null>>, phase: (title: string) => void, log: (message: string) => void }} Sandbox */

// Lens, then verification, each asked at most three times (the binary's two retries): six rounds; two spare.
const MAX_ROUNDS = 8
// Where a development build of the binary sits in a craft checkout.
const RELEASE_BIN = 'cli/target/release/craft'

/** What a service step returns: the command's exit status and its output, copied whole. */
const RUN_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['exitCode', 'stdout', 'stderr'],
  properties: { exitCode: { type: 'integer' }, stdout: { type: 'string' }, stderr: { type: 'string' } },
}

/** `s` single-quoted for a shell. @param {string} s @returns {string} */
const shq = s => `'${s.replace(/'/g, `'\\''`)}'`
/** Whether `s` holds a control character. @param {string} s */
const hasControl = s => [...s].some(c => c.charCodeAt(0) < 0x20 || c.charCodeAt(0) === 0x7f)
/** An absolute path an agent can quote into a command, else null. @param {unknown} v @returns {string | null} */
const absolutePath = v => (typeof v === 'string' && v.startsWith('/') && !hasControl(v) ? v : null)

/** Why `a` names an option path that is not absolute, '' when none does. @param {Record<string, unknown>} a @returns {string} */
function badPath(a) {
  const bad = ['repo', 'craftBin', 'craftRoot'].find(k => a[k] != null && absolutePath(a[k]) === null)
  return bad ? `${bad}=${JSON.stringify(a[bad])} is not an absolute path` : ''
}

/** The base ref, '' when absent, null when it is no ref name. @param {unknown} v @returns {string | null} */
function refName(v) {
  if (v == null || v === '') return ''
  return typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9._/@^~-]{0,199}$/.test(v) ? v : null
}

/**
 * The run's options from `args`, or why they cannot be used.
 * @param {Record<string, unknown>} a @returns {{ options: Options } | { refused: string }}
 */
function readOptions(a) {
  const refused = badPath(a)
  if (refused) return { refused }
  const base = refName(a['base'])
  if (base === null) return { refused: `base=${JSON.stringify(a['base'])} is not a ref name` }
  const root = absolutePath(a['craftRoot'])
  const bin = absolutePath(a['craftBin'])
  // Unquoted on purpose when defaulted: the shell expands the plugin root the agent runs under.
  const craftBin = bin ? shq(bin) : root ? shq(`${root}/${RELEASE_BIN}`) : `"\${CLAUDE_PLUGIN_ROOT}/${RELEASE_BIN}"`
  return { options: { repo: absolutePath(a['repo']) ?? '', base, craftBin } }
}

/** The service step's instructions around `command`. @param {string} steps @returns {string} */
const servicePrompt = steps => `${steps}

Return {exitCode, stdout, stderr}: the last command's exit status, and its stdout and stderr each copied VERBATIM and WHOLE. stdout is one JSON value the caller parses: never summarize, reformat, pretty-print or shorten it. Run nothing else.`

/** @param {Options} o @returns {string} */
function startPrompt(o) {
  const cmd = `${o.craftBin} review start --cwd ${o.repo ? shq(o.repo) : '.'}${o.base ? ` --base ${shq(o.base)}` : ''}`
  return servicePrompt(`Run exactly this one command:\n\n${cmd}`)
}

/** @param {Options} o @param {string} run @returns {string} */
const submitPrompt = (o, run) => servicePrompt(`Run exactly this one command:\n\n${o.craftBin} review submit --run ${shq(run)}`)

/** What a task's agent is told: its prompt, schema and answer are files it reads and writes itself. @param {Task} t @returns {string} */
const taskPrompt = t => `Read the file ${t.promptFile} and do exactly what it says. When done, write your final answer as JSON matching the schema in ${t.schemaFile} to ${t.answerFile} (create the directory if needed), then reply with the single word done.`

/** @param {unknown} v @returns {v is Record<string, unknown>} */
const isObject = v => !!v && typeof v === 'object' && !Array.isArray(v)

/** @param {unknown} t @returns {t is Task} */
function isTask(t) {
  if (!isObject(t)) return false
  const s = /** @param {string} k */ k => typeof t[k] === 'string'
  const file = /** @param {string} k */ k => absolutePath(t[k]) !== null
  return s('id') && s('label') && s('model') && file('promptFile') && file('schemaFile') && file('answerFile') && (t['agentType'] === undefined || s('agentType'))
}

/**
 * The command's output from a service answer, or why there is none.
 * @param {unknown} got @returns {{ stdout: string } | { error: string }}
 */
function commandOutput(got) {
  if (!isObject(got) || typeof got['stdout'] !== 'string') return { error: 'the service agent returned no command output' }
  if (got['exitCode'] !== 0) return { error: `the command exited ${String(got['exitCode'])}: ${String(got['stderr'] ?? '').trim().slice(0, 400)}` }
  return { stdout: got['stdout'] }
}

/**
 * The step the binary printed, or why it cannot be read.
 * @param {unknown} got @returns {{ step: Step } | { error: string }}
 */
function readStep(got) {
  const out = commandOutput(got)
  if ('error' in out) return out
  /** @type {unknown} */
  let v
  try { v = JSON.parse(out.stdout) } catch { return { error: `the command printed no JSON: ${out.stdout.slice(0, 200)}` } }
  if (!isObject(v) || absolutePath(v['run']) === null) return { error: 'the step names no run directory' }
  return v['done'] === true ? finishedStep(v) : pendingStep(v)
}

/** @param {Record<string, unknown>} v  a step with a run directory @returns {{ step: Step } | { error: string }} */
function finishedStep(v) {
  const report = absolutePath(v['report'])
  const verdict = v['verdict']
  if (report === null || typeof verdict !== 'string') return { error: 'a finished step names no report or verdict' }
  return { step: { run: /** @type {string} */ (v['run']), done: true, report, verdict } }
}

/** @param {Record<string, unknown>} v  a step with a run directory @returns {{ step: Step } | { error: string }} */
function pendingStep(v) {
  const tasks = v['tasks']
  if (v['done'] !== false || !Array.isArray(tasks) || !tasks.length || !tasks.every(isTask)) return { error: 'the step carries no well-formed tasks' }
  return { step: { run: /** @type {string} */ (v['run']), done: false, tasks } }
}

/**
 * The whole loop: start, then rounds of agents and submits until the binary is done, then its verdict and report path.
 * Fails closed: a step that cannot be read ends the run INCOMPLETE, saying where; a budget throw propagates.
 * @param {Sandbox} sb @param {string} craftVersion @returns {Promise<string>}
 */
export async function runCliReview(sb, craftVersion) {
  const say = sb.log
  const enter = sb.phase
  const read = readOptions(normalizeArgs(sb.args, say))
  if ('refused' in read) return `INCOMPLETE — cli-review: ${read.refused}. Nothing ran.`
  const o = read.options
  const service = makeDefaultTypeFallback((/** @type {string} */ p, /** @type {Record<string, unknown>} */ opts) => sb.agent(p, opts), say)
  /** @param {string} label @param {string} title  its phase @param {string} prompt */
  const serve = (label, title, prompt) => service.run(prompt, { label, phase: title, schema: RUN_SCHEMA, model: 'haiku', effort: 'low', agentType: SERVICE_AGENT_TYPE })
  say(`cli-review ${craftVersion}: ${o.craftBin} over ${o.repo || 'the session checkout'}`)
  enter('Start')
  let read1 = readStep(await serve('step:start', 'Start', startPrompt(o)))
  for (let round = 1; ; round++) {
    if ('error' in read1) return `INCOMPLETE — cli-review stopped at round ${round}: ${read1.error}.`
    const step = read1.step
    if (step.done) return finish(step)
    if (round > MAX_ROUNDS) return `INCOMPLETE — cli-review gave up after ${MAX_ROUNDS} rounds; the run is in ${step.run}.`
    enter('Agents')
    say(`round ${round}: ${step.tasks.length} task(s) — ${step.tasks.map(t => t.label).join(', ')}`)
    // No schema: the binary checks each answer file. A dead agent leaves no file, which the binary asks for again.
    await sb.parallel(step.tasks.map(t => () => sb.agent(taskPrompt(t), { label: t.label, phase: 'Agents', model: t.model, agentType: t.agentType })))
    enter('Submit')
    read1 = readStep(await serve(`step:submit:${round}`, 'Submit', submitPrompt(o, step.run)))
  }
}

/**
 * The finished run: the verdict the binary printed and where its report is. No model copies the report: the caller
 * reads the file.
 * @param {{ run: string, report: string, verdict: string }} step @returns {string}
 */
function finish(step) {
  return `Verdict: ${step.verdict} (run ${step.run})\n\nThe report is ${step.report} — read that file for the findings.`
}
