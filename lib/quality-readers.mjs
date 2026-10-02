// Knip's unused code and dependency-cruiser's import cycles for the quality delta (realm @nick/craft,
// #147): each tool from the checkout's own node_modules, its JSON report read. A tool that is absent is
// not measured; one that ran without a readable report failed to measure.
import fs from 'node:fs'
import { binOf, errText, failed, lintScope, notMeasured, ok, scriptsOf, stdoutJson, tail } from './quality-result.mjs'

/** @typedef {import('./quality-result.mjs').Deps} Deps */
/** @template T @typedef {import('./quality-result.mjs').Result<T>} Result */
/** @typedef {{ files: string[], exports: string[], dependencies: string[] }} Knip */

const KNIP_EXPORT_KEYS = ['exports', 'types', 'nsExports', 'nsTypes']
const KNIP_DEP_KEYS = ['dependencies', 'devDependencies', 'optionalPeerDependencies']

/** Knip's JSON report → identifiers of each unused kind; null when it is not one. @param {unknown} report @returns {Knip | null} */
export function knipFromJson(report) {
  if (!report || typeof report !== 'object') return null
  const issues = /** @type {Record<string, unknown>} */ (report)['issues']
  if (!Array.isArray(issues)) return null
  /** @type {Knip} */
  const out = { files: [], exports: [], dependencies: [] }
  for (const issue of /** @type {unknown[]} */ (issues)) {
    if (!issue || typeof issue !== 'object') continue
    const i = /** @type {Record<string, unknown>} */ (issue)
    const file = String(i['file'])
    /** @param {string} key @returns {string[]} */
    const names = key => {
      const list = i[key]
      return Array.isArray(list) ? /** @type {unknown[]} */ (list).map(x => String(x && typeof x === 'object' ? /** @type {Record<string, unknown>} */ (x)['name'] : x)) : []
    }
    out.files.push(...names('files'))
    for (const k of KNIP_EXPORT_KEYS) out.exports.push(...names(k).map(n => `${file}: ${n}`))
    for (const k of KNIP_DEP_KEYS) out.dependencies.push(...names(k).map(n => `${file}: ${n}`))
  }
  for (const list of Object.values(out)) list.sort()
  return out
}

/** Knip in production mode, the checkout's knip.config.js. @param {string} dir @param {Deps} deps @returns {Result<Knip>} */
export function measureKnip(dir, deps) {
  if (!fs.existsSync(binOf(dir, 'knip'))) return notMeasured('knip not installed in the checkout')
  const r = deps.run(binOf(dir, 'knip'), ['--production', '--no-progress', '--reporter', 'json'], dir)
  const k = knipFromJson(stdoutJson(r))
  return k ? ok(k) : failed(`knip exited ${r.status} without a JSON report: ${tail(r)}`)
}

/** Edges dependency-cruiser marks `circular` in its JSON output; null when it is not one. @param {unknown} report */
export function cyclesFromDepcruise(report) {
  if (!report || typeof report !== 'object') return null
  const modules = /** @type {Record<string, unknown>} */ (report)['modules']
  if (!Array.isArray(modules)) return null
  let n = 0
  for (const m of /** @type {unknown[]} */ (modules)) {
    const deps = m && typeof m === 'object' ? /** @type {Record<string, unknown>} */ (m)['dependencies'] : null
    if (Array.isArray(deps)) for (const d of /** @type {unknown[]} */ (deps)) if (d && typeof d === 'object' && /** @type {Record<string, unknown>} */ (d)['circular'] === true) n++
  }
  return n
}

/** dependency-cruiser over lint's scope, when the checkout has it. @param {string} dir @param {Deps} deps @returns {Result<number>} */
export function measureCycles(dir, deps) {
  if (!fs.existsSync(binOf(dir, 'depcruise'))) return notMeasured('dependency-cruiser not in the repo')
  let scope
  try { scope = lintScope(scriptsOf(dir)['lint']) } catch (e) { return failed(`no scope to cruise: ${errText(e)}`) }
  const r = deps.run(binOf(dir, 'depcruise'), ['--output-type', 'json', ...scope], dir)
  const n = cyclesFromDepcruise(stdoutJson(r))
  return n == null ? failed(`depcruise exited ${r.status} without a JSON report: ${tail(r)}`) : ok(n)
}
