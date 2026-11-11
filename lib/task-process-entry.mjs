// The command line of a process-per-task review driver (lib/task-process-run.mjs; realm @nick/craft, node #453): the
// review's own arguments, taken as the Claude Code Workflow takes them (`key=value` words, or one JSON object) and
// read and refused by the same rules (lib/cli-review-options.mjs, lib/cli-review-keys.mjs), beside the driver's own;
// how many task processes run at once; and the `craft` binary, the one released with this plugin version
// (lib/craft-bin.mjs) unless craftBin= names one.
import { argumentProblem } from './cli-review-keys.mjs'
import { readOptions } from './cli-review-options.mjs'
import { normalizeArgs } from './workflow-args.mjs'
import { shellWord } from './plugin-script.mjs'
import { ensure } from './craft-bin.mjs'

/** @typedef {import('./cli-review-options.mjs').Options} Options */

export const DEFAULT_CONCURRENCY = 4
const MAX_CONCURRENCY = 16

/** The arguments as one text normalizeArgs reads: a lone JSON object as it is, else each word, a spaced value quoted. @param {string[]} argv */
export function argText(argv) {
  if (argv.length === 1 && String(argv[0]).trim().startsWith('{')) return String(argv[0])
  return argv.map(w => (/\s/.test(w) && /^[\w-]+=[^"]*$/.test(w) ? w.replace('=', '="') + '"' : w)).join(' ')
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
 * The review's options and the driver's own (`own` takes its keys out of the arguments), or the refusal.
 * @template D @param {string[]} argv @param {(a: Record<string, unknown>) => D | { refused: string }} own
 * @param {(line: string) => void} log @returns {{ o: Options, driver: D } | { refused: string }}
 */
export function readArgs(argv, own, log) {
  const a = { ...normalizeArgs(argText(argv), log) }
  const driver = own(a)
  if (driver && typeof driver === 'object' && 'refused' in driver) return { refused: `review: ${driver.refused}. Nothing ran.` }
  const problem = argumentProblem(a, readOptions)
  if (problem) return { refused: problem.why }
  return { o: /** @type {{ options: Options }} */ (readOptions(a)).options, driver: /** @type {D} */ (driver) }
}

/**
 * The binary as a shell word: the one craftBin= gave, else this version's released one, fetched once.
 * @param {string | null} given @param {string} version @param {NodeJS.ProcessEnv} env @param {typeof ensure} [ensureBin]
 * @returns {Promise<{ bin: string } | { error: string }>}
 */
export async function binaryOf(given, version, env, ensureBin = ensure) {
  if (given !== null) return { bin: given }
  try {
    return { bin: shellWord(await ensureBin({ version, repo: 'gurinderu/craft', token: env['GITHUB_TOKEN'] || env['GH_TOKEN'] || '' })) }
  } catch (e) {
    return { error: `review could not get the craft binary ${version}: ${e instanceof Error ? e.message : String(e)}. Pass craftBin=<absolute path> of a build (\`cargo build --release\` in cli/).` }
  }
}
