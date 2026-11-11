// The craft review in Codex (realm @nick/craft, node #491, on the route #454 chose): the craft:codex-review skill
// has the Codex session run this one command and relay what it prints. It takes the review's own arguments as the
// Claude Code Workflow takes them (`key=value` words, or one JSON object), read and refused by the same rules
// (lib/cli-review-options.mjs, lib/cli-review-keys.mjs), plus two of its own: `concurrency=<n>` (task processes at
// once, default 4; env CRAFT_CODEX_CONCURRENCY) and `codexModels=<model>` or `<tier>=<model>,…` (the Codex model for
// the binary's Claude tiers, default the session's own; env CRAFT_CODEX_MODELS). The `craft` binary is the one
// released with this plugin version (lib/craft-bin.mjs) unless craftBin= names one, and `codex` the one on PATH
// unless CRAFT_CODEX_BIN names one. Progress goes to stderr, the answer — the `## Verdict` block — to stdout.
//
// Run: node <plugin root>/lib/codex-review.mjs [key=value ...]
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { argumentProblem } from './cli-review-keys.mjs'
import { readOptions } from './cli-review-options.mjs'
import { stoppedAnswer } from './cli-review-verdict.mjs'
import { normalizeArgs } from './workflow-args.mjs'
import { shellWord } from './plugin-script.mjs'
import { ensure } from './craft-bin.mjs'
import { modelTable } from './codex-review-agents.mjs'
import { driveReview } from './codex-review-run.mjs'
import { outputLines, runIfMain } from './script-main.mjs'

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DEFAULT_CONCURRENCY = 4
const MAX_CONCURRENCY = 16

/** The arguments as one text normalizeArgs reads: a lone JSON object as it is, else each word, a spaced value quoted. @param {string[]} argv */
export function argText(argv) {
  if (argv.length === 1 && String(argv[0]).trim().startsWith('{')) return String(argv[0])
  return argv.map(w => (/\s/.test(w) && /^[\w-]+=[^"]*$/.test(w) ? w.replace('=', '="') + '"' : w)).join(' ')
}

/**
 * The driver's own arguments, taken out of `a`, with the environment's defaults; or why one cannot be used.
 * @param {Record<string, unknown>} a @param {NodeJS.ProcessEnv} env
 * @returns {{ concurrency: number, models: Map<string, string> } | { refused: string }}
 */
export function driverOptions(a, env) {
  const given = a['concurrency'] ?? env['CRAFT_CODEX_CONCURRENCY'] ?? DEFAULT_CONCURRENCY
  delete a['concurrency']
  const concurrency = Number(given)
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > MAX_CONCURRENCY) return { refused: `concurrency=${JSON.stringify(given)} is not a whole number from 1 to ${MAX_CONCURRENCY}` }
  const spec = a['codexModels'] ?? env['CRAFT_CODEX_MODELS'] ?? ''
  delete a['codexModels']
  const read = modelTable(String(spec))
  return 'refused' in read ? read : { concurrency, models: read.table }
}

/** This plugin's version, from the Codex manifest beside this script. @returns {string} */
const pluginVersion = () => String(JSON.parse(fs.readFileSync(path.join(PLUGIN_ROOT, '.codex-plugin', 'plugin.json'), 'utf8')).version)

/** How to run this driver again on a run. @param {string} run */
const driverHint = run => `this driver again, \`node ${shellWord(path.join(PLUGIN_ROOT, 'lib', 'codex-review.mjs'))} run=${shellWord(run)}\``

/** @typedef {{ cwd?: string, ensureBin?: typeof ensure, deadlineMs?: (kind: string | undefined) => number }} Deps  injected by tests */

/**
 * The review's options and the driver's own, or the answer refusing them.
 * @param {string[]} argv @param {NodeJS.ProcessEnv} env @param {(line: string) => void} log
 * @returns {{ o: import('./cli-review-options.mjs').Options, driver: { concurrency: number, models: Map<string, string> } } | { refused: string }}
 */
function readArgs(argv, env, log) {
  const a = { ...normalizeArgs(argText(argv), log) }
  const driver = driverOptions(a, env)
  if ('refused' in driver) return { refused: `review: ${driver.refused}. Nothing ran.` }
  const problem = argumentProblem(a, readOptions)
  if (problem) return { refused: problem.why }
  return { o: /** @type {{ options: import('./cli-review-options.mjs').Options }} */ (readOptions(a)).options, driver }
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

/**
 * @param {string[]} argv @param {NodeJS.ProcessEnv} env @param {Deps} [deps]
 * @returns {Promise<import('./script-main.mjs').ScriptResult>}
 */
export async function run(argv, env = process.env, deps = {}) {
  const lines = outputLines()
  const log = /** @param {string} line */ line => { lines.stderr.push(line) }
  /** @param {number} exitCode @param {string} answer */
  const said = (exitCode, answer) => ({ exitCode, stdout: [...lines.stdout, answer], stderr: lines.stderr })
  const args = readArgs(argv, env, log)
  if ('refused' in args) return said(2, stoppedAnswer(args.refused))
  const { o, driver } = args
  const version = pluginVersion()
  const got = await binaryOf(o.craftBin, version, env, deps)
  if ('error' in got) return said(1, stoppedAnswer(got.error))
  const repo = o.repo || deps.cwd || process.cwd()
  log(`review ${version} in Codex: ${got.bin} over ${repo}, up to ${driver.concurrency} task(s) at once`)
  // The binary's prompts name review rules under CLAUDE_PLUGIN_ROOT; Codex's cached plugin root holds them.
  const ctx = { ...driver, bin: got.bin, version, pluginRoot: PLUGIN_ROOT, driver: driverHint, log, repo, codex: env['CRAFT_CODEX_BIN'] || 'codex', ...(deps.deadlineMs ? { deadlineMs: deps.deadlineMs } : {}), env: { ...env, CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT } }
  const answer = await driveReview(o, ctx)
  return said(answer.finished ? 0 : 1, answer.answer)
}

await runIfMain(import.meta.url, run)
