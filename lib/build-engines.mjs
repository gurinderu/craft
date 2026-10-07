// The engines are authored in src/ and shipped from workflows/: each workflows/<engine>.js is generated from
// src/<engine>.js and committed (realm @nick/craft, node #210). The rule is the one lib/region-strip.mjs applies
// to an inlined region, applied to the whole file: every whole-line `//` comment but a directive dropped
// (the `craft-inline` fence lines with them), JSDoc kept, blank lines that only separated the dropped
// comments collapsed — and refused, naming the engine, when tsc parses the result to another program than the
// source. JSDoc is kept, not stripped (realm @nick/craft, node #210).
//
// Run: `npm run build:engines` writes workflows/; `node lib/build-engines.mjs --check` (the gate's
// check:engines) writes nothing and fails, naming each file, when workflows/ is not a fresh build of src/.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { strippedProgram } from './region-strip.mjs'
import { loadTypescript, tscMissingMessage } from './run-tsc.mjs'
import { outputLines, runIfMain } from './script-main.mjs'

/** @typedef {import('./region-strip.mjs').TypeScript} TypeScript */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export const SRC = 'src'
export const OUT = 'workflows'

/**
 * One engine as it ships: its source without the whole-line `//` comments; throws when that changes the program.
 * @param {TypeScript} ts @param {string} source @param {string} label  names the engine in the error
 * @returns {string}
 */
export function buildEngine(ts, source, label) {
  return strippedProgram(ts, [source], label)
}

/** @param {string} dir @returns {string[]} */
const enginesIn = dir => (fs.existsSync(dir) ? fs.readdirSync(dir).filter(f => f.endsWith('.js')).sort() : [])

/**
 * Every engine built from `root`/src: what workflows/ must hold, and why an engine could not be built.
 * @param {string} root @param {TypeScript} ts
 * @returns {{ built: Map<string, string>, refusals: string[] }}
 */
export function buildAll(root, ts) {
  /** @type {Map<string, string>} */
  const built = new Map()
  /** @type {string[]} */
  const refusals = []
  for (const f of enginesIn(path.join(root, SRC))) {
    try { built.set(f, buildEngine(ts, fs.readFileSync(path.join(root, SRC, f), 'utf8'), `${SRC}/${f}`)) }
    catch (e) { refusals.push(/** @type {Error} */ (e).message) }
  }
  return { built, refusals }
}

/**
 * Each way workflows/ differs from a fresh build: a file stale or missing, a file with no source.
 * @param {string} root @param {Map<string, string>} built @returns {string[]}
 */
export function staleProblems(root, built) {
  /** @type {string[]} */
  const problems = []
  for (const [f, text] of built) {
    const out = path.join(root, OUT, f)
    if (!fs.existsSync(out)) problems.push(`${OUT}/${f} is missing — run npm run build:engines`)
    else if (fs.readFileSync(out, 'utf8') !== text) problems.push(`${OUT}/${f} differs from a fresh build of ${SRC}/${f} — edit ${SRC}/${f}, never ${OUT}/, and run npm run build:engines`)
  }
  for (const f of enginesIn(path.join(root, OUT))) {
    if (!built.has(f)) problems.push(`${OUT}/${f} has no source ${SRC}/${f} — an engine is authored in ${SRC}/`)
  }
  return problems
}

/** @typedef {{ stdout: string[], stderr: string[] }} Lines */

/** @param {string} root @param {Map<string, string>} built @param {Lines} o @returns {number} the exit code */
function checkFresh(root, built, o) {
  const problems = staleProblems(root, built)
  for (const p of problems) o.stderr.push(`FAIL  ${p}`)
  if (!problems.length) o.stdout.push(`ok    ${OUT}/ is a fresh build of ${SRC}/ (${built.size} engines)`)
  return problems.length ? 1 : 0
}

/** workflows/ made to hold exactly `built`. @param {string} root @param {Map<string, string>} built @param {Lines} o */
function writeBuilt(root, built, o) {
  fs.mkdirSync(path.join(root, OUT), { recursive: true })
  for (const f of enginesIn(path.join(root, OUT))) if (!built.has(f)) fs.rmSync(path.join(root, OUT, f))
  for (const [f, text] of built) {
    fs.writeFileSync(path.join(root, OUT, f), text)
    o.stdout.push(`wrote ${OUT}/${f} (${Buffer.byteLength(text)} bytes from ${fs.statSync(path.join(root, SRC, f)).size})`)
  }
}

/**
 * Writes workflows/ from src/, or with `--check` only compares; fails closed without tsc.
 * @param {string[]} argv @param {NodeJS.ProcessEnv} _env  unused: it reads no environment
 * @param {string} [root]  the checkout to build
 * @returns {Promise<import('./script-main.mjs').ScriptResult>}
 */
export async function run(argv, _env, root = ROOT) {
  const o = outputLines()
  const ts = loadTypescript(root) ?? loadTypescript(ROOT)
  if (!ts) { o.stderr.push(`FAIL  ${tscMissingMessage(root)}`); return { exitCode: 1, ...o } }
  const { built, refusals } = buildAll(root, ts)
  for (const r of refusals) o.stderr.push(`FAIL  ${r}`)
  if (!built.size && !refusals.length) o.stderr.push(`FAIL  ${SRC}/ :: no .js engines found — nothing was built`)
  if (refusals.length || !built.size) return { exitCode: 1, ...o }
  if (argv.includes('--check')) return { exitCode: checkFresh(root, built, o), ...o }
  writeBuilt(root, built, o)
  return { exitCode: 0, ...o }
}

await runIfMain(import.meta.url, run)
