// Type-checks the engines' own code (workflows/*.js) at the strictness of lib/tsconfig.json. A
// workflow script is a sandbox body (top-level `return`, `await`), so each is wrapped the way the
// sandbox runs it — inside an async function — with the sandbox's globals from workflow-sandbox.d.ts.
// Every `craft-inline` region is swapped for an import of the same names from its lib module: that
// code is already checked there, and the engine around it then sees the real typed functions.
// Errors are reported at their line in workflows/<file>.js. The compile runs in process
// (lib/engine-checker.mjs), so the same program's checker also counts each engine's implicit `any`,
// and typescript-eslint's unsafe family lints that program's engines at zero (lib/engine-lint.mjs).
import fs from 'node:fs'
import path from 'node:path'
import { findRegions, ROOT } from './inline-regions.mjs'
import { loadTypescript, tscMissingMessage } from './run-tsc.mjs'
import { anyCeilingProblems, countAny, forbiddenCalls, inlinedAnyProblems, parseEngine } from './engine-source-rules.mjs'
import { compileProject } from './engine-checker.mjs'
import { implicitAnySites } from './engine-any-sites.mjs'
import { parseJsonObject } from './json-object.mjs'
import { loadEngineLinter, unsafeAnyProblems } from './engine-lint.mjs'
import { directiveProblems } from './ts-directives.mjs'
import { compileProblems } from './tsc-diagnostics.mjs'
import { outputLines, realOrResolved, runIfMain } from './script-main.mjs'

/**
 * @param {string} src  a workflow script
 * @param {string} root  the repo root, to resolve region sources
 * @returns {{ text: string, offset: number }} the checkable module, and how many lines precede line 1 of `src`
 */
export function wrapWorkflow(src, root) {
  // `export ` becomes seven spaces, so every column on the line still matches the source.
  const lines = src.replace(/^export const meta/m, '       const meta').split('\n')
  const head = []
  for (const r of findRegions(src)) {
    for (let i = r.open; i <= r.close; i++) lines[i] = ''
    head.push(`import { ${r.names.join(', ')} } from ${JSON.stringify(path.join(root, r.source))}`)
    head.push(`void [${r.names.join(', ')}]`)
  }
  head.push('async function __wf() {')
  // `meta` is read by the Workflow tool from outside the body, never inside it. Read at the top in a
  // closure: after the body's final `return` it would be unreachable code (allowUnreachableCode: false).
  if (/^ {7}const meta\b/m.test(lines.join('\n'))) head.push('void (() => meta)')
  return { text: [...head, ...lines, '}', 'void __wf', ''].join('\n'), offset: head.length }
}

/** @param {string} file @returns {string | null} */
function readOrNull(file) {
  try { return fs.readFileSync(file, 'utf8') } catch { return null }
}

/** @param {string} root @returns {Record<string, unknown> | string} the ceiling, or why it could not be read */
function readCeiling(root) {
  try { return parseJsonObject(fs.readFileSync(path.join(root, 'lib', 'engine-any-ceiling.json'), 'utf8')) }
  catch (e) { return `lib/engine-any-ceiling.json unreadable (${/** @type {Error} */ (e).message}) — every engine's \`any\` count is unbounded` }
}

/**
 * @typedef {NonNullable<ReturnType<typeof loadTypescript>>} TS
 * @typedef {import('./tsc-diagnostics.mjs').Wrapped} Wrapped
 * @typedef {{ map: Map<string, Wrapped>, suppressed: string[], anyCounts: Record<string, number>, inlined: Map<string, { text: string | null, engines: string[] }> }} Gathered
 */

/** @param {string} root @returns {{ problems: string[], files: number }} */
export function checkWorkflowTypes(root = ROOT) {
  // Next to lib/ (not under /tmp), so a JSDoc `import('../lib/x.mjs')` resolves exactly as it does from workflows/.
  const dir = fs.mkdtempSync(path.join(root, '.wft-'))
  try {
    const files = fs.readdirSync(path.join(root, 'workflows')).filter(f => f.endsWith('.js')).sort()
    if (!files.length) return { problems: ['no workflow scripts found under workflows/ — nothing was type-checked'], files: 0 }
    // The source rules parse with the same pinned TypeScript the check compiles with.
    const ts = loadTypescript(root)
    if (!ts) return { problems: [tscMissingMessage(root)], files: files.length }
    return { problems: checkEngines(root, dir, ts, files), files: files.length }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

/**
 * Every problem of the engines `files`, wrapped into `dir` and compiled there.
 * @param {string} root @param {string} dir @param {TS} ts @param {string[]} files @returns {string[]}
 */
function checkEngines(root, dir, ts, files) {
  const engineLinter = loadEngineLinter(root)
  /** @type {Gathered} */
  const g = { map: new Map(), suppressed: [], anyCounts: {}, inlined: new Map() }
  for (const f of files) gatherEngine(root, dir, ts, f, g)
  fs.writeFileSync(path.join(dir, 'tsconfig.json'), JSON.stringify({
    extends: path.join(root, 'lib', 'tsconfig.json'),
    // The sandbox has no Node API: no @types/node here. skipLibCheck off, so the sandbox declaration
    // is itself checked rather than read on trust.
    compilerOptions: { types: [], skipLibCheck: false },
    include: [path.join(dir, '*.mjs'), path.join(root, 'lib', 'workflow-sandbox.d.ts')], exclude: [],
  }))
  const { suppressed } = g
  let run
  try { run = compileProject(ts, path.join(dir, 'tsconfig.json')) }
  catch (e) { return [...suppressed, `the TypeScript compiler threw: ${/** @type {Error} */ (e).message} — nothing was type-checked`] }
  const byReal = new Map([...g.map].map(([k, v]) => [realOrResolved(k), v]))
  const { sites, compiled } = countImplicitAny(ts, run.program, byReal, g.anyCounts)
  suppressed.push(...anyCountProblems(root, files, g, sites))
  suppressed.push(...inlinedAnyProblems(g.inlined, ts))
  if (typeof engineLinter === 'string') suppressed.push(engineLinter)
  else if (run.program) suppressed.push(...unsafeAnyProblems(engineLinter, run.program, compiled))
  return compileProblems(run, byReal, suppressed)
}

/**
 * Each engine's `any` count against the committed ceiling, and every engine the compiled program missed.
 * @param {string} root @param {string[]} files @param {Gathered} g @param {Record<string, string[]>} sites @returns {string[]}
 */
function anyCountProblems(root, files, g, sites) {
  /** @type {string[]} */
  const out = []
  for (const at of g.map.values()) if (!sites[at.file] && at.file in g.anyCounts) out.push(`${at.file}: not in the compiled program, so its implicit \`any\` is uncounted`)
  const ceiling = readCeiling(root)
  out.push(...(typeof ceiling === 'string' ? [ceiling] : anyCeilingProblems(g.anyCounts, ceiling, files.map(f => `workflows/${f}`), sites)))
  return out
}

/**
 * One engine's source rules, wrapped copy (written into `dir`) and inlined modules, gathered into `g`.
 * @param {string} root @param {string} dir @param {TS} ts @param {string} f @param {Gathered} g
 */
function gatherEngine(root, dir, ts, f, g) {
  const src = fs.readFileSync(path.join(root, 'workflows', f), 'utf8')
  const parsed = parseEngine(src, ts)
  g.suppressed.push(...forbiddenCalls(parsed, `workflows/${f}`, ts))
  g.suppressed.push(...directiveProblems(parsed.sf, `workflows/${f}`))
  /** @type {{ text: string, offset: number }} */
  let wrapped
  try {
    wrapped = wrapWorkflow(src, root)
  } catch (e) {
    g.suppressed.push(`workflows/${f}: ${/** @type {Error} */ (e).message}`)
    return
  }
  const { text, offset } = wrapped
  g.anyCounts[`workflows/${f}`] = countAny(parsed, ts)   // after the wrap, which has already vouched for the fences
  for (const r of findRegions(src)) {
    const mod = g.inlined.get(r.source) ?? { text: readOrNull(path.join(root, r.source)), engines: [] }
    if (!mod.engines.includes(`workflows/${f}`)) mod.engines.push(`workflows/${f}`)
    g.inlined.set(r.source, mod)
  }
  const out = path.join(dir, f.replace(/\.js$/, '.mjs'))
  fs.writeFileSync(out, text)
  g.map.set(out, { file: `workflows/${f}`, offset, lines: src.split('\n').length })
}

/**
 * The `any` the checker sees in each engine's own lines (not the wrapper's, not the blanked regions),
 * added to `anyCounts` on top of the `any` spelled in its JSDoc: one ceiling holds both.
 * @param {TS} ts @param {import('./engine-checker.mjs').Program | null} program @param {Map<string, Wrapped>} byReal
 * @param {Record<string, number>} anyCounts
 * @returns {{ sites: Record<string, string[]>, compiled: Map<string, Wrapped> }}
 */
function countImplicitAny(ts, program, byReal, anyCounts) {
  /** @type {Record<string, string[]>} */
  const sites = {}
  /** @type {Map<string, Wrapped>} */
  const compiled = new Map()
  const checker = program?.getTypeChecker()
  for (const sf of program?.getSourceFiles() ?? []) {
    const at = byReal.get(realOrResolved(sf.fileName))
    if (!at || !checker) continue
    compiled.set(sf.fileName, at)
    const found = implicitAnySites(ts, checker, sf, at.offset, at.offset + at.lines)
    sites[at.file] = found.map(s => `${at.file}:${s.line - at.offset + 1} ${s.text}`)
    anyCounts[at.file] = (anyCounts[at.file] ?? 0) + found.length
  }
  return { sites, compiled }
}

/**
 * The type check of every engine; takes no arguments.
 * @param {string[]} _argv @param {NodeJS.ProcessEnv} _env  unused: it reads no environment
 * @param {string} [root]  the checkout to check
 * @returns {Promise<import('./script-main.mjs').ScriptResult>}
 */
export async function run(_argv, _env, root = ROOT) {
  /** @type {{ stdout: string[], stderr: string[] }} */
  const o = outputLines()
  const { problems, files } = checkWorkflowTypes(root)
  for (const p of problems) o.stderr.push(p)
  o.stdout.push(problems.length ? `${problems.length} problem(s): the workflow type check did not pass` : `ok    ${files} workflow scripts type-check`)
  return { exitCode: problems.length ? 1 : 0, ...o }
}

await runIfMain(import.meta.url, run)
