// Type-checks the engines' own code (workflows/*.js) at the strictness of lib/tsconfig.json. A
// workflow script is a sandbox body (top-level `return`, `await`), so each is wrapped the way the
// sandbox runs it — inside an async function — with the sandbox's globals from workflow-sandbox.d.ts.
// Every `craft-inline` region is swapped for an import of the same names from its lib module: that
// code is already checked there, and the engine around it then sees the real typed functions.
// Errors are reported at their line in workflows/<file>.js.
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { findRegions, ROOT } from './inline-regions.mjs'

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

/** @param {string} root @returns {{ problems: string[], files: number }} */
export function checkWorkflowTypes(root = ROOT) {
  // Next to lib/ (not under /tmp), so a JSDoc `import('../lib/x.mjs')` resolves exactly as it does from workflows/.
  const dir = fs.mkdtempSync(path.join(root, '.wft-'))
  try {
    /** @type {Map<string, { file: string, offset: number, lines: number }>} */
    const map = new Map()
    const files = fs.readdirSync(path.join(root, 'workflows')).filter(f => f.endsWith('.js')).sort()
    if (!files.length) return { problems: ['no workflow scripts found under workflows/ — nothing was type-checked'], files: 0 }
    /** @type {string[]} */
    const suppressed = []
    for (const f of files) {
      const src = fs.readFileSync(path.join(root, 'workflows', f), 'utf8')
      // An engine may not switch the check off, as an inlined lib module may not (typedScopeProblems).
      src.split('\n').forEach((l, i) => {
        const m = /@ts-(?:nocheck|ignore|expect-error)\b/.exec(l)
        if (m) suppressed.push(`workflows/${f}:${i + 1} switches the type check off with ${m[0]}`)
      })
      const { text, offset } = wrapWorkflow(src, root)
      const out = path.join(dir, f.replace(/\.js$/, '.mjs'))
      fs.writeFileSync(out, text)
      map.set(out, { file: `workflows/${f}`, offset, lines: src.split('\n').length })
    }
    fs.writeFileSync(path.join(dir, 'tsconfig.json'), JSON.stringify({
      extends: path.join(root, 'lib', 'tsconfig.json'),
      // The sandbox has no Node API: no @types/node here. skipLibCheck off, so the sandbox declaration
      // is itself checked rather than read on trust.
      compilerOptions: { types: [], skipLibCheck: false },
      include: [path.join(dir, '*.mjs'), path.join(root, 'lib', 'workflow-sandbox.d.ts')], exclude: [],
    }))
    const tsc = path.join(root, 'opencode', 'plugin', 'node_modules', '.bin', 'tsc')
    let out = ''
    let status = 0
    try {
      execFileSync(tsc, ['-p', path.join(dir, 'tsconfig.json'), '--pretty', 'false'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 })
    } catch (e) {
      const err = /** @type {{ code?: string, status?: number | null, stdout?: string, stderr?: string, message?: string }} */ (e)
      if (err.code === 'ENOENT') return { problems: [`tsc is not installed — run npm ci --prefix opencode/plugin`], files: files.length }
      if (err.code === 'ENOBUFS') suppressed.push('tsc output exceeded the buffer — the diagnostics below are truncated')
      status = typeof err.status === 'number' ? err.status : 1
      out = `${err.stdout || ''}\n${err.stderr || ''}`
      if (!err.stdout && !err.stderr) out = String(err.message || e)
    }
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
  console.log(problems.length ? `${problems.length} type error(s) in workflows/` : `ok    ${files} workflow scripts type-check`)
  process.exit(problems.length ? 1 : 0)
}
