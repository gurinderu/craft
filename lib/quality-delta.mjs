// How quality moved between a PR's base and head, as Markdown for the job summary — a signal for review,
// never a gate (realm @nick/craft, #147): the CLI exits 0 whatever it measured, and a metric it could
// not measure is said to be so, never shown as 0. Measuring lives in lib/quality-measure.mjs, the
// Markdown in lib/quality-render.mjs.
//   node lib/quality-delta.mjs --base <checkout> --head <checkout>
import path from 'node:path'
import { measureCheckout } from './quality-measure.mjs'
import { renderSummary } from './quality-render.mjs'
import { runIfMain } from './script-main.mjs'

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
 * @param {NodeJS.ProcessEnv} _env  unused: it reads no environment
 * @param {typeof measureCheckout} [measure]  measures one checkout, launching its tools
 * @param {() => number} [now]  the clock
 * @returns {Promise<import('./script-main.mjs').ScriptResult>} exit code: 0 after any measurement, 2 on bad usage
 */
export async function run(argv, _env, measure = measureCheckout, now = Date.now) {
  /** @type {{ stdout: string[], stderr: string[] }} */
  const o = { stdout: [], stderr: [] }
  const args = parseArgs(argv)
  if (!args) {
    o.stderr.push('usage: node lib/quality-delta.mjs --base <checkout> --head <checkout>')
    return { exitCode: 2, ...o }
  }
  const started = now()
  const [base, head] = [await measure(args.base), await measure(args.head)]
  // One line per element, printed with its newline: the summary's own trailing one is that newline.
  o.stdout.push(renderSummary(base, head, { seconds: Math.round((now() - started) / 1000) }).replace(/\n$/, ''))
  return { exitCode: 0, ...o }
}

await runIfMain(import.meta.url, run)
