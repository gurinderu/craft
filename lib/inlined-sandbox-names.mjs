// Inlined code is type-checked in its lib module, against Node typings, where TextEncoder, process,
// performance and the rest all exist — the Workflow sandbox has none of them (realm @nick/craft, #135).
// So each engine is compiled once more AS IT SHIPS, regions in place, against the ES library and the
// sandbox declarations only, and every name inside a region that resolves to neither is refused: an
// allowlist by construction, with no list of absent globals to keep current. Three routes around name
// resolution are closed explicitly: `require(…)`, which TypeScript reads as an import in JS;
// `globalThis`, whose casts and reflection reach any property (inlined code has no use for it); and a
// program that is not closed — a file beyond the ES library and the sandbox declaration would bring
// its own globals in, so one is a failure, not a quiet widening.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { findRegions } from './inline-regions.mjs'

/** @typedef {typeof import('../opencode/plugin/node_modules/typescript/lib/typescript.js')} TS */
/** @typedef {import('../opencode/plugin/node_modules/typescript/lib/typescript.js').Node} TsNode */
/** @typedef {import('../opencode/plugin/node_modules/typescript/lib/typescript.js').SourceFile} TsSourceFile */

// Name resolution only: every other diagnostic of the inlined code is lib/'s to report. 2304/2552
// cannot find (did you mean); 2580-2584, 2591-2593 the same with an install or lib hint; 2585 a value
// that is only a type here; 2662/2663 a free name that matches a class member; 18004 a shorthand
// property with no value in scope.
const FREE_NAME = new Set([2304, 2552, 2580, 2581, 2582, 2583, 2584, 2585, 2591, 2592, 2593, 2662, 2663, 18004])
const HEAD = 'async function __wf() {\n'

/**
 * @param {string} root
 * @param {TS} ts
 * @returns {string[]} one line per refused name: `<file>:<line> :: …`
 */
export function inlinedNameProblems(root, ts) {
  // Outside the repo: nothing beside these files resolves an import into the program, and a killed run
  // leaves no engine copies in the working tree.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'craft-wfn-'))
  try {
    /** @type {Map<string, { file: string, regions: { start: number, end: number, source: string }[] }>} */
    const map = new Map()
    for (const f of fs.readdirSync(path.join(root, 'workflows')).filter(n => n.endsWith('.js')).sort()) {
      const src = fs.readFileSync(path.join(root, 'workflows', f), 'utf8')
      /** @type {number[]} */
      const at = []   // offset in the compiled text of each source line, lines counted as findRegions counts them
      let off = HEAD.length
      for (const l of src.split('\n')) { at.push(off); off += l.length + 1 }
      const regions = findRegions(src).map(r => ({ start: /** @type {number} */ (at[r.open]), end: at[r.close + 1] ?? off, source: r.source }))
      if (!regions.length) continue
      // `export {}` keeps each file its own module; `export const meta` loses only its keyword.
      const text = HEAD + [src.replace(/^export const meta/m, '       const meta'), '}', 'void __wf', 'export {}', ''].join('\n')
      const out = path.resolve(dir, f.replace(/\.js$/, '.mjs'))
      fs.writeFileSync(out, text)
      map.set(out, { file: `workflows/${f}`, regions })
    }
    const read = ts.readConfigFile(path.join(root, 'lib', 'tsconfig.json'), ts.sys.readFile)
    const base = ts.parseJsonConfigFileContent(read.config, ts.sys, path.join(root, 'lib'))
    const sandbox = path.resolve(root, 'lib', 'workflow-sandbox.d.ts')
    const program = ts.createProgram([...map.keys(), sandbox], { ...base.options, types: [], typeRoots: [], noEmit: true })
    /** @type {string[]} */
    const problems = []
    for (const sf of program.getSourceFiles()) {
      const p = path.resolve(sf.fileName)
      if (!map.has(p) && p !== sandbox && !program.isSourceFileDefaultLibrary(sf)) {
        problems.push(`the inlined-name check compiled ${sf.fileName}, which can declare globals the sandbox lacks — its program must hold only the engines, the ES library and lib/workflow-sandbox.d.ts`)
      }
    }
    for (const [file, at] of map) {
      const sf = program.getSourceFile(file)
      if (!sf) { problems.push(`${at.file}: not compiled — the inlined-name check saw nothing of it`); continue }
      /** @param {number} pos @param {string} what */
      const refuse = (pos, what) => {
        const region = at.regions.find(r => pos >= r.start && pos < r.end)
        if (region) problems.push(`${at.file}:${lineOf(sf.text, pos)} :: inlined code from ${region.source} ${what}`)
      }
      for (const d of program.getSemanticDiagnostics(sf)) {
        if (d.start === undefined || !FREE_NAME.has(d.code)) continue
        if (!startsCode(ts, sf, d.start)) continue   // a JSDoc type name — lib/ resolves those
        refuse(d.start, `uses a name the Workflow sandbox does not provide — ${ts.flattenDiagnosticMessageText(d.messageText, ' ')}`)
      }
      /** @param {TsNode} node */
      const visit = node => {
        if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'require') {
          refuse(node.getStart(sf), 'calls require, which the Workflow sandbox does not provide')
        }
        if (ts.isIdentifier(node) && node.text === 'globalThis') refuse(node.getStart(sf), 'reaches for globalThis, which carries more in Node than in the sandbox')
        ts.forEachChild(node, visit)
      }
      visit(sf)
    }
    return problems
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

/** The 1-based source line of a compiled-text offset, counting `\n` as findRegions does. @param {string} text @param {number} pos */
function lineOf(text, pos) {
  let n = 1
  for (let i = HEAD.length; i < pos; i++) if (text.charCodeAt(i) === 10) n++
  return n
}

/**
 * True when `pos` starts a token of the code itself — not one inside a comment, where JSDoc lives
 * (the AST walk does not descend into JSDoc, so a position there is reached by no code node).
 * @param {TS} ts @param {TsSourceFile} sf @param {number} pos
 */
function startsCode(ts, sf, pos) {
  /** @param {TsNode} node @returns {boolean} */
  const hit = node => {
    if (node.getStart(sf) === pos) return true
    return node.pos <= pos && pos < node.end && (ts.forEachChild(node, hit) ?? false)
  }
  return ts.forEachChild(sf, hit) ?? false
}
