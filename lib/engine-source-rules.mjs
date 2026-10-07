// Source rules for the engines as authored (src/*.js) that the type check cannot express (realm @nick/craft, #136).
// - The sandbox throws on Date.now(), Math.random(), Date() and an argless `new Date` (they would break resume),
//   yet es2023 declares all three, so tsc accepts them: they are refused (lib/engine-clock-rule.mjs), in
//   code and in inlined lib regions alike — an inlined module runs in the sandbox too.
// - An `any` switches the check off for its value as @ts-ignore would. Each engine's count — `any`
//   spelled in its JSDoc (or `*`, `?`, `Function`/`function`, which tsc reads alike) plus every value the
//   checker types `any` without one being spelled (lib/engine-any-sites.mjs) — is held to a committed
//   ceiling that can only fall: above it is a new hole, below it is a stale ceiling that must be
//   lowered in the same change.
// - Inlined code runs in the engine, so its `any` is the engine's hole too. The engine count skips
//   craft-inline regions (they are lib text); instead every lib module a fence names is counted whole,
//   in its own source, and held to zero — a type that leaks out of a non-inlined export of that module
//   reaches the engine through the inlined ones as easily.
import { findRegions } from './inline-regions.mjs'
import { parsed } from './engine-clock-rule.mjs'

export { forbiddenCalls, parseEngine } from './engine-clock-rule.mjs'

/** @typedef {typeof import('../opencode/plugin/node_modules/typescript/lib/typescript.js')} TS */
/** @typedef {import('../opencode/plugin/node_modules/typescript/lib/typescript.js').Node} TsNode */
/** @typedef {import('./engine-clock-rule.mjs').Parsed} Parsed */

// Type names tsc reads in a JS file's JSDoc as an untyped value: `Function`/`function` (callable,
// returning any), and the lowercase `array`/`promise` without type arguments (any[] / Promise<any>).
const LOOSE = new Set(['Function', 'function', 'array', 'promise'])

/**
 * Types in JSDoc that switch the check off as `any` does — `any`, `*`, `?`, `Function`/`function`, bare `array`/`promise` — outside
 * craft-inline regions (those are lib code, counted in their source by inlinedAnyProblems).
 * @param {string | Parsed} source @param {TS} ts @returns {number}
 */
export function countAny(source, ts) {
  const { src, sf } = parsed(source, ts)
  const lines = src.split('\n')
  /** @type {[number, number][]} */
  const skip = []
  let off = 0
  /** @type {number[]} */
  const at = []
  for (const l of lines) { at.push(off); off += l.length + 1 }
  for (const r of findRegions(src)) skip.push([/** @type {number} */ (at[r.open]), at[r.close + 1] ?? off])
  // A @param tag is reached both on its own and inside its comment, so the type nodes are what is counted.
  /** @type {Set<TsNode>} */
  const found = new Set()
  /** @param {TsNode} node */
  const inType = node => {
    if (node.kind === ts.SyntaxKind.AnyKeyword || node.kind === ts.SyntaxKind.JSDocAllType || node.kind === ts.SyntaxKind.JSDocUnknownType ||
      (ts.isTypeReferenceNode(node) && ts.isIdentifier(node.typeName) && LOOSE.has(node.typeName.text) && !node.typeArguments?.length)) found.add(node)
    ts.forEachChild(node, inType)
  }
  /** @param {TsNode} node */
  const visit = node => {
    // Every JSDoc block on the node, read directly: ts.getJSDocCommentsAndTags returns only @overload
    // tags for all but the last block of a stacked run, so `any` in an earlier typedef went uncounted.
    // `jsDoc` is the parser's own field (internal in the typings; pinned by a test on a stacked run).
    for (const doc of /** @type {{ jsDoc?: TsNode[] }} */ (/** @type {unknown} */ (node)).jsDoc ?? []) {
      const pos = doc.getStart(sf)
      if (!skip.some(([a, b]) => pos >= a && pos < b)) inType(doc)
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return found.size
}

/**
 * @param {Record<string, number>} counts  per engine file, as measured
 * @param {Record<string, unknown>} ceiling  per engine file, as committed
 * @param {string[]} engines  every engine file, counted or not (one with a broken fence is reported elsewhere)
 * @param {Record<string, string[]>} sites  per engine file, where the checker saw `any` — listed when above the ceiling
 * @returns {string[]}
 */
export function anyCeilingProblems(counts, ceiling, engines = Object.keys(counts), sites = {}) {
  /** @type {string[]} */
  const out = []
  for (const [file, n] of Object.entries(counts)) {
    const problem = ceilingProblem(file, n, ceiling[file], sites[file])
    if (problem) out.push(problem)
  }
  for (const file of Object.keys(ceiling)) if (!engines.includes(file)) out.push(`lib/engine-any-ceiling.json names ${file}, which is not an engine`)
  return out
}

/**
 * One engine's count against its committed ceiling; null when they match.
 * @param {string} file @param {number} n @param {unknown} cap @param {string[] | undefined} sites
 * @returns {string | null}
 */
function ceilingProblem(file, n, cap, sites) {
  if (typeof cap !== 'number' || !Number.isInteger(cap) || cap < 0) return `${file}: no ceiling for its ${n} \`any\` type(s) in lib/engine-any-ceiling.json`
  const at = (sites ?? []).slice(0, 20).map(l => `\n  ${l}`).join('')
  if (n > cap) return `${file}: ${n} \`any\` types, above the ceiling ${cap} — type the new value instead${at}`
  if (n < cap) return `${file}: ${n} \`any\` types, below the ceiling ${cap} — lower the ceiling to ${n} in lib/engine-any-ceiling.json`
  return null
}

/**
 * Every lib module a craft-inline fence names, held to zero `any` in its whole source.
 * @param {Map<string, { text: string | null, engines: string[] }>} modules  by repo-relative source path; `text` null when unreadable
 * @param {TS} ts
 * @returns {string[]}
 */
export function inlinedAnyProblems(modules, ts) {
  /** @type {string[]} */
  const out = []
  for (const [source, { text, engines }] of [...modules].sort(([a], [b]) => a.localeCompare(b))) {
    const into = `inlined into ${engines.join(', ')}`
    if (text == null) { out.push(`${source}: unreadable, so its \`any\` types are uncounted (${into})`); continue }
    const n = countAny(text, ts)
    if (n) out.push(`${source}: ${n} \`any\` type(s) in a module ${into} — inlined code is held to zero; type the value instead`)
  }
  return out
}
