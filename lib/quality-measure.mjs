// Measures one checkout for the PR quality delta (lib/quality-delta.mjs; realm @nick/craft, #147): each
// metric with the checkout's OWN tooling and config — its node_modules, its eslint.config.mjs, its
// package.json scripts — so base and head are each read at their own gate's settings. A metric that
// cannot be measured is a `not-measured` or `failed` result carrying the reason, never a 0.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

/**
 * @template T
 * @typedef {{ status: 'ok', value: T } | { status: 'not-measured', reason: string } | { status: 'failed', reason: string }} Result
 */
/** @typedef {{ key: string, name: string, file: string, line: number, value: number }} FnEntry */
/** @typedef {{ total: number, functions: FnEntry[] }} Complexity */
/** @typedef {{ passed: number, failed: number, skipped: number }} Tests */
/** @typedef {{ files: string[], exports: string[], dependencies: string[] }} Knip */
/**
 * @typedef {{ complexity: Result<Complexity>, cognitive: Result<Complexity>, lint: Result<number>,
 *   types: Result<number>, tests: Result<Tests>, knip: Result<Knip>, cycles: Result<number> }} Measure
 */
/** @typedef {{ ruleId: string | null, message: string, line: number }} LintMessage */
/** @typedef {{ filePath: string, messages: LintMessage[] }} LintResult */
/** @typedef {new (options: Record<string, unknown>) => { lintFiles(patterns: string[]): Promise<LintResult[]> }} EslintCtor */
/** @typedef {{ status: number | null, stdout: string, stderr: string, error?: string }} RunResult */
/**
 * @typedef {{
 *   run: (cmd: string, args: string[], cwd: string) => RunResult,
 *   loadEslint: (dir: string) => Promise<EslintCtor | null>,
 *   loadSonar: (dir: string) => Promise<unknown>,
 * }} Deps
 */

const COMPLEXITY = 'complexity'
const COGNITIVE = 'sonarjs/cognitive-complexity'
/** ESLint CLI flags that take a value: skipped with it when reading lint's scope from the script. */
const VALUE_FLAGS = new Set(['--max-warnings', '--ext', '--rule', '--format', '-f', '--output-file', '-o',
  '--ignore-pattern', '--cache-location', '--cache-strategy', '--parser', '--parser-options', '--plugin',
  '--global', '--env', '--report-unused-disable-directives-severity', '--concurrency'])
/** Flags that change which config or files the gate sees; the Node API run here would not reproduce them. */
const UNSUPPORTED_FLAGS = new Set(['-c', '--config', '--no-config-lookup', '--no-eslintrc', '--stdin', '--rulesdir'])

/** @template T @param {T} value @returns {Result<T>} */
const ok = value => ({ status: 'ok', value })
/** @param {string} reason @returns {{ status: 'not-measured', reason: string }} */
const notMeasured = reason => ({ status: 'not-measured', reason })
/** @param {string} reason @returns {{ status: 'failed', reason: string }} */
const failed = reason => ({ status: 'failed', reason })

/** @param {string} dir @returns {Record<string, string>} */
function scriptsOf(dir) {
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

/**
 * Per-function values from one rule's messages at threshold 0. `complexity` names the function in its
 * message ("Function 'x' has a complexity of 3."); the cognitive rule does not, so its entries borrow the
 * name of the complexity entry reported on the same line. Keys are file + name + ordinal among same-named
 * functions in that file (line numbers move with every edit above a function; names mostly do not).
 * @param {LintResult[]} results @param {string} cwd @param {string} ruleId @param {RegExp} valueRe
 * @param {Map<string, string>} [namesByLine] file:line → name, filled from the complexity pass
 * @returns {Complexity}
 */
export function functionsFromMessages(results, cwd, ruleId, valueRe, namesByLine) {
  /** @type {FnEntry[]} */
  const functions = []
  let total = 0
  for (const r of results) {
    const file = path.relative(cwd, r.filePath).split(path.sep).join('/')
    /** @type {Map<string, number>} */
    const seen = new Map()
    for (const m of r.messages) {
      if (m.ruleId !== ruleId) continue
      const v = valueRe.exec(m.message)
      if (!v) continue
      const value = Number(v[1])
      const name = ruleId === COMPLEXITY
        ? m.message.slice(0, m.message.indexOf(' has a complexity')).trim()
        : namesByLine?.get(`${file}:${m.line}`) ?? `function at line ${m.line}`
      namesByLine?.set(`${file}:${m.line}`, name)
      const n = (seen.get(name) ?? 0) + 1
      seen.set(name, n)
      functions.push({ key: `${file} ${name} #${n}`, name, file, line: m.line, value })
      total += value
    }
  }
  return { total, functions }
}

/** Lint problems at the gate's settings: every message but the two measuring rules (parse errors included). @param {LintResult[]} results */
export function lintProblems(results) {
  let n = 0
  for (const r of results) for (const m of r.messages) if (m.ruleId !== COMPLEXITY && m.ruleId !== COGNITIVE) n++
  return n
}

/** @param {unknown} e */
const errText = e => (e instanceof Error ? e.message : String(e)).split('\n').slice(0, 3).join(' ')

/**
 * Complexity, cognitive complexity and lint problems from ONE ESLint run with the checkout's own config,
 * `complexity` (and the cognitive rule, when the plugin is installed) overridden to threshold 0.
 * @param {string} dir @param {Deps} deps
 * @returns {Promise<Pick<Measure, 'complexity' | 'cognitive' | 'lint'>>}
 */
async function measureEslint(dir, deps) {
  /** @param {string} reason */
  const allFailed = reason => ({ complexity: failed(reason), cognitive: failed(reason), lint: failed(reason) })
  let scope
  try { scope = lintScope(scriptsOf(dir)['lint']) } catch (e) { return allFailed(errText(e)) }
  let ESLint
  try { ESLint = await deps.loadEslint(dir) } catch (e) { return allFailed(`eslint failed to load: ${errText(e)}`) }
  if (!ESLint) return allFailed('eslint is not installed in the checkout (run npm ci)')
  /** @type {unknown} */
  let sonar = null
  let sonarError = ''
  try { sonar = await deps.loadSonar(dir) } catch (e) { sonarError = errText(e) }
  /** @type {Record<string, unknown>} */
  const rules = { [COMPLEXITY]: ['warn', 0] }
  if (sonar) rules[COGNITIVE] = ['warn', 0]
  // The plugin is registered here unless the checkout's config already registers it (ESLint refuses a
  // second, different object under the same name): then the rule alone is turned on.
  const attempts = sonar ? [{ plugins: { sonarjs: sonar }, rules }, { rules }] : [{ rules }]
  /** @type {LintResult[] | null} */
  let results = null
  let lastError = ''
  for (const override of attempts) {
    try {
      results = await new ESLint({ cwd: dir, overrideConfig: [override] }).lintFiles(scope)
      break
    } catch (e) {
      lastError = errText(e)
      if (!/redefine plugin/i.test(lastError)) break
    }
  }
  if (!results) return allFailed(`eslint failed: ${lastError}`)
  /** @type {Map<string, string>} */
  const names = new Map()
  return {
    complexity: ok(functionsFromMessages(results, dir, COMPLEXITY, /complexity of (\d+)/, names)),
    cognitive: sonar
      ? ok(functionsFromMessages(results, dir, COGNITIVE, /Complexity from (\d+)/, names))
      : sonarError ? failed(`eslint-plugin-sonarjs failed to load: ${sonarError}`) : notMeasured('eslint-plugin-sonarjs not installed'),
    lint: ok(lintProblems(results)),
  }
}

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

/** @param {RunResult} r */
const tail = r => (r.error ?? `${r.stderr}\n${r.stdout}`).trim().split('\n').slice(-3).join(' ').slice(0, 300)

/** @param {string} dir @param {Deps} deps @returns {Result<number>} */
function measureTypes(dir, deps) {
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

/** @param {string} dir @param {Deps} deps @returns {Result<Tests>} */
function measureTests(dir, deps) {
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

/** @param {string} dir @param {string} name */
const binOf = (dir, name) => path.join(dir, 'node_modules', '.bin', name)

/** @param {string} dir @param {Deps} deps @returns {Result<Knip>} */
function measureKnip(dir, deps) {
  if (!fs.existsSync(binOf(dir, 'knip'))) return notMeasured('knip not installed in the checkout')
  const r = deps.run(binOf(dir, 'knip'), ['--production', '--no-progress', '--reporter', 'json'], dir)
  /** @type {unknown} */
  let report = null
  try { report = JSON.parse(r.stdout) } catch { /* reported below */ }
  const k = knipFromJson(report)
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

/** @param {string} dir @param {Deps} deps @returns {Result<number>} */
function measureCycles(dir, deps) {
  if (!fs.existsSync(binOf(dir, 'depcruise'))) return notMeasured('dependency-cruiser not in the repo')
  let scope
  try { scope = lintScope(scriptsOf(dir)['lint']) } catch (e) { return failed(`no scope to cruise: ${errText(e)}`) }
  const r = deps.run(binOf(dir, 'depcruise'), ['--output-type', 'json', ...scope], dir)
  /** @type {unknown} */
  let report = null
  try { report = JSON.parse(r.stdout) } catch { /* reported below */ }
  const n = cyclesFromDepcruise(report)
  return n == null ? failed(`depcruise exited ${r.status} without a JSON report: ${tail(r)}`) : ok(n)
}

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
}

/**
 * Every metric for one checkout. Each metric fails on its own; a throw inside one becomes its `failed`.
 * @param {string} dir absolute path of an installed checkout @param {Deps} [deps] @returns {Promise<Measure>}
 */
export async function measureCheckout(dir, deps = defaultDeps) {
  /** @template T @param {() => Result<T>} f @returns {Result<T>} */
  const guard = f => { try { return f() } catch (e) { return failed(errText(e)) } }
  /** @type {Pick<Measure, 'complexity' | 'cognitive' | 'lint'>} */
  let eslint
  try { eslint = await measureEslint(dir, deps) } catch (e) {
    const f = failed(errText(e))
    eslint = { complexity: f, cognitive: f, lint: f }
  }
  return {
    ...eslint,
    types: guard(() => measureTypes(dir, deps)),
    tests: guard(() => measureTests(dir, deps)),
    knip: guard(() => measureKnip(dir, deps)),
    cycles: guard(() => measureCycles(dir, deps)),
  }
}
