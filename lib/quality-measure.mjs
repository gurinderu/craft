// Measures one checkout for the PR quality delta (lib/quality-delta.mjs; realm @nick/craft, #147): each
// metric with the checkout's OWN tooling and config — its node_modules, its eslint.config.mjs, its
// package.json scripts — so base and head are each read at their own gate's settings. A metric that
// cannot be measured is a `not-measured` or `failed` result carrying the reason, never a 0.
// The measures: lib/quality-eslint.mjs (complexity, lint), lib/quality-scripts.mjs (types, tests),
// lib/quality-readers.mjs (Knip, import cycles); shared shapes in lib/quality-result.mjs.
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { errText, failed } from './quality-result.mjs'
import { measureEslint } from './quality-eslint.mjs'
import { measureTests, measureTypes } from './quality-scripts.mjs'
import { measureCycles, measureKnip } from './quality-readers.mjs'

/** @typedef {import('./quality-result.mjs').Deps} Deps */
/** @typedef {import('./quality-result.mjs').EslintCtor} EslintCtor */
/** @typedef {import('./quality-result.mjs').Wrapper} Wrapper */
/** @template T @typedef {import('./quality-result.mjs').Result<T>} Result */
/**
 * @typedef {import('./quality-eslint.mjs').EslintMeasure & { types: Result<number>,
 *   tests: Result<import('./quality-scripts.mjs').Tests>, knip: Result<import('./quality-readers.mjs').Knip>,
 *   cycles: Result<number> }} Measure
 */

/** @param {string} dir @param {string} pkg @returns {Promise<unknown>} the module, or null when not installed */
async function importFrom(dir, pkg) {
  let resolved
  try { resolved = createRequire(path.join(dir, 'package.json')).resolve(pkg) } catch { return null }
  return import(pathToFileURL(resolved).href)
}

/** @type {Deps} */
export const defaultDeps = {
  run(cmd, args, cwd) {
    // No shell; the step summary is this tool's to write, so children do not see its path.
    const env = { ...process.env }
    delete env['GITHUB_STEP_SUMMARY']
    const r = spawnSync(cmd, args, { cwd, env, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, timeout: 20 * 60_000 })
    return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '', ...(r.error ? { error: r.error.message } : {}) }
  },
  async loadEslint(dir) {
    const mod = /** @type {{ ESLint?: EslintCtor } | null} */ (await importFrom(dir, 'eslint'))
    return mod?.ESLint ?? null
  },
  async loadSonar(dir) {
    const mod = /** @type {{ default?: unknown } | null} */ (await importFrom(dir, 'eslint-plugin-sonarjs'))
    return mod ? mod.default ?? mod : null
  },
  async loadWrapper(dir) {
    // The checkout's own wrapper, so each side's engines are read as its own engine checks read them.
    const file = path.join(dir, 'lib', 'check-workflow-types.mjs')
    if (!fs.existsSync(file)) return null
    const mod = /** @type {{ wrapWorkflow?: unknown }} */ (await import(pathToFileURL(file).href))
    return typeof mod.wrapWorkflow === 'function' ? /** @type {Wrapper} */ (mod.wrapWorkflow) : null
  },
}

/**
 * Every metric for one checkout. Each metric fails on its own; a throw inside one becomes its `failed`.
 * @param {string} dir absolute path of an installed checkout @param {Deps} [deps] @returns {Promise<Measure>}
 */
export async function measureCheckout(dir, deps = defaultDeps) {
  /** @template T @param {() => Result<T>} f @returns {Result<T>} */
  const guard = f => { try { return f() } catch (e) { return failed(errText(e)) } }
  /** @type {import('./quality-eslint.mjs').EslintMeasure} */
  let eslint
  try { eslint = await measureEslint(dir, deps) } catch (e) {
    const f = failed(errText(e))
    eslint = { complexity: f, cognitive: f, lint: f, engines: f }
  }
  return {
    ...eslint,
    types: guard(() => measureTypes(dir, deps)),
    tests: guard(() => measureTests(dir, deps)),
    knip: guard(() => measureKnip(dir, deps)),
    cycles: guard(() => measureCycles(dir, deps)),
  }
}
