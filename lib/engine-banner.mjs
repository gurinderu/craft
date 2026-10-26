// What the bundled build lifts out of an engine verbatim (realm @nick/craft, #210): the `export const meta = {…}`
// statement, which must be a pure literal — the Workflow tool reads it from the file's head without running
// the engine — and the CRAFT_VERSION stamp line, if the engine has one, which release-please edits in place in
// src/ and workflows/ alike. Both are blanked in what esbuild reads, character for character with the line
// breaks kept, so every position the source map records is a position in the source as written.

/** @typedef {import('./region-strip.mjs').TypeScript} TypeScript */
/** @typedef {import('../opencode/plugin/node_modules/typescript/lib/typescript.js').Node} TsNode */

const STAMP_LINE = /^const CRAFT_VERSION = '[^'\n]*'(?: \/\/[^\n]*)?$/

/** A literal leaf: a string, a number (negated or not), true, false or null. @param {TypeScript} ts @param {TsNode} n */
function isLeaf(ts, n) {
  const k = ts.SyntaxKind
  if (ts.isPrefixUnaryExpression(n)) return n.operator === k.MinusToken && ts.isNumericLiteral(n.operand)
  return ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n) || ts.isNumericLiteral(n) || [k.TrueKeyword, k.FalseKeyword, k.NullKeyword].includes(n.kind)
}

/**
 * The first node of a meta initializer that is not a literal, or null when it is all literal: leaves, and
 * arrays and objects of them with plain keys.
 * @param {TypeScript} ts @param {TsNode} n @returns {TsNode | null}
 */
export function nonLiteral(ts, n) {
  if (isLeaf(ts, n)) return null
  if (ts.isArrayLiteralExpression(n)) return n.elements.map(e => nonLiteral(ts, e)).find(Boolean) ?? null
  if (!ts.isObjectLiteralExpression(n)) return n
  for (const p of n.properties) {
    const bad = ts.isPropertyAssignment(p) && plainKey(ts, p.name) ? nonLiteral(ts, p.initializer) : p
    if (bad) return bad
  }
  return null
}

/** @param {TypeScript} ts @param {TsNode} name */
const plainKey = (ts, name) => ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)

/** @param {string} src @param {number} start @param {number} end @returns {string} `src` with [start, end) spaces, line breaks kept */
const blank = (src, start, end) => src.slice(0, start) + src.slice(start, end).replace(/[^\n]/g, ' ') + src.slice(end)

/**
 * @param {TypeScript} ts @param {string} src  a bundled-form engine @param {string} label  names it in a refusal
 * @returns {{ banner: string, blanked: string }}  the banner (meta, then the stamp line), and `src` with both blanked
 */
export function liftBanner(ts, src, label) {
  const sf = ts.createSourceFile(label, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
  const { meta, init } = metaStatement(ts, sf, label)
  const bad = nonLiteral(ts, init)
  if (bad) {
    const { line } = sf.getLineAndCharacterOfPosition(bad.getStart(sf))
    throw new Error(`${label}:${line + 1}: meta is not a pure literal (\`${bad.getText(sf).slice(0, 60)}\`) — the Workflow tool reads it without running the engine`)
  }
  const metaText = meta.getText(sf)
  let blanked = blank(src, meta.getStart(sf), meta.end)
  const stamp = stampLine(src, label)
  if (stamp) blanked = blank(blanked, stamp.start, stamp.start + stamp.text.length)
  return { banner: stamp ? `${metaText}\n${stamp.text}` : metaText, blanked }
}

/**
 * The `export const meta = {…}` statement, alone in its declaration, and its initializer; throws naming the engine.
 * @param {TypeScript} ts @param {import('../opencode/plugin/node_modules/typescript/lib/typescript.js').SourceFile} sf @param {string} label
 */
function metaStatement(ts, sf, label) {
  const meta = sf.statements.find(s => ts.isVariableStatement(s) && s.declarationList.declarations.some(d => ts.isIdentifier(d.name) && d.name.text === 'meta'))
  if (!meta || !ts.isVariableStatement(meta)) throw new Error(`${label}: no top-level \`export const meta = {…}\` to lift into the banner`)
  const decl = meta.declarationList.declarations
  const exported = meta.modifiers?.some(m => m.kind === ts.SyntaxKind.ExportKeyword)
  const init = decl.length === 1 ? decl[0]?.initializer : undefined
  if (!exported || !(meta.declarationList.flags & ts.NodeFlags.Const) || !init) throw new Error(`${label}: meta must be declared alone as \`export const meta = {…}\``)
  return { meta, init }
}

/**
 * The one line declaring CRAFT_VERSION, which must be the stamp alone; null when the engine has none.
 * @param {string} src @param {string} label @returns {{ start: number, text: string } | null}
 */
function stampLine(src, label) {
  const lines = src.split('\n')
  const at = lines.flatMap((l, i) => (/\bCRAFT_VERSION\s*=[^=]/.test(l) && /^\s*(?:const|let|var)\b/.test(l) ? [i] : []))
  if (!at.length) return null
  const i = /** @type {number} */ (at[0])
  const text = /** @type {string} */ (lines[i])
  if (at.length > 1 || !STAMP_LINE.test(text)) {
    throw new Error(`${label}:${i + 1}: the CRAFT_VERSION stamp must be one line \`const CRAFT_VERSION = '<version>' // x-release-please-version\` at the start of its line, declared once`)
  }
  return { start: lines.slice(0, i).reduce((n, l) => n + l.length + 1, 0), text }
}
