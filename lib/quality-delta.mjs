// How quality moved between a PR's base and head, as Markdown for the job summary — a signal for review,
// never a gate (realm @nick/craft, #147): the CLI exits 0 whatever it measured, and a metric it could
// not measure is said to be so, never shown as 0. Measuring lives in lib/quality-measure.mjs, the
// Markdown in lib/quality-render.mjs.
//   node lib/quality-delta.mjs --base <checkout> --head <checkout>
import path from 'node:path'
import { measureCheckout } from './quality-measure.mjs'
import { renderSummary } from './quality-render.mjs'
import { exitWith, invokedDirectly, scriptOutput } from './script-run.mjs'

/** @param {string[]} argv @returns {{ base: string, head: string } | null} */
export function parseArgs(argv) {
  /** @type {Record<string, string>} */
  const opts = {}
  for (let i = 0; i < argv.length; i += 2) {
    const k = argv[i], v = argv[i + 1]
    if ((k !== '--base' && k !== '--head') || v === undefined) return null
    opts[k.slice(2)] = v
  }
  const base = opts['base'], head = opts['head']
  return base && head ? { base: path.resolve(base), head: path.resolve(head) } : null
}

/**
 * @param {string[]} argv
 * @param {import('./script-run.mjs').ScriptEnv & { now?: () => number, measure?: typeof measureCheckout }} [env]
 *   the clock and the measurement (which launches each checkout's tools), for a test to replace
 * @returns {Promise<import('./script-run.mjs').ScriptResult>} exit code: 0 after any measurement, 2 on bad usage
 */
export async function run(argv, env = {}) {
  const io = scriptOutput(env)
  const { now = Date.now, measure = measureCheckout } = env
  const args = parseArgs(argv)
  if (!args) {
    io.err('usage: node lib/quality-delta.mjs --base <checkout> --head <checkout>')
    return io.result(2)
  }
  const started = now()
  const [base, head] = [await measure(args.base), await measure(args.head)]
  io.write('stdout', renderSummary(base, head, { seconds: Math.round((now() - started) / 1000) }))
  return io.result(0)
}

if (invokedDirectly(import.meta.url)) exitWith(run(process.argv.slice(2), { echo: true }))
