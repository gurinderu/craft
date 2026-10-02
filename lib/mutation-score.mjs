// The score in a Stryker JSON report (mutation-testing-report-schema), for the weekly mutation workflow's
// failure issue: detected (Killed, Timeout) over valid mutants (those plus Survived, NoCoverage), as Stryker
// scores it; Ignored, CompileError and RuntimeError are left out.
//
// Run: `node lib/mutation-score.mjs reports/mutation/mutation.json` prints e.g. `72.58%`, or exits 1
// when there is no readable report or no valid mutant in it.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const DETECTED = new Set(['Killed', 'Timeout'])
const UNDETECTED = new Set(['Survived', 'NoCoverage'])

/** @param {unknown} v @returns {v is Record<string, unknown>} */
const isObject = v => !!v && typeof v === 'object' && !Array.isArray(v)

/** @param {unknown} file @returns {string[]} the statuses of one file's mutants */
function statuses(file) {
  const mutants = isObject(file) ? file['mutants'] : undefined
  if (!Array.isArray(mutants)) return []
  return mutants.map(m => (isObject(m) && typeof m['status'] === 'string' ? m['status'] : ''))
}

/**
 * @param {unknown} report  a parsed Stryker JSON report
 * @returns {number | null} the score in percent, null when there is no valid mutant to score
 */
export function mutationScore(report) {
  const files = isObject(report) ? report['files'] : undefined
  if (!isObject(files)) return null
  const all = Object.values(files).flatMap(statuses)
  const detected = all.filter(s => DETECTED.has(s)).length
  const valid = detected + all.filter(s => UNDETECTED.has(s)).length
  return valid ? (detected / valid) * 100 : null
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  /** @type {number | null} */
  let score = null
  try { score = mutationScore(JSON.parse(fs.readFileSync(process.argv[2] ?? '', 'utf8'))) } catch { score = null }
  if (score === null) {
    console.error('mutation-score: no readable report with a valid mutant')
    process.exit(1)
  }
  console.log(`${score.toFixed(2)}%`)
}
