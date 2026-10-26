// A position in a built engine, read back to where it was written (realm @nick/craft, #210, #348). The Workflow
// tool reports a failure as `at workflow.js:<line>:<column>` — the line and column of the bundled file, not of
// its source, and not naming the engine — so this is told the engine apart: `node lib/engine-source-map.mjs
// <engine> <line>:<column>` reads workflows/<engine>.js.map and prints the src/ or lib/ file, line and column
// with the source line. Node's standard library only: it runs from the installed plugin, where nothing else is.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { outputLines, runIfMain } from './script-main.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

/** @typedef {{ sources: string[], mappings: string, sourceRoot?: string }} SourceMap */
/** @typedef {[number, number, number, number]} Segment  generated column, source index, source line, source column — 0-based */

/**
 * The Base64 VLQ numbers of one segment.
 * @param {string} seg @returns {number[]}
 */
export function decodeVlq(seg) {
  /** @type {number[]} */
  const out = []
  let value = 0
  let shift = 0
  for (const ch of seg) {
    const digit = B64.indexOf(ch)
    if (digit < 0) throw new Error(`not a Base64 VLQ digit: '${ch}'`)
    value += (digit & 31) << shift
    if (digit & 32) { shift += 5; continue }
    out.push(value & 1 ? -(value >>> 1) : value >>> 1)
    value = 0
    shift = 0
  }
  if (shift) throw new Error(`a VLQ number runs past the end of segment '${seg}'`)
  return out
}

/**
 * Every mapped segment, per generated line, in absolute positions; segments without a source are left out.
 * @param {string} mappings @returns {Segment[][]}
 */
export function decodeMappings(mappings) {
  let src = 0
  let line = 0
  let col = 0
  return mappings.split(';').map(text => {
    let gen = 0
    /** @type {Segment[]} */
    const segs = []
    for (const seg of text.split(',')) {
      if (!seg) continue
      const [g = 0, s, l, c] = decodeVlq(seg)
      gen += g
      if (s === undefined || l === undefined || c === undefined) continue
      src += s
      line += l
      col += c
      segs.push([gen, src, line, col])
    }
    return segs
  })
}

/**
 * Where a 1-based line and column of the generated file was written: the last segment at or before it on its line.
 * @param {SourceMap} map @param {number} line @param {number} column
 * @returns {{ source: string, line: number, column: number } | null}  1-based; null where nothing is mapped
 */
export function originalPosition(map, line, column) {
  const segs = decodeMappings(map.mappings)[line - 1] ?? []
  const at = segs.filter(s => s[0] <= column - 1).pop()
  const source = at && map.sources[at[1]]
  return at && source !== undefined ? { source, line: at[2] + 1, column: at[3] + 1 } : null
}

/**
 * A position of workflows/<engine>.js as a repo-relative place in src/ or lib/, with that line's text when readable.
 * @param {string} root @param {string} engine  `rust-review`, `craft:rust-review` or `rust-review.js`
 * @param {number} line @param {number} column
 * @returns {{ file: string, line: number, column: number, text: string | null }}  throws when there is no map or no mapping
 */
export function locate(root, engine, line, column) {
  const name = engine.replace(/^craft:/, '').replace(/\.js$/, '')
  const mapFile = path.join(root, 'workflows', `${name}.js.map`)
  if (!fs.existsSync(mapFile)) throw new Error(`workflows/${name}.js.map is absent — workflows/${name}.js is not bundled (or no such engine): read the position in that file itself`)
  /** @type {SourceMap} */
  const map = JSON.parse(fs.readFileSync(mapFile, 'utf8'))
  const at = originalPosition(map, line, column)
  if (!at) throw new Error(`workflows/${name}.js:${line}:${column} maps to no source — the banner (meta, the version stamp) and the closing call of __run are not mapped`)
  const abs = path.resolve(path.dirname(mapFile), map.sourceRoot ?? '', at.source)
  const file = path.relative(root, abs).split(path.sep).join('/')
  const text = fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8').split('\n')[at.line - 1] ?? null : null
  return { file, line: at.line, column: at.column, text }
}

/**
 * The command: `<engine> <line>:<column>`.
 * @param {string[]} argv @param {NodeJS.ProcessEnv} _env  unused: it reads no environment
 * @param {string} [root]  the plugin checkout whose workflows/ is read
 * @returns {Promise<import('./script-main.mjs').ScriptResult>}
 */
export async function run(argv, _env, root = ROOT) {
  const o = outputLines()
  const [engine, where] = argv
  const m = /^(?:.*:)?(\d+):(\d+)$/.exec(where ?? '')
  if (!engine || !m) {
    o.stderr.push('usage: node lib/engine-source-map.mjs <engine> <line>:<column>   (the position the Workflow tool reports as workflow.js:<line>:<column>)')
    return { exitCode: 2, ...o }
  }
  try {
    const at = locate(root, engine, Number(m[1]), Number(m[2]))
    o.stdout.push(`${at.file}:${at.line}:${at.column}`)
    if (at.text !== null) o.stdout.push(`  ${at.text.trim()}`)
    return { exitCode: 0, ...o }
  } catch (e) {
    o.stderr.push(/** @type {Error} */ (e).message)
    return { exitCode: 1, ...o }
  }
}

await runIfMain(import.meta.url, run)
