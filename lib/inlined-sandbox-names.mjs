// Inlined code is type-checked in its lib module, against Node typings, where TextEncoder, process,
// performance and the rest all exist — the Workflow sandbox has none of them (realm @nick/craft, #135).
// So each engine is compiled once more AS IT SHIPS, regions in place, against the ES library and the
// sandbox declarations only, and every name inside a region that resolves to neither is refused: an
// allowlist by construction, with no list of absent globals to keep current. Three routes around name
// resolution are closed explicitly: `require(…)`, which TypeScript reads as an import in JS;
// `globalThis`, whose casts and reflection reach any property (inlined code has no use for it);
// `import(…)`, `import.meta`, `eval` and `Function`, which reach the host with no unresolved name; and a
// program that is not closed — a file beyond the ES library and the sandbox declaration would bring
// its own globals in, so one is a failure, not a quiet widening. This guards craft's own lib code
// against an accidental reach for the host; deliberate reflection (`[].constructor.constructor`,
// sloppy-mode `this`) is not chased. A `@ts-ignore` that could hide a diagnostic here never reaches a
// region: check-workflows refuses any `@ts-` directive in an inlined module (typedScopeProblems).
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { findRegions } from './inline-regions.mjs'
import { compileAgainstSandbox, openProgramProblems, refusedIn } from './sandbox-program.mjs'

/** @typedef {typeof import('../opencode/plugin/node_modules/typescript/lib/typescript.js')} TS */
/** @typedef {import('../opencode/plugin/node_modules/typescript/lib/typescript.js').Program} TsProgram */
/** @typedef {{ file: string, regions: { start: number, end: number, source: string }[] }} EngineCopy */

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
    const map = writeEngineCopies(root, dir)
    const compiled = compileAgainstSandbox(root, ts, [...map.keys()], 'the inlined-name check')
    if (Array.isArray(compiled)) return compiled
    const { program, sandbox } = compiled
    /** @type {string[]} */
    const problems = []
    problems.push(...openProgramProblems(program, new Set(map.keys()), sandbox, 'the inlined-name check'))
    for (const [file, at] of map) problems.push(...engineProblems(ts, program, file, at))
    return problems
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

/**
 * Each engine holding a region, written into `dir` as it ships (regions in place), keyed by its path there.
 * @param {string} root @param {string} dir @returns {Map<string, EngineCopy>}
 */
function writeEngineCopies(root, dir) {
  /** @type {Map<string, EngineCopy>} */
  const map = new Map()
  for (const f of fs.readdirSync(path.join(root, 'src')).filter(n => n.endsWith('.js')).sort()) {
    const src = fs.readFileSync(path.join(root, 'src', f), 'utf8')
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
    map.set(out, { file: `src/${f}`, regions })
  }
  return map
}

/**
 * The refused names and host routes inside one engine's regions.
 * @param {TS} ts @param {TsProgram} program @param {string} file @param {EngineCopy} at @returns {string[]}
 */
function engineProblems(ts, program, file, at) {
  const sf = program.getSourceFile(file)
  if (!sf) return [`${at.file}: not compiled — the inlined-name check saw nothing of it`]
  /** @type {string[]} */
  const problems = []
  /** @param {number} pos @param {string} what */
  const refuse = (pos, what) => {
    const region = at.regions.find(r => pos >= r.start && pos < r.end)
    if (region) problems.push(`${at.file}:${lineOf(sf.text, pos)} :: inlined code from ${region.source} ${what}`)
  }
  refusedIn(ts, program, sf, refuse)
  return problems
}

/** The 1-based source line of a compiled-text offset, counting `\n` as findRegions does. @param {string} text @param {number} pos */
function lineOf(text, pos) {
  let n = 1
  for (let i = HEAD.length; i < pos; i++) if (text.charCodeAt(i) === 10) n++
  return n
}
