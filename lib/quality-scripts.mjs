// Type errors and test counts for the quality delta (realm @nick/craft, #147): the checkout's own npm
// scripts, run as its gate runs them, their output counted. A run whose output cannot be counted is a
// failure to measure, never 0 errors.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { failed, notMeasured, ok, scriptsOf, tail } from './quality-result.mjs'

/** @typedef {import('./quality-result.mjs').RunResult} RunResult */
/** @typedef {import('./quality-result.mjs').Deps} Deps */
/** @template T @typedef {import('./quality-result.mjs').Result<T>} Result */
/** @typedef {{ passed: number, failed: number, skipped: number }} Tests */

/**
 * Error count from one type-check script's output: tsc's `error TSnnnn` lines, or the workflow type
 * checker's "N problem(s)" line. null when a failing run shows neither — a failure to measure.
 * @param {RunResult} r @returns {number | null}
 */
export function typeErrorCount(r) {
  if (r.status === 0) return 0
  const out = `${r.stdout}\n${r.stderr}`
  const ts = out.match(/error TS\d+/g)?.length ?? 0
  const problems = Number(/^(\d+) problem\(s\)/m.exec(out)?.[1] ?? 0)
  return ts + problems || null
}

/** Type errors summed over every `check:types*` script. @param {string} dir @param {Deps} deps @returns {Result<number>} */
export function measureTypes(dir, deps) {
  const names = Object.keys(scriptsOf(dir)).filter(s => /^check:types(:|$)/.test(s)).sort()
  if (!names.length) return notMeasured('no check:types script in package.json')
  let total = 0
  /** @type {string[]} */
  const broken = []
  for (const s of names) {
    const r = deps.run('npm', ['run', '--silent', s], dir)
    const n = typeErrorCount(r)
    if (n == null) broken.push(`${s} exited ${r.status} without countable errors: ${tail(r)}`)
    else total += n
  }
  return broken.length ? failed(broken.join('; ')) : ok(total)
}

/** Vitest's JSON report → counts; null when it is not one. @param {unknown} report @returns {Tests | null} */
export function testsFromVitest(report) {
  if (!report || typeof report !== 'object') return null
  const r = /** @type {Record<string, unknown>} */ (report)
  const passed = r['numPassedTests'], failedN = r['numFailedTests'], pending = r['numPendingTests'], todo = r['numTodoTests']
  if (typeof passed !== 'number' || typeof failedN !== 'number') return null
  return { passed, failed: failedN, skipped: (typeof pending === 'number' ? pending : 0) + (typeof todo === 'number' ? todo : 0) }
}

/** `npm test` with Vitest's JSON reporter; any other runner is not measured. @param {string} dir @param {Deps} deps @returns {Result<Tests>} */
export function measureTests(dir, deps) {
  const script = scriptsOf(dir)['test']
  if (!script) return notMeasured('no "test" script in package.json')
  if (!/\bvitest\b/.test(script)) return notMeasured(`"npm test" is not Vitest (${script})`)
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'quality-delta-'))
  const out = path.join(tmp, 'vitest.json')
  try {
    const r = deps.run('npm', ['test', '--silent', '--', '--reporter=json', `--outputFile=${out}`], dir)
    /** @type {unknown} */
    let report = null
    try { report = JSON.parse(fs.readFileSync(out, 'utf8')) } catch { /* no report: reported below */ }
    const counts = testsFromVitest(report)
    return counts ? ok(counts) : failed(`npm test exited ${r.status} without a JSON report: ${tail(r)}`)
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
}
