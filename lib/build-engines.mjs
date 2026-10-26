// The engines are authored in src/ and shipped from workflows/: each workflows/<engine>.js is generated from
// src/<engine>.js and committed (realm @nick/craft, node #210). Every engine is in the bundled form
// (lib/engine-form.mjs): it imports its code from lib/ and is bundled by esbuild with meta and the stamp lifted
// into the banner (lib/engine-bundle.mjs), a source map `workflows/<engine>.js.map` beside it while SOURCE_MAPS
// holds. An engine in src/ not in that form is refused, naming it.
//
// Run: `npm run build:engines` writes workflows/; `node lib/build-engines.mjs --check` (the gate's
// check:engines) writes nothing and fails, naming each file, when workflows/ is not a fresh build of src/.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import * as esbuild from 'esbuild'
import { bundleEngine } from './engine-bundle.mjs'
import { isBundledForm } from './engine-form.mjs'
import { loadTypescript, tscMissingMessage } from './run-tsc.mjs'
import { outputLines, runIfMain } from './script-main.mjs'

/** @typedef {import('./run-tsc.mjs').TypeScript} TypeScript */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export const SRC = 'src'
export const OUT = 'workflows'
// The one switch for the source maps beside the bundled engines: off, the build writes none and links none, and
// the freshness check reports a map left in workflows/ as one with no source (realm @nick/craft, #348).
export const SOURCE_MAPS = true

/** @param {string} dir @returns {string[]} */
const enginesIn = dir => (fs.existsSync(dir) ? fs.readdirSync(dir).filter(f => f.endsWith('.js')).sort() : [])

/** What the build owns in workflows/: the engines and their maps. @param {string} dir @returns {string[]} */
const shippedIn = dir => (fs.existsSync(dir) ? fs.readdirSync(dir).filter(f => f.endsWith('.js') || f.endsWith('.js.map')).sort() : [])

/**
 * Every engine built from `root`/src, keyed by the file it ships as in workflows/ (a bundled engine's map
 * among them), and why an engine could not be built.
 * @param {string} root @param {TypeScript} ts @param {boolean} [maps]
 * @returns {Promise<{ built: Map<string, string>, refusals: string[] }>}
 */
export async function buildAll(root, ts, maps = SOURCE_MAPS) {
  /** @type {Map<string, string>} */
  const built = new Map()
  /** @type {string[]} */
  const refusals = []
  for (const f of enginesIn(path.join(root, SRC))) {
    const source = fs.readFileSync(path.join(root, SRC, f), 'utf8')
    try {
      if (!isBundledForm(source)) { refusals.push(`${SRC}/${f}: not in the bundled form — import from lib/, then \`export const meta = {…}\`, then the body in \`export async function __run() {\`; nothing else is built`); continue }
      const { js, map } = await bundleEngine({ esbuild, ts, root, file: `${SRC}/${f}`, source, maps })
      built.set(f, js)
      if (map !== null) built.set(`${f}.map`, map)
    } catch (e) { refusals.push(/** @type {Error} */ (e).message) }
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
  for (const f of shippedIn(path.join(root, OUT))) {
    if (!built.has(f)) problems.push(`${OUT}/${f} has no source ${SRC}/${sourceOf(f)} — an engine is authored in ${SRC}/, its map is built beside it`)
  }
  return problems
}

/** @param {string} f  a file in workflows/ @returns {string} the engine it is built from */
const sourceOf = f => f.replace(/\.map$/, '')

/** @typedef {{ stdout: string[], stderr: string[] }} Lines */

/** @param {string} root @param {Map<string, string>} built @param {Lines} o @returns {number} the exit code */
function checkFresh(root, built, o) {
  const problems = staleProblems(root, built)
  for (const p of problems) o.stderr.push(`FAIL  ${p}`)
  if (!problems.length) o.stdout.push(`ok    ${OUT}/ is a fresh build of ${SRC}/ (${[...built.keys()].filter(f => f.endsWith('.js')).length} engines)`)
  return problems.length ? 1 : 0
}

/** workflows/ made to hold exactly `built`. @param {string} root @param {Map<string, string>} built @param {Lines} o */
function writeBuilt(root, built, o) {
  fs.mkdirSync(path.join(root, OUT), { recursive: true })
  for (const f of shippedIn(path.join(root, OUT))) if (!built.has(f)) fs.rmSync(path.join(root, OUT, f))
  for (const [f, text] of built) {
    fs.writeFileSync(path.join(root, OUT, f), text)
    o.stdout.push(`wrote ${OUT}/${f} (${Buffer.byteLength(text)} bytes from ${fs.statSync(path.join(root, SRC, sourceOf(f))).size})`)
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
  const { built, refusals } = await buildAll(root, ts)
  for (const r of refusals) o.stderr.push(`FAIL  ${r}`)
  if (!built.size && !refusals.length) o.stderr.push(`FAIL  ${SRC}/ :: no .js engines found — nothing was built`)
  if (refusals.length || !built.size) return { exitCode: 1, ...o }
  if (argv.includes('--check')) return { exitCode: checkFresh(root, built, o), ...o }
  writeBuilt(root, built, o)
  return { exitCode: 0, ...o }
}

await runIfMain(import.meta.url, run)
