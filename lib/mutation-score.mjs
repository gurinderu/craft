// The score in a Stryker JSON report (mutation-testing-report-schema), for the weekly mutation workflow's
// failure issue (lib/mutation-issue.mjs): detected (Killed, Timeout) over valid mutants (those plus
// Survived, NoCoverage), as Stryker scores it; Ignored, CompileError and RuntimeError are left out.

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
