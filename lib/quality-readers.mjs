// Knip's unused code and dependency-cruiser's import cycles for the quality delta (realm @nick/craft,
// #147): each tool from the checkout's own node_modules, its JSON report read. A tool that is absent is
// not measured; one that ran without a readable report failed to measure.
import fs from 'node:fs'
import path from 'node:path'
import { binOf, errText, failed, lintScope, notMeasured, ok, scriptsOf, stdoutJson, tail } from './quality-result.mjs'

/** @typedef {import('./quality-result.mjs').Deps} Deps */
/** @template T @typedef {import('./quality-result.mjs').Result<T>} Result */
/** @typedef {{ files: string[], exports: string[], dependencies: string[], other: string[] }} Knip */

/**
 * Which keys of knip 6's JSON issue feed each kind. `other` is every further issue type `knip --production`
 * fails on; its entries carry their key (`lib/a.mjs: unlisted left-pad`).
 * @type {[keyof Knip, string[]][]}
 */
const KNIP_KINDS = [
  ['files', ['files']],
  ['exports', ['exports', 'types']],
  ['dependencies', ['dependencies', 'devDependencies', 'optionalPeerDependencies']],
  ['other', ['unlisted', 'unresolved', 'binaries', 'enumMembers', 'duplicates', 'namespaceMembers']],
]

/** @param {unknown} x @returns {Record<string, unknown> | null} */
const asRecord = x => (x && typeof x === 'object' && !Array.isArray(x) ? /** @type {Record<string, unknown>} */ (x) : null)

/** A reported symbol's name; a duplicates entry is a group of names. @param {unknown} x @returns {string} */
function symbolName(x) {
  if (Array.isArray(x)) return /** @type {unknown[]} */ (x).map(symbolName).join(' = ')
  return String(asRecord(x)?.['name'] ?? x)
}

/** @param {Knip} out @param {Record<string, unknown>} issue */
function addIssue(out, issue) {
  const file = String(issue['file'])
  for (const [kind, keys] of KNIP_KINDS) {
    for (const key of keys) {
      const list = issue[key]
      const names = Array.isArray(list) ? /** @type {unknown[]} */ (list).map(symbolName) : []
      out[kind].push(...names.map(n => (kind === 'files' ? n : kind === 'other' ? `${file}: ${key} ${n}` : `${file}: ${n}`)))
    }
  }
}

/** Knip's JSON report → identifiers of each kind; null when it is not one. @param {unknown} report @returns {Knip | null} */
export function knipFromJson(report) {
  const issues = asRecord(report)?.['issues']
  if (!Array.isArray(issues)) return null
  /** @type {Knip} */
  const out = { files: [], exports: [], dependencies: [], other: [] }
  for (const issue of /** @type {unknown[]} */ (issues)) {
    const i = asRecord(issue)
    if (i) addIssue(out, i)
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

/** A module's dependencies dependency-cruiser marks `circular`. @param {unknown} m */
function circularEdges(m) {
  const deps = asRecord(m)?.['dependencies']
  return Array.isArray(deps) ? /** @type {unknown[]} */ (deps).filter(d => asRecord(d)?.['circular'] === true).length : 0
}

/** Edges dependency-cruiser marks `circular` in its JSON output; null when it is not one. @param {unknown} report */
export function cyclesFromDepcruise(report) {
  const modules = asRecord(report)?.['modules']
  if (!Array.isArray(modules)) return null
  return /** @type {unknown[]} */ (modules).reduce((/** @type {number} */ n, m) => n + circularEdges(m), 0)
}

/** Config files dependency-cruiser would be given, first found wins. */
const DEPCRUISE_CONFIGS = ['.dependency-cruiser.mjs', '.dependency-cruiser.cjs', '.dependency-cruiser.js', '.dependency-cruiser.json']

/**
 * dependency-cruiser over lint's scope, when the checkout has it — with the checkout's own config when
 * there is one: it carries the tsconfig the cruise needs to read `import { type X }` (realm @nick/craft, #156).
 * @param {string} dir @param {Deps} deps @returns {Result<number>}
 */
export function measureCycles(dir, deps) {
  if (!fs.existsSync(binOf(dir, 'depcruise'))) return notMeasured('dependency-cruiser not in the repo')
  let scope
  try { scope = lintScope(scriptsOf(dir)['lint']) } catch (e) { return failed(`no scope to cruise: ${errText(e)}`) }
  const config = DEPCRUISE_CONFIGS.find(f => fs.existsSync(path.join(dir, f)))
  const r = deps.run(binOf(dir, 'depcruise'), [...(config ? ['--config', config] : []), '--output-type', 'json', ...scope], dir)
  const n = cyclesFromDepcruise(stdoutJson(r))
  return n == null ? failed(`depcruise exited ${r.status} without a JSON report: ${tail(r)}`) : ok(n)
}
