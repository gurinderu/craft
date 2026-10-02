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
    /** @type {Map<string, { file: string, offset: number }>} */
    const map = new Map()
    const files = fs.readdirSync(path.join(root, 'workflows')).filter(f => f.endsWith('.js')).sort()
    for (const f of files) {
      const { text, offset } = wrapWorkflow(fs.readFileSync(path.join(root, 'workflows', f), 'utf8'), root)
      const out = path.join(dir, f.replace(/\.js$/, '.mjs'))
      fs.writeFileSync(out, text)
      map.set(out, { file: `workflows/${f}`, offset })
    }
    fs.writeFileSync(path.join(dir, 'tsconfig.json'), JSON.stringify({
      extends: path.join(root, 'lib', 'tsconfig.json'),
      compilerOptions: { typeRoots: [path.join(root, 'node_modules', '@types')] },
      include: [path.join(dir, '*.mjs'), path.join(root, 'lib', 'workflow-sandbox.d.ts')], exclude: [],
    }))
    const tsc = path.join(root, 'opencode', 'plugin', 'node_modules', '.bin', 'tsc')
    let out = ''
    try {
      execFileSync(tsc, ['-p', path.join(dir, 'tsconfig.json'), '--pretty', 'false'], { encoding: 'utf8' })
    } catch (e) {
      const err = /** @type {{ code?: string, stdout?: string }} */ (e)
      if (err.code === 'ENOENT') return { problems: [`tsc is not installed — run npm ci --prefix opencode/plugin`], files: files.length }
      out = String(err.stdout || '')
    }
    const problems = []
    for (const line of out.split('\n').filter(l => / error TS\d+/.test(l))) {
      const m = /^(.*?)\((\d+),(\d+)\): (.*)$/.exec(line)
      const at = m && map.get(path.resolve(/** @type {string} */ (m[1])))
      problems.push(m && at ? `${at.file}:${Number(m[2]) - at.offset}:${m[3]} ${m[4]}` : line)
    }
    return { problems, files: files.length }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { problems, files } = checkWorkflowTypes()
  for (const p of problems) console.error(p)
  console.log(problems.length ? `${problems.length} type error(s) in workflows/` : `ok    ${files} workflow scripts type-check`)
  process.exit(problems.length ? 1 : 0)
}
