// Source rules for the engines (workflows/*.js) that the type check cannot express (realm @nick/craft, #136).
// - The sandbox throws on Date.now(), Math.random(), Date() and an argless `new Date` (they would break resume),
//   yet es2023 declares all three, so tsc accepts them: they are refused here, in code and in inlined
//   lib regions alike — an inlined module runs in the sandbox too.
// - An `any` in a JSDoc type (or `*`, `?`, `Function`, which tsc reads the same) switches the check off for its value as @ts-ignore would. Each engine's
//   count is held to a committed ceiling that can only fall: above it is a new hole, below it is a
//   stale ceiling that must be lowered in the same change.
// - Inlined code runs in the engine, so its `any` is the engine's hole too. The engine count skips
//   craft-inline regions (they are lib text); instead every lib module a fence names is counted whole,
//   in its own source, and held to zero — a type that leaks out of a non-inlined export of that module
//   reaches the engine through the inlined ones as easily.
import { findRegions } from './inline-regions.mjs'

/** @typedef {typeof import('../opencode/plugin/node_modules/typescript/lib/typescript.js')} TS */
/** @typedef {import('../opencode/plugin/node_modules/typescript/lib/typescript.js').Node} TsNode */

// Both rules read a parse, not the text: comments, strings, templates and regex literals can neither
// hide a call nor fake one (a hand-written stripper was blinded by a backtick in a regex, realm #135).
/** @param {string} src @param {TS} ts */
function parse(src, ts) {
  return ts.createSourceFile('engine.js', src, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
}

/**
 * Every read of the clock or of randomness the sandbox throws on: `Date.now` and `Math.random` as a
 * member, called or not (a reference called later is the same read), `Date()` without `new` (a string
 * of now), and `new Date` with no argument.
 * @param {string} src @param {string} file @param {TS} ts @returns {string[]}
 */
export function forbiddenCalls(src, file, ts) {
  const sf = parse(src, ts)
  /** @type {string[]} */
  const out = []
  /** @param {TsNode} node @param {string} what */
  const refuse = (node, what) => out.push(`${file}:${sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1} reads ${what}, which the Workflow sandbox throws on`)
  /** @param {TsNode} e @param {string} name */
  const is = (e, name) => ts.isIdentifier(e) && e.text === name
  /** @param {TsNode} node @returns {string | null} `Date.now`/`Math.random` when the node is that member */
  const member = node => {
    /** @type {[TsNode, string] | null} */
    const pair = ts.isPropertyAccessExpression(node) ? [node.expression, node.name.text]
      : ts.isElementAccessExpression(node) && ts.isStringLiteralLike(node.argumentExpression) ? [node.expression, node.argumentExpression.text]
        : null
    if (!pair) return null
    if (is(pair[0], 'Date') && pair[1] === 'now') return 'Date.now'
    if (is(pair[0], 'Math') && pair[1] === 'random') return 'Math.random'
    return null
  }
  /** @param {TsNode} node */
  const visit = node => {
    const m = member(node)
    if (m) refuse(node, m)
    else if (ts.isCallExpression(node) && is(node.expression, 'Date')) refuse(node, 'Date() called without new')
    else if (ts.isNewExpression(node) && is(node.expression, 'Date') && !node.arguments?.length) refuse(node, 'an argless new Date')
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return out
}

/**
 * Types in JSDoc that switch the check off as `any` does — `any`, `*`, `?` and `Function` — outside
 * craft-inline regions (those are lib code, counted in their source by inlinedAnyProblems).
 * @param {string} src @param {TS} ts @returns {number}
 */
export function countAny(src, ts) {
  const sf = parse(src, ts)
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
      (ts.isTypeReferenceNode(node) && ts.isIdentifier(node.typeName) && node.typeName.text === 'Function')) found.add(node)
    ts.forEachChild(node, inType)
  }
  /** @param {TsNode} node */
  const visit = node => {
    for (const doc of ts.getJSDocCommentsAndTags(node)) {
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
 * @returns {string[]}
 */
export function anyCeilingProblems(counts, ceiling, engines = Object.keys(counts)) {
  /** @type {string[]} */
  const out = []
  for (const [file, n] of Object.entries(counts)) {
    const cap = ceiling[file]
    if (typeof cap !== 'number' || !Number.isInteger(cap) || cap < 0) { out.push(`${file}: no ceiling for its ${n} \`any\` type(s) in lib/engine-any-ceiling.json`); continue }
    if (n > cap) out.push(`${file}: ${n} \`any\` types, above the ceiling ${cap} — type the new value instead`)
    else if (n < cap) out.push(`${file}: ${n} \`any\` types, below the ceiling ${cap} — lower the ceiling to ${n} in lib/engine-any-ceiling.json`)
  }
  for (const file of Object.keys(ceiling)) if (!engines.includes(file)) out.push(`lib/engine-any-ceiling.json names ${file}, which is not an engine`)
  return out
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
