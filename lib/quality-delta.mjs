// How quality moved between a PR's base and head, as Markdown for the job summary — a signal for review,
// never a gate (realm @nick/craft, #147): the CLI exits 0 whatever it measured, and a metric it could
// not measure is said to be so, never shown as 0. Measuring lives in lib/quality-measure.mjs, the
// Markdown in lib/quality-render.mjs.
//   node lib/quality-delta.mjs --base <checkout> --head <checkout>
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { measureCheckout } from './quality-measure.mjs'
import { renderSummary } from './quality-render.mjs'

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

/** @param {string[]} argv @returns {Promise<number>} exit code: 0 after any measurement, 2 on bad usage */
export async function main(argv) {
  const args = parseArgs(argv)
  if (!args) {
    console.error('usage: node lib/quality-delta.mjs --base <checkout> --head <checkout>')
    return 2
  }
  const started = Date.now()
  const [base, head] = [await measureCheckout(args.base), await measureCheckout(args.head)]
  process.stdout.write(renderSummary(base, head, { seconds: Math.round((Date.now() - started) / 1000) }))
  return 0
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2))
}
