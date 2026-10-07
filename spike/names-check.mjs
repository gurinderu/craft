// Spike (realm @nick/craft, #208): the sandbox-names check (lib/inlined-sandbox-names.mjs, #134/#135) over a
// WHOLE engine, raw and minified. The real check reads only craft-inline regions, which minifying erases
// (the fences are comments), so here every free name and host route in the whole file is listed for both
// forms and the two sets are compared: minifying must add none.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const FREE_NAME = new Set([2304, 2552, 2580, 2581, 2582, 2583, 2584, 2585, 2591, 2592, 2593, 2662, 2663, 2693, 18004])
const HEAD = 'async function __wf() {\n'
const variant = process.argv[2] ?? 'min'

function names(/** @type {Record<string,string>} */ files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'craft-spike-'))
  try {
    const paths = Object.entries(files).map(([f, src]) => {
      const p = path.join(dir, f.replace(/\.js$/, '.mjs'))
      fs.writeFileSync(p, HEAD + [src.replace(/^export const meta/m, '       const meta'), '}', 'void __wf', 'export {}', ''].join('\n'))
      return [f, p]
    })
    const program = ts.createProgram([...paths.map(x => x[1]), path.join(ROOT, 'lib', 'workflow-sandbox.d.ts')],
      { allowJs: true, checkJs: true, noEmit: true, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, lib: ['lib.es2023.d.ts'], types: [], typeRoots: [] })
    /** @type {Record<string, Set<string>>} */
    const out = {}
    for (const [f, p] of paths) {
      const sf = /** @type {ts.SourceFile} */ (program.getSourceFile(p))
      const s = new Set()
      for (const d of program.getSemanticDiagnostics(sf)) {
        if (d.start !== undefined && FREE_NAME.has(d.code)) s.add('free:' + sf.text.slice(d.start, d.start + (d.length ?? 0)))
      }
      const visit = (/** @type {ts.Node} */ n) => {
        if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === 'require') s.add('route:require')
        if (ts.isMetaProperty(n)) s.add('route:import.meta')
        if (n.kind === ts.SyntaxKind.ImportKeyword && ts.isCallExpression(n.parent)) s.add('route:import()')
        if (ts.isIdentifier(n) && ['globalThis', 'eval', 'Function'].includes(n.text) && !(ts.isPropertyAccessExpression(n.parent) && n.parent.name === n)) s.add('route:' + n.text)
        ts.forEachChild(n, visit)
      }
      visit(sf)
      out[f] = s
    }
    return out
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
}

const engines = fs.readdirSync(path.join(ROOT, 'workflows')).filter(x => x.endsWith('.js')).sort()
const raw = names(Object.fromEntries(engines.map(f => [f, fs.readFileSync(path.join(ROOT, 'workflows', f), 'utf8')])))
const min = names(Object.fromEntries(engines.map(f => [f, fs.readFileSync(path.join(ROOT, 'spike', 'out', variant, f), 'utf8')])))
let added = 0
for (const f of engines) {
  const plus = [...min[f]].filter(x => !raw[f].has(x)), minus = [...raw[f]].filter(x => !min[f].has(x))
  added += plus.length
  console.log(`${f}: raw ${raw[f].size} free names/routes [${[...raw[f]].join(' ')}]; ${variant} adds [${plus.join(' ')}] drops [${minus.join(' ')}]`)
}
process.exitCode = added ? 1 : 0
