// Type-checks the engines' own code (workflows/*.js) at the strictness of lib/tsconfig.json. A
// workflow script is a sandbox body (top-level `return`, `await`), so each is wrapped the way the
// sandbox runs it — inside an async function — with the sandbox's globals from workflow-sandbox.d.ts.
// Every `craft-inline` region is swapped for an import of the same names from its lib module: that
// code is already checked there, and the engine around it then sees the real typed functions.
// Errors are reported at their line in workflows/<file>.js.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { findRegions, ROOT } from './inline-regions.mjs'
import { loadTypescript, runTsc, tscMissingMessage } from './run-tsc.mjs'
import { anyCeilingProblems, countAny, forbiddenCalls, inlinedAnyProblems } from './engine-source-rules.mjs'
import { parseJsonObject } from './json-object.mjs'

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
  // `meta` is read by the Workflow tool from outside the body, never inside it.
  const tail = /^ {7}const meta\b/m.test(lines.join('\n')) ? ['void meta'] : []
  return { text: [...head, ...lines, ...tail, '}', 'void __wf', ''].join('\n'), offset: head.length }
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

/** @param {string} root @returns {{ problems: string[], files: number }} */
export function checkWorkflowTypes(root = ROOT) {
  // Next to lib/ (not under /tmp), so a JSDoc `import('../lib/x.mjs')` resolves exactly as it does from workflows/.
  const dir = fs.mkdtempSync(path.join(root, '.wft-'))
  try {
    /** @type {Map<string, { file: string, offset: number, lines: number }>} */
    const map = new Map()
    const files = fs.readdirSync(path.join(root, 'workflows')).filter(f => f.endsWith('.js')).sort()
    if (!files.length) return { problems: ['no workflow scripts found under workflows/ — nothing was type-checked'], files: 0 }
    // The source rules parse with the same pinned TypeScript the check compiles with.
    const ts = loadTypescript(root)
    if (!ts) return { problems: [tscMissingMessage(root)], files: files.length }
    /** @type {string[]} */
    const suppressed = []
    /** @type {Record<string, number>} */
    const anyCounts = {}
    /** @type {Map<string, { text: string | null, engines: string[] }>} */
    const inlined = new Map()
    for (const f of files) {
      const src = fs.readFileSync(path.join(root, 'workflows', f), 'utf8')
      suppressed.push(...forbiddenCalls(src, `workflows/${f}`, ts))
      // An engine may not switch the check off, as an inlined lib module may not (typedScopeProblems).
      // Only where tsc honours one — in a comment — so prompt text that mentions a directive is fine.
      src.split('\n').forEach((l, i) => {
        const m = /^\s*(?:\/\/|\/\*+|\*)\s*(@ts-(?:nocheck|ignore|expect-error))\b/.exec(l)
        if (m) suppressed.push(`workflows/${f}:${i + 1} switches the type check off with ${m[1]}`)
      })
      /** @type {{ text: string, offset: number }} */
      let wrapped
      try {
        wrapped = wrapWorkflow(src, root)
      } catch (e) {
        suppressed.push(`workflows/${f}: ${/** @type {Error} */ (e).message}`)
        continue
      }
      const { text, offset } = wrapped
      anyCounts[`workflows/${f}`] = countAny(src, ts)   // after the wrap, which has already vouched for the fences
      for (const r of findRegions(src)) {
        const mod = inlined.get(r.source) ?? { text: readOrNull(path.join(root, r.source)), engines: [] }
        if (!mod.engines.includes(`workflows/${f}`)) mod.engines.push(`workflows/${f}`)
        inlined.set(r.source, mod)
      }
      const out = path.join(dir, f.replace(/\.js$/, '.mjs'))
      fs.writeFileSync(out, text)
      map.set(out, { file: `workflows/${f}`, offset, lines: src.split('\n').length })
    }
    const ceiling = readCeiling(root)
    suppressed.push(...(typeof ceiling === 'string' ? [ceiling] : anyCeilingProblems(anyCounts, ceiling, files.map(f => `workflows/${f}`))))
    suppressed.push(...inlinedAnyProblems(inlined, ts))
    fs.writeFileSync(path.join(dir, 'tsconfig.json'), JSON.stringify({
      extends: path.join(root, 'lib', 'tsconfig.json'),
      // The sandbox has no Node API: no @types/node here. skipLibCheck off, so the sandbox declaration
      // is itself checked rather than read on trust.
      compilerOptions: { types: [], skipLibCheck: false },
      include: [path.join(dir, '*.mjs'), path.join(root, 'lib', 'workflow-sandbox.d.ts')], exclude: [],
    }))
    const run = runTsc(root, ['-p', path.join(dir, 'tsconfig.json'), '--pretty', 'false'])
    if (run.missing) return { problems: [...suppressed, tscMissingMessage(root)], files: files.length }
    const status = run.status
    const out = `${run.stdout}\n${run.stderr}`
    if (run.overflow) suppressed.push('tsc output exceeded the buffer — the diagnostics below are truncated')
    // Fail closed: tsc that exited non-zero checked nothing we can vouch for, whatever it printed.
    const real = (/** @type {string} */ p) => { try { return fs.realpathSync(p) } catch { return path.resolve(p) } }
    const byReal = new Map([...map].map(([k, v]) => [real(k), v]))
    /** @type {string[]} */
    const problems = [...suppressed]
    const outLines = out.split('\n')
    for (let k = 0; k < outLines.length; k++) {
      const line = /** @type {string} */ (outLines[k])
      if (!/(^|\s)error TS\d+/.test(line)) continue
      // tsc's elaboration ("Types of property … are incompatible") follows on indented lines.
      let more = ''
      while (k + 1 < outLines.length && /^\s+\S/.test(/** @type {string} */ (outLines[k + 1]))) more += `\n  ${/** @type {string} */ (outLines[++k]).trim()}`
      const m = /^(.*?)\((\d+),(\d+)\): (.*)$/.exec(line)
      const at = m && byReal.get(real(/** @type {string} */ (m[1])))
      if (!m || !at) { problems.push(line.trim() + more); continue }
      const n = Number(m[2]) - at.offset
      problems.push((n >= 1 && n <= at.lines
        ? `${at.file}:${n}:${m[3]} ${m[4]}`
        : `${at.file} (lines the checker adds: a craft-inline import or the sandbox wrapper): ${m[4]}`) + more)
    }
    if (status !== 0 && !problems.length) problems.push(`tsc exited ${status} with no diagnostic to report: ${out.trim().split('\n').slice(0, 3).join(' | ') || '(no output)'}`)
    return { problems, files: files.length }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

// By real path, not by URL text: a checkout under a path with spaces or a symlink must still run the gate.
if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))) {
  const { problems, files } = checkWorkflowTypes()
  for (const p of problems) console.error(p)
  console.log(problems.length ? `${problems.length} problem(s): the workflow type check did not pass` : `ok    ${files} workflow scripts type-check`)
  process.exit(problems.length ? 1 : 0)
}
