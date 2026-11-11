// The craft review in pi (realm @nick/craft, nodes #453, #465): the craft-review skill of craft's pi package
// (integrations/pi/skills) has the pi session run this one command and relay what it prints. It takes the review's
// own arguments as the Claude Code Workflow takes them (lib/task-process-entry.mjs), plus two of its own:
// `concurrency=<n>` (task processes at once, default 4; env CRAFT_PI_CONCURRENCY) and `piModels=<model>` or
// `<tier>=<model>,…` (the pi model for the binary's Claude tiers, default pi's own configured model; env
// CRAFT_PI_MODELS). Each task is its own `pi -p` (lib/pi-review-task.mjs), `pi` the one on PATH unless CRAFT_PI_BIN
// names one. Progress goes to stderr, the answer — the `## Verdict` block — to stdout.
//
// Run: node <package root>/lib/pi-review.mjs [key=value ...]
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { stoppedAnswer } from './cli-review-verdict.mjs'
import { shellWord } from './plugin-script.mjs'
import { binaryOf, concurrencyOf, readArgs } from './task-process-entry.mjs'
import { modelTable } from './task-process-agents.mjs'
import { driveReview } from './task-process-run.mjs'
import { runTask } from './pi-review-task.mjs'
import { outputLines, runIfMain } from './script-main.mjs'

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
// A pi model as `--model` takes it: a pattern or an ID, `provider/id`, an optional `:<thinking>`.
const PI_MODEL = /^[\w.:/@*-]{1,120}$/

/**
 * The driver's own arguments, taken out of `a`, with the environment's defaults; or why one cannot be used.
 * @param {Record<string, unknown>} a @param {NodeJS.ProcessEnv} env
 * @returns {{ concurrency: number, models: Map<string, string> } | { refused: string }}
 */
export function piOptions(a, env) {
  const lanes = concurrencyOf(a, env, 'CRAFT_PI_CONCURRENCY')
  const spec = a['piModels'] ?? env['CRAFT_PI_MODELS'] ?? ''
  delete a['piModels']
  if ('refused' in lanes) return lanes
  const read = modelTable(String(spec), 'piModels', PI_MODEL)
  return 'refused' in read ? read : { concurrency: lanes.concurrency, models: read.table }
}

/** This package's version: the release the checkout carries (release-please's manifest). @returns {string} */
const packageVersion = () => String(JSON.parse(fs.readFileSync(path.join(PLUGIN_ROOT, '.release-please-manifest.json'), 'utf8'))['.'])

/** How to run this driver again on a run. @param {string} run */
const driverHint = run => `this driver again, \`node ${shellWord(path.join(PLUGIN_ROOT, 'lib', 'pi-review.mjs'))} run=${shellWord(run)}\``

/** @typedef {{ cwd?: string, ensureBin?: typeof import('./craft-bin.mjs').ensure, deadlineMs?: (kind: string | undefined) => number }} Deps  injected by tests */

/**
 * @param {string[]} argv @param {NodeJS.ProcessEnv} env @param {Deps} [deps]
 * @returns {Promise<import('./script-main.mjs').ScriptResult>}
 */
export async function run(argv, env = process.env, deps = {}) {
  const lines = outputLines()
  const log = /** @param {string} line */ line => { lines.stderr.push(line) }
  /** @param {number} exitCode @param {string} answer */
  const said = (exitCode, answer) => ({ exitCode, stdout: [...lines.stdout, answer], stderr: lines.stderr })
  const args = readArgs(argv, a => piOptions(a, env), log)
  if ('refused' in args) return said(2, stoppedAnswer(args.refused))
  const { o, driver } = args
  const version = packageVersion()
  const got = await binaryOf(o.craftBin, version, env, deps.ensureBin)
  if ('error' in got) return said(1, stoppedAnswer(got.error))
  const repo = o.repo || deps.cwd || process.cwd()
  log(`review ${version} in pi: ${got.bin} over ${repo}, up to ${driver.concurrency} task(s) at once`)
  // The binary's prompts name review rules under CLAUDE_PLUGIN_ROOT; this package's checkout holds them.
  const taskEnv = { ...env, CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT }
  const task = { pi: env['CRAFT_PI_BIN'] || 'pi', pluginRoot: PLUGIN_ROOT, repo, models: driver.models, env: taskEnv, ...(deps.deadlineMs ? { deadlineMs: deps.deadlineMs } : {}) }
  const ctx = { bin: got.bin, version, pluginRoot: PLUGIN_ROOT, repo, env: taskEnv, driver: driverHint, log, concurrency: driver.concurrency, host: 'pi', runTask: (/** @type {import('./cli-review-step.mjs').Task} */ t) => runTask(t, task) }
  const answer = await driveReview(o, ctx)
  return said(answer.finished ? 0 : 1, answer.answer)
}

await runIfMain(import.meta.url, run)
