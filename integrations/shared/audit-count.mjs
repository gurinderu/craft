// CI's non-blocking development-dependency audit summary.
import fs from 'node:fs'
import { runIfMain } from './script-main.mjs'
import { parseJsonObject } from './json-object.mjs'

/** @param {string[]} argv @returns {import('./script-main.mjs').ScriptResult} */
export function run(argv) {
  try {
    /** @type {Record<string, unknown>} */
    const report = parseJsonObject(fs.readFileSync(argv[0] ?? 'dev-audit.json', 'utf8'))
    const metadata = /** @type {{ vulnerabilities?: { high?: unknown, critical?: unknown } } | undefined} */ (report['metadata'])
    const { high, critical } = metadata?.vulnerabilities ?? {}
    if (typeof high !== 'number' || typeof critical !== 'number' || !Number.isInteger(high + critical)) throw new Error('no vulnerability count')
    return { exitCode: 0, stdout: [String(high + critical)], stderr: [] }
  } catch {
    return { exitCode: 1, stdout: [], stderr: ['audit report has no integer high/critical count'] }
  }
}

await runIfMain(import.meta.url, run)
