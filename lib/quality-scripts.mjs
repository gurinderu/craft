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

/** The script whose "N problem(s)" total also counts the engines' non-type problems (any ceiling, no-unsafe-*). */
const ENGINE_SCRIPT = 'check:types:workflows'

/** The directory a script's tool reports paths from: its `--prefix <dir>`, else the checkout root. @param {string} script @param {string} root */
export function scriptCwd(script, root) {
  const m = /--prefix[= ](\S+)/.exec(script)
  return m?.[1] ? path.resolve(root, m[1]) : root
}

/**
 * Each TS diagnostic in one script's output once, keyed `file:line:code` with the file relative to the
 * checkout — so the same error reported by two scripts (opencode/plugin/run-record.mjs by check:types and
 * check:types:lib; an inlined lib module by check:types:lib and the workflow checker) is one error. Read:
 * tsc's `file(line,col): error TSn` (paths relative to the tool's `cwd`), the workflow checker's
 * `workflows/x.js:line:col error TSn`, and its `workflows/x.js (lines the checker adds…): error TSn`.
 * @param {RunResult} r @param {string} root @param {string} cwd @returns {string[]}
 */
export function typeDiagnostics(r, root, cwd) {
  /** @type {Set<string>} */
  const keys = new Set()
  for (const line of `${r.stdout}\n${r.stderr}`.split('\n')) {
    const m = /^(.+?)\((\d+),\d+\): error (TS\d+)/.exec(line) ?? /^(\S+?):(\d+):\d+ error (TS\d+)/.exec(line)
      ?? /^(\S+) \(lines the checker adds[^)]*\)(): error (TS\d+)/.exec(line)
    if (!m) continue
    const file = path.relative(root, path.resolve(cwd, /** @type {string} */ (m[1]))).split(path.sep).join('/')
    keys.add(`${file}:${m[2] || 'wrapper'}:${m[3]}`)
  }
  return [...keys]
}

/** A script's own "N problem(s)" total; null when it prints none. @param {RunResult} r @returns {number | null} */
export function problemTotal(r) {
  const m = /^(\d+) problem\(s\)/m.exec(`${r.stdout}\n${r.stderr}`)
  return m ? Number(m[1]) : null
}

/**
 * Type errors over every `check:types*` script, each diagnostic once; and the engine checker's problems
 * that are not TS diagnostics (its total less its diagnostics), apart — they are not type errors.
 * @param {string} dir @param {Deps} deps @returns {{ types: Result<number>, engineChecks: Result<number> }}
 */
export function measureTypes(dir, deps) {
  const scripts = scriptsOf(dir)
  const names = Object.keys(scripts).filter(s => /^check:types(:|$)/.test(s)).sort()
  /** @type {Result<number>} */
  let engineChecks = notMeasured(`no ${ENGINE_SCRIPT} script in package.json`)
  if (!names.length) return { types: notMeasured('no check:types script in package.json'), engineChecks }
  /** @type {Set<string>} */
  const keys = new Set()
  /** @type {string[]} */
  const broken = []
  for (const s of names) {
    const r = deps.run('npm', ['run', '--silent', s], dir)
    const diags = typeDiagnostics(r, dir, scriptCwd(scripts[s] ?? '', dir))
    for (const k of diags) keys.add(k)
    const total = problemTotal(r)
    if (s === ENGINE_SCRIPT) {
      engineChecks = r.status === 0 ? ok(0) : total != null ? ok(Math.max(0, total - diags.length))
        : failed(`${s} exited ${r.status} without its problem total: ${tail(r)}`)
    }
    if (r.status !== 0 && !diags.length && total == null) broken.push(`${s} exited ${r.status} without countable errors: ${tail(r)}`)
  }
  return { types: broken.length ? failed(broken.join('; ')) : ok(keys.size), engineChecks }
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
