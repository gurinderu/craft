// Type-checks the engines' own code (workflows/*.js) at the strictness of lib/tsconfig.json. A
// workflow script is a sandbox body (top-level `return`, `await`), so each is wrapped the way the
// sandbox runs it — inside an async function — with the sandbox's globals from workflow-sandbox.d.ts.
// Every `craft-inline` region is swapped for an import of the same names from its lib module: that
// code is already checked there, and the engine around it then sees the real typed functions.
// Errors are reported at their line in workflows/<file>.js.
import fs from 'node:fs'
import os from 'node:os'
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
  // A JSDoc `import('../lib/x.mjs')` is relative to workflows/; the wrapped copy lives elsewhere.
  const lines = src.replace(/^export const meta/m, 'const meta')
    .replace(/import\((['"])\.\.\/lib\//g, (_m, q) => `import(${q}${path.join(root, 'lib')}/`)
    .split('\n')
  const head = []
  for (const r of findRegions(src)) {
    for (let i = r.open; i <= r.close; i++) lines[i] = ''
    head.push(`import { ${r.names.join(', ')} } from ${JSON.stringify(path.join(root, r.source))}`)
    head.push(`void [${r.names.join(', ')}]`)
  }
  head.push('async function __wf() {')
  // `meta` is read by the Workflow tool from outside the body, never inside it.
  const tail = /^const meta\b/m.test(lines.join('\n')) ? ['void meta'] : []
  return { text: [...head, ...lines, ...tail, '}', 'void __wf', ''].join('\n'), offset: head.length }
}

/** @param {string} root @returns {{ problems: string[], files: number }} */
export function checkWorkflowTypes(root = ROOT) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'craft-wf-types-'))
  try {
    /** @type {Map<string, { file: string, offset: number, lines: number }>} */
    const map = new Map()
    const files = fs.readdirSync(path.join(root, 'workflows')).filter(f => f.endsWith('.js')).sort()
    for (const f of files) {
      const src = fs.readFileSync(path.join(root, 'workflows', f), 'utf8')
      const { text, offset } = wrapWorkflow(src, root)
      const out = path.join(dir, f.replace(/\.js$/, '.mjs'))
      fs.writeFileSync(out, text)
      map.set(out, { file: `workflows/${f}`, offset, lines: src.split('\n').length })
    }
    fs.writeFileSync(path.join(dir, 'tsconfig.json'), JSON.stringify({
      extends: path.join(root, 'lib', 'tsconfig.json'),
      compilerOptions: { typeRoots: [path.join(root, 'node_modules', '@types')] },
      include: [path.join(dir, '*.mjs'), path.join(root, 'lib', 'workflow-sandbox.d.ts')], exclude: [],
    }))
    const tsc = path.join(root, 'opencode', 'plugin', 'node_modules', '.bin', 'tsc')
    let out = ''
    let status = 0
    try {
      execFileSync(tsc, ['-p', path.join(dir, 'tsconfig.json'), '--pretty', 'false'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (e) {
      const err = /** @type {{ code?: string, status?: number | null, stdout?: string, stderr?: string, message?: string }} */ (e)
      if (err.code === 'ENOENT') return { problems: [`tsc is not installed — run npm ci --prefix opencode/plugin`], files: files.length }
      status = typeof err.status === 'number' ? err.status : 1
      out = `${err.stdout || ''}\n${err.stderr || ''}`
      if (!err.stdout && !err.stderr) out = String(err.message || e)
    }
    // Fail closed: tsc that exited non-zero checked nothing we can vouch for, whatever it printed.
    const real = (/** @type {string} */ p) => { try { return fs.realpathSync(p) } catch { return path.resolve(p) } }
    const byReal = new Map([...map].map(([k, v]) => [real(k), v]))
    /** @type {string[]} */
    const problems = []
    for (const line of out.split('\n').filter(l => /(^|\s)error TS\d+/.test(l))) {
      const m = /^(.*?)\((\d+),(\d+)\): (.*)$/.exec(line)
      const at = m && byReal.get(real(/** @type {string} */ (m[1])))
      if (!m || !at) { problems.push(line.trim()); continue }
      const n = Number(m[2]) - at.offset
      problems.push(n >= 1 && n <= at.lines
        ? `${at.file}:${n}:${m[3]} ${m[4]}`
        : `${at.file} (lines the checker adds: a craft-inline import or the sandbox wrapper): ${m[4]}`)
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
