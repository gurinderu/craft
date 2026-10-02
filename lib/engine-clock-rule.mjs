// The engines' clock rule, and the one parse both source rules share (realm @nick/craft, #136): the
// sandbox throws on Date.now(), Math.random(), Date() and an argless `new Date` (they would break
// resume), yet es2023 declares all of them, so tsc accepts them — they are refused here.
/** @typedef {typeof import('../opencode/plugin/node_modules/typescript/lib/typescript.js')} TS */
/** @typedef {import('../opencode/plugin/node_modules/typescript/lib/typescript.js').Node} TsNode */

// Both rules read a parse, not the text: comments, strings, templates and regex literals can neither
// hide a call nor fake one (a hand-written stripper was blinded by a backtick in a regex, realm #135).
/** @typedef {{ src: string, sf: import('../opencode/plugin/node_modules/typescript/lib/typescript.js').SourceFile }} Parsed */

/**
 * One parse of an engine, shared by both rules so the gate reads each file once.
 * @param {string} src @param {TS} ts @returns {Parsed}
 */
export function parseEngine(src, ts) {
  return { src, sf: ts.createSourceFile('engine.js', src, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS) }
}

/** @param {string | Parsed} src @param {TS} ts @returns {Parsed} */
export const parsed = (src, ts) => typeof src === 'string' ? parseEngine(src, ts) : src

const FORBIDDEN = /** @type {Record<string, string>} */ ({ Date: 'now', Math: 'random' })
/** @param {string} n */
const guarded = n => n === 'Date' || n === 'Math'

/**
 * Every read of the clock or of randomness the sandbox throws on: `Date.now` and `Math.random` as a
 * member, called or not (a reference called later is the same read), `Date()` without `new` (a string
 * of now), and `new Date` with no argument or only spread ones. `Date` and `Math` (bare or as
 * `globalThis.Date`/`.Math`, parenthesized or not) may otherwise appear only as a direct member
 * access `Date.x`, as `new Date(arg)`, or right of `instanceof`: any other use is a value that can
 * reach the clock out of sight (`const { now } = Date`, `const D = Date; D.now()`), so it is refused.
 * `globalThis` itself may appear only as `globalThis.x` with a literal name, for the same reason
 * (`const { Date: D } = globalThis`, `globalThis[k]`); `globalThis.globalThis` is globalThis again.
 * @param {string | Parsed} src @param {string} file @param {TS} ts @returns {string[]}
 */
export function forbiddenCalls(src, file, ts) {
  const { sf } = parsed(src, ts)
  /** @type {string[]} */
  const out = []
  /** @param {TsNode} node @param {string} what */
  const refuse = (node, what) => out.push(`${file}:${sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1} reads ${what}, which the Workflow sandbox throws on`)
  /** @param {TsNode} e @returns {TsNode} */
  const strip = e => ts.isParenthesizedExpression(e) ? strip(e.expression) : e
  /** @param {TsNode} e @returns {string | null} the literal name of a member access, null when computed */
  const nameOf = e => ts.isPropertyAccessExpression(e) ? e.name.text
    : ts.isElementAccessExpression(e) && ts.isStringLiteralLike(e.argumentExpression) ? e.argumentExpression.text : null
  /** @param {TsNode} e @returns {boolean} `e` reads globalThis itself — bare, or as its own member `globalThis.globalThis` */
  const isGlobalThis = e => {
    const s = strip(e)
    if (ts.isIdentifier(s)) return s.text === 'globalThis' && isValueRef(s)
    return (ts.isPropertyAccessExpression(s) || ts.isElementAccessExpression(s)) && nameOf(s) === 'globalThis' && isGlobalThis(s.expression)
  }
  /** @param {TsNode} e @returns {string | null} 'Date'/'Math' when `e` reads that global, bare or through globalThis */
  const global = e => {
    const s = strip(e)
    if (ts.isIdentifier(s)) return guarded(s.text) && isValueRef(s) ? s.text : null
    if ((ts.isPropertyAccessExpression(s) || ts.isElementAccessExpression(s)) && isGlobalThis(s.expression)) {
      const n = nameOf(s)
      return n != null && guarded(n) ? n : null
    }
    return null
  }
  /** @param {TsNode} n  an identifier: is it a value read, not a property, binding or declaration name? */
  const isValueRef = n => {
    const p = n.parent
    if (!p) return false
    if ((ts.isPropertyAccessExpression(p) || ts.isPropertyAssignment(p) || ts.isMethodDeclaration(p) || ts.isPropertyDeclaration(p) ||
      ts.isGetAccessorDeclaration(p) || ts.isSetAccessorDeclaration(p) || ts.isVariableDeclaration(p) || ts.isParameter(p) ||
      ts.isFunctionDeclaration(p) || ts.isClassDeclaration(p) || ts.isBindingElement(p)) && p.name === n) return false
    if (ts.isBindingElement(p) && p.propertyName === n) return false
    return !(ts.isLabeledStatement(p) || ts.isBreakOrContinueStatement(p) || ts.isImportSpecifier(p) || ts.isExportSpecifier(p) || ts.isImportClause(p))
  }
  /** @param {TsNode} node  a read of Date/Math: judge it by where it is used */
  const judge = (node, /** @type {string} */ g) => {
    /** @type {TsNode} */
    let at = node
    while (at.parent && ts.isParenthesizedExpression(at.parent)) at = at.parent
    const p = at.parent
    if (p && (ts.isPropertyAccessExpression(p) || ts.isElementAccessExpression(p)) && p.expression === at) {
      const n = nameOf(p)
      if (n == null) refuse(p, `a computed member of ${g}, which may be ${g}.${FORBIDDEN[g]}`)
      else if (n === FORBIDDEN[g]) refuse(p, `${g}.${n}`)
      return
    }
    if (p && g === 'Date' && ts.isNewExpression(p) && p.expression === at) {
      if (!(p.arguments ?? []).some(a => !ts.isSpreadElement(a))) refuse(p, 'an argless new Date')
      return
    }
    if (p && g === 'Date' && ts.isCallExpression(p) && p.expression === at) { refuse(p, 'Date() called without new'); return }
    if (p && ts.isBinaryExpression(p) && p.operatorToken.kind === ts.SyntaxKind.InstanceOfKeyword && p.right === at) return
    refuse(node, `${g} as a value (an alias reaches ${g}.${FORBIDDEN[g]} out of sight; use ${g}.x directly)`)
  }
  /** @param {TsNode} node  a read of globalThis: only `globalThis.x` with a literal name is not a value */
  const judgeGlobalThis = node => {
    /** @type {TsNode} */
    let at = node
    while (at.parent && ts.isParenthesizedExpression(at.parent)) at = at.parent
    const p = at.parent
    // `globalThis.globalThis` is globalThis again: it was judged as a whole, so its own use decides.
    if (p && (ts.isPropertyAccessExpression(p) || ts.isElementAccessExpression(p)) && p.expression === at && nameOf(p) != null) return
    refuse(node, 'globalThis as a value (a destructure, an alias or a computed member reaches Date.now out of sight)')
  }
  /** @param {TsNode} node */
  const visit = node => {
    // A parenthesized read is judged once, at its innermost node.
    const g = !ts.isParenthesizedExpression(node) && (ts.isIdentifier(node) || ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) ? global(node) : null
    if (g) judge(node, g)
    else if (!ts.isParenthesizedExpression(node) && isGlobalThis(node)) judgeGlobalThis(node)
    else ts.forEachChild(node, visit)
  }
  visit(sf)
  return out
}
