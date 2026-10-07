// Spike (realm @nick/craft, #208): which binding names did esbuild rename despite minifyIdentifiers:false?
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { parseEngine } from './analyze.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const dir = process.argv[2] ?? 'spike/out/min'

/** Binding identifiers (declarations, parameters), counted by name. @param {string} src */
function bindings(src) {
  const { sf } = parseEngine(src)
  const m = new Map()
  const visit = (/** @type {ts.Node} */ n) => {
    if ((ts.isVariableDeclaration(n) || ts.isParameter(n) || ts.isFunctionDeclaration(n) || ts.isBindingElement(n) || ts.isClassDeclaration(n)) && n.name && ts.isIdentifier(n.name)) {
      m.set(n.name.text, (m.get(n.name.text) ?? 0) + 1)
    }
    ts.forEachChild(n, visit)
  }
  visit(sf)
  return m
}
for (const f of fs.readdirSync(path.join(ROOT, 'workflows')).filter(x => x.endsWith('.js')).sort()) {
  const a = bindings(fs.readFileSync(path.join(ROOT, 'workflows', f), 'utf8'))
  const b = bindings(fs.readFileSync(path.join(ROOT, dir, f), 'utf8'))
  const added = [...b].filter(([k, n]) => n > (a.get(k) ?? 0)).map(([k]) => k)
  console.log(`${f}: ${added.length} new binding name(s)${added.length ? ': ' + added.slice(0, 30).join(', ') + (added.length > 30 ? ', …' : '') : ''}`)
}
