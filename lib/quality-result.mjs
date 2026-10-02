// The shapes and small helpers the quality-delta measures share (lib/quality-measure.mjs; realm
// @nick/craft, #147): a metric is `ok`, `not-measured` or `failed` with its reason — never a bare 0.
import fs from 'node:fs'
import path from 'node:path'

/**
 * @template T
 * @typedef {{ status: 'ok', value: T } | { status: 'not-measured', reason: string } | { status: 'failed', reason: string }} Result
 */
/** @typedef {{ ruleId: string | null, message: string, line: number }} LintMessage */
/** @typedef {{ filePath: string, messages: LintMessage[] }} LintResult */
/**
 * @typedef {new (options: Record<string, unknown>) => {
 *   lintFiles(patterns: string[]): Promise<LintResult[]>,
 *   lintText(text: string, options: { filePath: string }): Promise<LintResult[]>,
 *   calculateConfigForFile(filePath: string): Promise<unknown>,
 * }} EslintCtor
 */
/** An engine wrapped as the sandbox runs it, and how many lines precede its line 1. @typedef {(src: string, root: string) => { text: string, offset: number }} Wrapper */
/** @typedef {{ status: number | null, stdout: string, stderr: string, error?: string }} RunResult */
/**
 * What a measure touches outside itself; tests replace it.
 * @typedef {{
 *   run: (cmd: string, args: string[], cwd: string) => RunResult,
 *   loadEslint: (dir: string) => Promise<EslintCtor | null>,
 *   loadSonar: (dir: string) => Promise<unknown>,
 *   loadWrapper: (dir: string) => Promise<Wrapper | null>,
 * }} Deps
 */

/** @template T @param {T} value @returns {Result<T>} */
export const ok = value => ({ status: 'ok', value })
/** @param {string} reason @returns {{ status: 'not-measured', reason: string }} */
export const notMeasured = reason => ({ status: 'not-measured', reason })
/** @param {string} reason @returns {{ status: 'failed', reason: string }} */
export const failed = reason => ({ status: 'failed', reason })

/** The checkout's package.json scripts (string values only). @param {string} dir @returns {Record<string, string>} */
export function scriptsOf(dir) {
  /** @type {unknown} */
  const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'))
  const scripts = pkg && typeof pkg === 'object' ? /** @type {Record<string, unknown>} */ (pkg)['scripts'] : undefined
  /** @type {Record<string, string>} */
  const out = {}
  if (scripts && typeof scripts === 'object') {
    for (const [k, v] of Object.entries(scripts)) if (typeof v === 'string') out[k] = v
  }
  return out
}

/** The first lines of an error, for a one-line reason. @param {unknown} e */
export const errText = e => (e instanceof Error ? e.message : String(e)).split('\n').slice(0, 3).join(' ')

/** The last lines a command printed, for a one-line reason. @param {RunResult} r */
export const tail = r => (r.error ?? `${r.stderr}\n${r.stdout}`).trim().split('\n').slice(-3).join(' ').slice(0, 300)

/** ESLint CLI flags that take a value: skipped with it when reading lint's scope from the script. */
const VALUE_FLAGS = new Set(['--max-warnings', '--ext', '--rule', '--format', '-f', '--output-file', '-o',
  '--ignore-pattern', '--cache-location', '--cache-strategy', '--parser', '--parser-options', '--plugin',
  '--global', '--env', '--report-unused-disable-directives-severity', '--concurrency'])
/** Flags that change which config or files the gate sees; the Node API run here would not reproduce them. */
const UNSUPPORTED_FLAGS = new Set(['-c', '--config', '--no-config-lookup', '--no-eslintrc', '--stdin', '--rulesdir'])

/**
 * The paths the `lint` script hands ESLint — lint's scope. Throws when the script is not one plain
 * `eslint <paths…>` call this module can reproduce through the Node API.
 * @param {string | undefined} script @returns {string[]}
 */
export function lintScope(script) {
  if (!script) throw new Error('no "lint" script in package.json')
  if (/[;&|<>`$()]/.test(script)) throw new Error(`"lint" is not a single eslint call: ${script}`)
  const tokens = script.trim().split(/\s+/)
  if (tokens[0] !== 'eslint') throw new Error(`"lint" does not start with eslint: ${script}`)
  /** @type {string[]} */
  const paths = []
  for (let i = 1; i < tokens.length; i++) {
    const t = /** @type {string} */ (tokens[i])
    const flag = t.split('=')[0] ?? t
    if (UNSUPPORTED_FLAGS.has(flag)) throw new Error(`"lint" uses ${flag}, which this measure does not reproduce`)
    if (t.startsWith('-')) { if (VALUE_FLAGS.has(t)) i++; continue }
    paths.push(t)
  }
  if (!paths.length) throw new Error(`"lint" names no paths: ${script}`)
  return paths
}

/** @param {string} dir @param {string} name */
export const binOf = (dir, name) => path.join(dir, 'node_modules', '.bin', name)

/** A command's stdout as JSON, null when it is not JSON. @param {RunResult} r @returns {unknown} */
export function stdoutJson(r) {
  try { return /** @type {unknown} */ (JSON.parse(r.stdout)) } catch { return null }
}
