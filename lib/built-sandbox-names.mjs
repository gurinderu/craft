// Every engine as it ships (workflows/*.js), whole, compiled against what the Workflow sandbox provides — the ES
// library and lib/workflow-sandbox.d.ts, nothing else (realm @nick/craft, #134, #135) — and refused for any
// name that resolves to neither, and for the routes to the host that resolve cleanly (require, a dynamic
// import, import.meta, eval, Function, a bare globalThis). It reads the shipped text, so it holds a bundled
// engine and everything esbuild pulled into it from lib/ as one program. A position in a bundled engine is also
// given in its source, through the map beside it (lib/engine-source-map.mjs).
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { locate } from './engine-source-map.mjs'
import { compileAgainstSandbox, openProgramProblems, refusedIn } from './sandbox-program.mjs'

/** @typedef {typeof import('../opencode/plugin/node_modules/typescript/lib/typescript.js')} TS */

const HEAD = 'async function __wf() {\n'

/**
 * @param {string} root @param {TS} ts
 * @returns {{ problems: string[], files: number }}  one problem per refused name: `workflows/<f>:<line>:<col> :: …`
 */
export function builtNameProblems(root, ts) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'craft-wfb-'))
  try {
    const wf = path.join(root, 'workflows')
    const files = fs.existsSync(wf) ? fs.readdirSync(wf).filter(f => f.endsWith('.js')).sort() : []
    if (!files.length) return { problems: ['workflows/ :: no .js engines found — the built-name check read nothing, so it cannot pass'], files: 0 }
    /** @type {Map<string, string>} */
    const copies = new Map()
    for (const f of files) {
      // `export {}` keeps each copy its own module; `export const meta` loses only its keyword.
      const src = fs.readFileSync(path.join(wf, f), 'utf8').replace(/^export const meta/m, '       const meta')
      const out = path.resolve(dir, f.replace(/\.js$/, '.mjs'))
      fs.writeFileSync(out, `${HEAD}${src}\n}\nvoid __wf\nexport {}\n`)
      copies.set(out, f)
    }
    const compiled = compileAgainstSandbox(root, ts, [...copies.keys()], 'the built-name check')
    if (Array.isArray(compiled)) return { problems: compiled, files: files.length }
    const { program, sandbox } = compiled
    const problems = openProgramProblems(program, new Set(copies.keys()), sandbox, 'the built-name check')
    for (const [copy, f] of copies) problems.push(...fileProblems(ts, program, copy, f, root))
    return { problems, files: files.length }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

/**
 * The refused names and host routes in one built engine.
 * @param {TS} ts @param {import('../opencode/plugin/node_modules/typescript/lib/typescript.js').Program} program
 * @param {string} copy @param {string} f @param {string} root @returns {string[]}
 */
function fileProblems(ts, program, copy, f, root) {
  const sf = program.getSourceFile(copy)
  if (!sf) return [`workflows/${f}: not compiled — the built-name check saw nothing of it`]
  /** @type {string[]} */
  const problems = []
  /** @param {number} pos @param {string} what */
  const refuse = (pos, what) => {
    const { line, character } = sf.getLineAndCharacterOfPosition(pos)
    problems.push(`${where(root, f, line, character + 1)} :: ${what}`)
  }
  refusedIn(ts, program, sf, refuse)
  return problems
}

/**
 * `workflows/<f>:<line>:<col>`, line 1-based in the shipped file (the wrapper's head line is line 0), and its
 * source place when a map leads there.
 * @param {string} root @param {string} f @param {number} line @param {number} col
 */
function where(root, f, line, col) {
  const at = `workflows/${f}:${line}:${col}`
  try {
    const src = locate(root, f, line, col)
    return `${at} (${src.file}:${src.line}:${src.column})`
  } catch { return at }
}
