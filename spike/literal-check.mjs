// Spike (realm @nick/craft, #208): explain every literal that differs between an engine and its minified form.
// Two lawful rewrites are expected from minifySyntax: a quoted key or `x["k"]` becoming an identifier
// (`{k:…}`, `x.k`), and adjacent constant pieces folded into one template. Anything else is reported.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { parseEngine } from './analyze.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const variant = process.argv[2] ?? 'min'

/** Every literal, in source order: kind 's' (string or plain template), 't' (template parts), 'k' (identifier key / member name). @param {string} src */
function items(src) {
  const { sf } = parseEngine(src)
  const out = []
  const visit = (/** @type {ts.Node} */ n) => {
    if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) out.push({ k: 's', v: n.text })
    else if (ts.isTemplateExpression(n)) out.push({ k: 't', v: [n.head.text, ...n.templateSpans.map(s => s.literal.text)] })
    else if (ts.isPropertyAssignment(n) && ts.isIdentifier(n.name)) out.push({ k: 'k', v: n.name.text })
    else if (ts.isPropertyAccessExpression(n)) out.push({ k: 'k', v: n.name.text })
    ts.forEachChild(n, visit)
  }
  visit(sf)
  return out
}
const count = (/** @type {string[]} */ xs) => xs.reduce((m, x) => m.set(x, (m.get(x) ?? 0) + 1), new Map())

let unexplained = 0
for (const f of fs.readdirSync(path.join(ROOT, 'workflows')).filter(x => x.endsWith('.js')).sort()) {
  const a = items(fs.readFileSync(path.join(ROOT, 'workflows', f), 'utf8'))
  const b = items(fs.readFileSync(path.join(ROOT, 'spike', 'out', variant, f), 'utf8'))
  const strA = count(a.filter(x => x.k === 's').map(x => x.v)), strB = count(b.filter(x => x.k === 's').map(x => x.v))
  const keyA = count(a.filter(x => x.k === 'k').map(x => x.v)), keyB = count(b.filter(x => x.k === 'k').map(x => x.v))
  const tA = count(a.filter(x => x.k === 't').map(x => JSON.stringify(x.v))), tB = count(b.filter(x => x.k === 't').map(x => JSON.stringify(x.v)))
  let keyed = 0, folded = 0
  const lost = []
  for (const [s, n] of strA) {
    const d = n - (strB.get(s) ?? 0)
    if (d <= 0) continue
    // became an identifier key: the minified output has that many more identifier keys of that name
    const gained = (keyB.get(s) ?? 0) - (keyA.get(s) ?? 0)
    const k = Math.min(d, Math.max(0, gained)); keyed += k
    for (let i = 0; i < d - k; i++) lost.push(s)
  }
  // Templates: every changed template in the output must be the in-order concatenation of removed pieces.
  const removedT = [...tA].flatMap(([s, n]) => Array(Math.max(0, n - (tB.get(s) ?? 0))).fill(JSON.parse(s)))
  const addedT = [...tB].flatMap(([s, n]) => Array(Math.max(0, n - (tA.get(s) ?? 0))).fill(JSON.parse(s)))
  const pool = [...removedT.map(p => p.join('\u0001')), ...lost]   // \u0001 marks a substitution boundary
  for (const t of addedT) {
    let rest = t.join('\u0001')
    // greedily consume pool pieces that tile `rest`, each piece separated by nothing or by a substitution boundary
    let progress = true
    while (rest.length && progress) {
      progress = false
      rest = rest.replace(/^\u0001/, '')
      for (let i = 0; i < pool.length; i++) {
        if (pool[i] !== '' && rest.startsWith(pool[i])) { rest = rest.slice(pool[i].length); pool.splice(i, 1); progress = true; folded++; break }
      }
    }
    rest = rest.replace(/\u0001/g, '')
    if (rest.length) { unexplained++; console.log(`UNEXPLAINED template in ${f}: …${JSON.stringify(rest.slice(0, 160))}`) }
  }
  const leftovers = pool.filter(p => p.replace(/\u0001/g, '') !== '')
  for (const p of leftovers) { unexplained++; console.log(`UNEXPLAINED vanished literal in ${f}: ${JSON.stringify(p.slice(0, 160))}`) }
  for (const [s, n] of strB) if (n > (strA.get(s) ?? 0)) { unexplained++; console.log(`UNEXPLAINED new string in ${f}: ${JSON.stringify(s.slice(0, 160))}`) }
  console.log(`${f}: quoted→identifier keys ${keyed}, pieces folded into templates ${folded}, templates changed ${addedT.length}`)
}
console.log(unexplained ? `${unexplained} unexplained literal change(s)` : 'every literal change is a key unquoting or a constant fold; no text changed')
process.exitCode = unexplained ? 1 : 0
