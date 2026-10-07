// Spike driver (realm @nick/craft, #208): sizes, byte breakdown, meta shape, sandbox parse, literal invariance.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { breakdown, stripComments, literals } from './analyze.mjs'
import { minifyEngine } from './minify.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const OUT = path.join(ROOT, 'spike', 'out')
const engines = fs.readdirSync(path.join(ROOT, 'workflows')).filter(f => f.endsWith('.js')).sort()
const B = (/** @type {string} */ s) => Buffer.byteLength(s, 'utf8')

function sandboxParse(/** @type {string} */ src) {
  try { new Function(`async function __wf(){\n${src.replace(/^export const meta/m, 'const meta')}\n}`); return 'ok' } catch (e) { return 'FAIL ' + e.message }
}
function multisetDiff(/** @type {string[]} */ a, /** @type {string[]} */ b) {
  const m = new Map()
  for (const x of a) m.set(x, (m.get(x) ?? 0) + 1)
  for (const x of b) m.set(x, (m.get(x) ?? 0) - 1)
  return [...m].filter(([, n]) => n !== 0)
}
// meta: the first statement must be `export const meta = {…}` whose initializer is a pure object literal
// (string/number/boolean/array/object values only, no identifiers, calls, spreads or templates with substitutions).
async function metaShape(/** @type {string} */ src) {
  const { default: ts } = await import('typescript')
  const sf = ts.createSourceFile('m.mjs', src.replace(/\breturn\b/g, 'void '), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
  const st = sf.statements[0]
  if (!st || !ts.isVariableStatement(st)) return 'first statement is not a variable statement'
  const exp = st.modifiers?.some(m => m.kind === ts.SyntaxKind.ExportKeyword)
  const decls = st.declarationList.declarations
  const kw = st.declarationList.flags & ts.NodeFlags.Const ? 'const' : st.declarationList.flags & ts.NodeFlags.Let ? 'let' : 'var'
  const d = decls[0]
  const pure = (/** @type {ts.Node} */ n) => ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n) || ts.isNumericLiteral(n) ||
    n.kind === ts.SyntaxKind.TrueKeyword || n.kind === ts.SyntaxKind.FalseKeyword || n.kind === ts.SyntaxKind.NullKeyword ||
    (ts.isPrefixUnaryExpression(n) && n.operator === ts.SyntaxKind.ExclamationToken && ts.isNumericLiteral(n.operand)) ||
    (ts.isArrayLiteralExpression(n) && n.elements.every(pure)) ||
    (ts.isObjectLiteralExpression(n) && n.properties.every(p => ts.isPropertyAssignment(p) && pure(p.initializer)))
  const notes = []
  if (!exp) notes.push('no export')
  if (kw !== 'const') notes.push(`keyword ${kw}`)
  if (d.name.getText(sf) !== 'meta') notes.push('first declarator is ' + d.name.getText(sf))
  if (decls.length > 1) notes.push(`${decls.length} declarators merged into the meta statement`)
  if (!d.initializer || !pure(d.initializer)) notes.push('initializer not a pure literal: ' + d.initializer?.getText(sf).slice(0, 200))
  const nst = d.initializer && ts.isObjectLiteralExpression(d.initializer) ? d.initializer.properties.filter(p => ts.isPropertyAssignment(p) && ts.isNoSubstitutionTemplateLiteral(p.initializer)).length : 0
  if (nst) notes.push(`${nst} value(s) as backtick templates`)
  return notes.length ? notes.join('; ') : 'ok'
}

const rows = []
for (const v of ['stripped', 'min', 'syntax']) fs.mkdirSync(path.join(OUT, v), { recursive: true })
for (const f of engines) {
  const src = fs.readFileSync(path.join(ROOT, 'workflows', f), 'utf8')
  const stripped = stripComments(src)
  const min = await minifyEngine(src, { whitespace: true })
  const syn = await minifyEngine(src, { whitespace: false })
  fs.writeFileSync(path.join(OUT, 'stripped', f), stripped)
  fs.writeFileSync(path.join(OUT, 'min', f), min.code)
  fs.writeFileSync(path.join(OUT, 'syntax', f), syn.code)
  const { r } = breakdown(src)
  const L0 = literals(src)
  const lit = {}
  for (const [k, code] of [['stripped', stripped], ['min', min.code], ['syntax', syn.code]]) {
    const L = literals(code)
    lit[k] = { flat: multisetDiff(L0.flat, L.flat), templates: multisetDiff(L0.templates, L.templates) }
  }
  rows.push({
    f, sizes: { raw: B(src), stripped: B(stripped), min: B(min.code), syntax: B(syn.code) }, breakdown: r,
    head: { min: min.code.slice(0, 60), syntax: syn.code.slice(0, 60) },
    meta: { raw: await metaShape(src), stripped: await metaShape(stripped), min: await metaShape(min.code), syntax: await metaShape(syn.code) },
    parse: { stripped: sandboxParse(stripped), min: sandboxParse(min.code), syntax: sandboxParse(syn.code) },
    warnings: min.warnings.length + syn.warnings.length,
    lit,
    lines: { raw: src.split('\n').length, min: min.code.split('\n').length, syntax: syn.code.split('\n').length },
  })
}
fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(rows, null, 2))
for (const x of rows) {
  console.log(`\n== ${x.f}`)
  console.log('sizes', JSON.stringify(x.sizes), 'lines', JSON.stringify(x.lines))
  console.log('breakdown', JSON.stringify(x.breakdown))
  console.log('meta', JSON.stringify(x.meta))
  console.log('head', JSON.stringify(x.head))
  console.log('parse', JSON.stringify(x.parse), 'warnings', x.warnings)
  for (const [k, d] of Object.entries(x.lit)) console.log(`literals ${k}: flat diffs ${d.flat.length}, template diffs ${d.templates.length}`)
}
