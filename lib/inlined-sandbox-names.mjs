// Inlined code is type-checked in its lib module, against Node typings, where TextEncoder, process,
// performance and the rest all exist — the Workflow sandbox has none of them (realm @nick/craft, #135).
// So each engine is compiled once more AS IT SHIPS, regions in place, against the ES library and the
// sandbox declarations only, and every name inside a region that resolves to neither is refused.
// An allowlist by construction: no list of absent globals to keep current, and `globalThis.X` is
// caught too, since `typeof globalThis` then carries only what the sandbox declares.
import fs from 'node:fs'
import path from 'node:path'
import { findRegions } from './inline-regions.mjs'

/** @typedef {typeof import('../opencode/plugin/node_modules/typescript/lib/typescript.js')} TS */

// Name resolution only: every other diagnostic of the inlined code is lib/'s to report.
const FREE_NAME = new Set([2304, 2552, 2580, 2581, 2582, 2583, 2584, 2591, 2592, 2593])
const VIA_GLOBALTHIS = new Set([2339, 2551, 7017, 7053])

/**
 * @param {string} root
 * @param {TS} ts
 * @returns {string[]} one line per refused name: `<file>:<line> :: …`
 */
export function inlinedNameProblems(root, ts) {
  const dir = fs.mkdtempSync(path.join(root, '.wfn-'))
  try {
    /** @type {Map<string, { file: string, regions: { open: number, close: number, source: string }[] }>} */
    const map = new Map()
    for (const f of fs.readdirSync(path.join(root, 'workflows')).filter(n => n.endsWith('.js')).sort()) {
      const src = fs.readFileSync(path.join(root, 'workflows', f), 'utf8')
      const regions = findRegions(src).map(r => ({ open: r.open, close: r.close, source: r.source }))
      if (!regions.length) continue
      // One line of head, so source line N is line N + 1 here; `export {}` keeps each file its own module.
      const text = ['async function __wf() {', src.replace(/^export const meta/m, '       const meta'), '}', 'void __wf', 'export {}', ''].join('\n')
      const out = path.join(dir, f.replace(/\.js$/, '.mjs'))
      fs.writeFileSync(out, text)
      map.set(path.resolve(out), { file: `workflows/${f}`, regions })
    }
    const read = ts.readConfigFile(path.join(root, 'lib', 'tsconfig.json'), ts.sys.readFile)
    const base = ts.parseJsonConfigFileContent(read.config, ts.sys, path.join(root, 'lib'))
    const options = { ...base.options, types: [], noEmit: true }
    const program = ts.createProgram([...map.keys(), path.join(root, 'lib', 'workflow-sandbox.d.ts')], options)
    /** @type {string[]} */
    const problems = []
    for (const [file, at] of map) {
      const sf = program.getSourceFile(file)
      if (!sf) { problems.push(`${at.file}: not compiled — the inlined-name check saw nothing of it`); continue }
      for (const d of program.getSemanticDiagnostics(sf)) {
        if (d.start === undefined) continue
        const message = ts.flattenDiagnosticMessageText(d.messageText, ' ')
        if (!FREE_NAME.has(d.code) && !(VIA_GLOBALTHIS.has(d.code) && /typeof globalThis/.test(message))) continue
        if (!startsCode(ts, sf, d.start)) continue   // a JSDoc type name — lib/ resolves those
        const line = sf.getLineAndCharacterOfPosition(d.start).line   // 0-based here, and one head line: = the source's 1-based line
        const region = at.regions.find(r => line - 1 >= r.open && line - 1 <= r.close)
        if (region) problems.push(`${at.file}:${line} :: inlined code from ${region.source} uses a name the Workflow sandbox does not provide — ${message}`)
      }
      // In a JS file TypeScript reads `require(…)` as an import, not as a free name, so it raises nothing.
      /** @param {import('../opencode/plugin/node_modules/typescript/lib/typescript.js').Node} node */
      const visit = node => {
        if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'require') {
          const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line
          const region = at.regions.find(r => line - 1 >= r.open && line - 1 <= r.close)
          if (region) problems.push(`${at.file}:${line} :: inlined code from ${region.source} calls require, which the Workflow sandbox does not provide`)
        }
        ts.forEachChild(node, visit)
      }
      visit(sf)
    }
    return problems
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

/**
 * True when `pos` starts a token of the code itself — not one inside a comment, where JSDoc lives
 * (the AST walk does not descend into JSDoc, so a position there is reached by no code node).
 * @param {TS} ts @param {import('../opencode/plugin/node_modules/typescript/lib/typescript.js').SourceFile} sf @param {number} pos
 */
function startsCode(ts, sf, pos) {
  /** @param {import('../opencode/plugin/node_modules/typescript/lib/typescript.js').Node} node @returns {boolean} */
  const hit = node => {
    if (node.getStart(sf) === pos) return true
    return node.pos <= pos && pos < node.end && (ts.forEachChild(node, hit) ?? false)
  }
  return ts.forEachChild(sf, hit) ?? false
}
