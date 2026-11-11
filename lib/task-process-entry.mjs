// The command of a process-per-task review driver — Codex's (lib/codex-review.mjs) and pi's (lib/pi-review.mjs; realm
// @nick/craft, nodes #453, #491): the review's own arguments, taken as the Claude Code Workflow takes them (`key=value`
// words, or one JSON object) and read and refused by the same rules (lib/cli-review-options.mjs,
// lib/cli-review-keys.mjs), beside the host's own; the `craft` binary, the one released with this plugin version
// (lib/craft-bin.mjs) unless craftBin= names one; then the loop (lib/task-process-run.mjs), each task through the
// host's adapter. A refused argument and a run the binary never finished are filed (lib/task-process-record.mjs).
// Progress goes to stderr, the answer — the `## Verdict` block — to stdout.
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { VALUE_REFUSED_CLASS, argumentProblem, viaName } from './cli-review-keys.mjs'
import { readOptions } from './cli-review-options.mjs'
import { absolutePath } from './cli-review-step.mjs'
import { stoppedAnswer } from './cli-review-verdict.mjs'
import { argumentRefusal } from './run-record.mjs'
import { normalizeJsonArgs, normalizeKeyValueArgs } from './workflow-args.mjs'
import { shellWord } from './plugin-script.mjs'
import { ensure } from './craft-bin.mjs'
import { taskProcessRecorder } from './task-process-record.mjs'
import { driveReview } from './task-process-run.mjs'
import { outputLines } from './script-main.mjs'

/** @typedef {import('./cli-review-options.mjs').Options} Options */
/** @typedef {{ cwd?: string, store?: string, ensureBin?: typeof ensure, deadlineMs?: (kind: string | undefined) => number }} Deps  injected by tests; store: the run store */
/** @typedef {{ concurrency: number, models: Map<string, string> }} Own  the host's own arguments */
/** @typedef {{ pluginRoot: string, repo: string, env: NodeJS.ProcessEnv, deadlineMs?: (kind: string | undefined) => number }} TaskPlace  where and how a task's process runs */
/** @typedef {{ name: string, script: string, version: () => string, own: (a: Record<string, unknown>, env: NodeJS.ProcessEnv) => Own | { refused: string }, runTask: (own: Own, at: TaskPlace) => import('./task-process-round.mjs').RunTask }} Host  name: as the log and the notes name it; script: this driver's file in lib/ */

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DEFAULT_CONCURRENCY = 4
const MAX_CONCURRENCY = 16

/** The arguments as one text: a lone JSON object as it is, else each word, a spaced value quoted. @param {string[]} argv */
export function argText(argv) {
  if (argv.length === 1 && String(argv[0]).trim().startsWith('{')) return String(argv[0])
  return argv.map(w => (/\s/.test(w) && /^[\w-]+=[^"]*$/.test(w) ? w.replace('=', '="') + '"' : w)).join(' ')
}

/**
 * The command line as the options object the review's reader takes. Both are the documented forms here — `key=value`
 * words, or one JSON object argument — so neither is warned about as a string; a malformed one still is.
 * @param {string[]} argv @param {(line: string) => void} log @returns {Record<string, unknown>}
 */
export function argvOptions(argv, log) {
  const text = argText(argv).trim()
  if (!text) return {}
  if (!text.startsWith('{')) return normalizeKeyValueArgs(text, log, true)
  try {
    const parsed = JSON.parse(text)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed
  } catch { /* said below, in the reader's own words */ }
  return normalizeJsonArgs(text, log)
}

/**
 * `concurrency=` taken out of `a`, else the environment's `envKey`, else the default; or why it cannot be used.
 * @param {Record<string, unknown>} a @param {NodeJS.ProcessEnv} env @param {string} envKey
 * @returns {{ concurrency: number } | { refused: string }}
 */
export function concurrencyOf(a, env, envKey) {
  const given = a['concurrency'] ?? env[envKey] ?? DEFAULT_CONCURRENCY
  delete a['concurrency']
  const concurrency = Number(given)
  return Number.isInteger(concurrency) && concurrency >= 1 && concurrency <= MAX_CONCURRENCY ? { concurrency } : { refused: `concurrency=${JSON.stringify(given)} is not a whole number from 1 to ${MAX_CONCURRENCY}` }
}

/**
 * The review's options and the host's own, or the refusal with its class.
 * @param {string[]} argv @param {(a: Record<string, unknown>) => Own | { refused: string }} own @param {(line: string) => void} log
 * @returns {{ o: Options, driver: Own } | { refused: string, cls: string, a: Record<string, unknown> }}
 */
function readArgs(argv, own, log) {
  const a = { ...argvOptions(argv, log) }
  const driver = own(a)
  if ('refused' in driver) return { refused: `review: ${driver.refused}. Nothing ran.`, cls: VALUE_REFUSED_CLASS, a }
  const problem = argumentProblem(a, readOptions)
  if (problem) return { refused: problem.why, cls: problem.cls, a }
  return { o: /** @type {{ options: Options }} */ (readOptions(a)).options, driver }
}

/**
 * The binary as a shell word: the one craftBin= gave, else this version's released one, fetched once.
 * @param {string | null} given @param {string} version @param {NodeJS.ProcessEnv} env @param {Deps} deps
 * @returns {Promise<{ bin: string } | { error: string }>}
 */
async function binaryOf(given, version, env, deps) {
  if (given !== null) return { bin: given }
  try {
    return { bin: shellWord(await (deps.ensureBin ?? ensure)({ version, repo: 'gurinderu/craft', token: env['GITHUB_TOKEN'] || env['GH_TOKEN'] || '' })) }
  } catch (e) {
    return { error: `review could not get the craft binary ${version}: ${e instanceof Error ? e.message : String(e)}. Pass craftBin=<absolute path> of a build (\`cargo build --release\` in cli/).` }
  }
}

/** Each part that says something, a blank line between. @param {string[]} parts */
const joined = parts => parts.filter(Boolean).join('\n\n')

/** @typedef {ReturnType<typeof import('./task-process-record.mjs').taskProcessRecorder>} Recorder */

/**
 * A refused argument: its record the engines' refusal (lib/run-record.mjs, argumentRefusal) with the refusal's class in
 * `notRun`, keyed to the repo given — the session's checkout when `repo` is itself the refused argument.
 * @param {{ refused: string, cls: string, a: Record<string, unknown> }} r @param {string} version
 * @param {(o: { repo: string, depth: string, strict: boolean, via: string }) => Recorder} recorderOf @returns {Promise<string>}
 */
async function refuse({ refused, cls, a }, version, recorderOf) {
  const via = viaName(a['_via']) ?? ''
  const recorder = recorderOf({ repo: absolutePath(a['repo']) ?? '', depth: 'full', strict: false, via })
  await recorder.refusal(argumentRefusal({ engine: 'review', why: refused, notRun: [cls], craftVersion: version, outputTokens: 0, via }).record)
  return joined([stoppedAnswer(refused), recorder.notes()])
}

/**
 * Run the review in `host` on the command line `argv`: a refused argument filed and answered, else the binary got and
 * the loop run; a binary that cannot be got is a run the binary never finished, filed INCOMPLETE.
 * @param {Host} host @param {string[]} argv @param {NodeJS.ProcessEnv} env @param {Deps} deps
 * @returns {Promise<import('./script-main.mjs').ScriptResult>}
 */
export async function runDriver(host, argv, env, deps) {
  const lines = outputLines()
  const log = /** @param {string} line */ line => { lines.stderr.push(line) }
  /** @param {number} exitCode @param {string} answer */
  const said = (exitCode, answer) => ({ exitCode, stdout: [...lines.stdout, answer], stderr: lines.stderr })
  const version = host.version()
  const cwd = deps.cwd || process.cwd()
  const driver = /** @param {string} run */ run => `this driver again, \`node ${shellWord(path.join(PLUGIN_ROOT, 'lib', host.script))} run=${shellWord(run)}\``
  /** @param {{ repo: string, depth: string, strict: boolean, via: string }} o */
  const recorderOf = o => taskProcessRecorder({ craftVersion: version, ...o, store: deps.store ?? '', cwd, log, driver })
  const args = readArgs(argv, a => host.own(a, env), log)
  if ('refused' in args) return said(2, await refuse(args, version, recorderOf))
  const { o } = args
  const recorder = recorderOf({ repo: o.repo, depth: o.depth || 'full', strict: o.strict, via: o.via })
  const got = await binaryOf(o.craftBin, version, env, deps)
  if ('error' in got) {
    const unfiled = await recorder.unfinished(!!o.run, { verdict: 'INCOMPLETE', notRun: ['the craft binary did not finish the run'] })
    return said(1, joined([stoppedAnswer(got.error), unfiled, recorder.notes()]))
  }
  const repo = o.repo || cwd
  log(`review ${version} in ${host.name}: ${got.bin} over ${repo}, up to ${args.driver.concurrency} task(s) at once`)
  // The binary's prompts name review rules under CLAUDE_PLUGIN_ROOT; this plugin's root holds them.
  const taskEnv = { ...env, CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT }
  const runTask = host.runTask(args.driver, { pluginRoot: PLUGIN_ROOT, repo, env: taskEnv, ...(deps.deadlineMs ? { deadlineMs: deps.deadlineMs } : {}) })
  const answer = await driveReview(o, { bin: got.bin, version, pluginRoot: PLUGIN_ROOT, repo, env: taskEnv, driver, recorder, log, concurrency: args.driver.concurrency, host: host.name, runTask })
  return said(answer.finished ? 0 : 1, answer.answer)
}
