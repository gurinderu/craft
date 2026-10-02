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
 * Also refused: `eval` and `Function` (bare, or as a member of globalThis — `globalThis.eval`,
 * `globalThis['Function']`), a dynamic `import()`, `import.meta` — es2023 declares them and nothing
 * shows the sandbox restricts them, so they are refused to keep the engines off dynamic code and the host.
 * @param {string | Parsed} src @param {string} file @param {TS} ts @returns {string[]}
 */
export function forbiddenCalls(src, file, ts) {
  const { sf } = parsed(src, ts)
  /** @type {string[]} */
  const out = []
  /** @param {TsNode} node @param {string} what @param {string} [why] */
  const refuse = (node, what, why = 'which the Workflow sandbox throws on') => out.push(`${file}:${sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1} reads ${what}, ${why}`)
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
  /** @param {TsNode} n */
  const isValueRef = n => isValueReference(ts, n)
  /** @param {TsNode} node  a read of Date/Math: judge it by where it is used */
  const judge = (node, /** @type {string} */ g) => {
    const at = outermostParens(ts, node)
    const p = at.parent
    if (p && judgedByUse(p, at, g)) return
    refuse(node, `${g} as a value (an alias reaches ${g}.${FORBIDDEN[g]} out of sight; use ${g}.x directly)`)
  }
  /** @param {TsNode} p @param {TsNode} at  Date/Math, as `p` uses it @param {string} g @returns {boolean} judged by its use: a member, a `new Date`/`Date()`, or right of instanceof */
  const judgedByUse = (p, at, g) => {
    if (isMemberAccess(ts, p) && p.expression === at) { judgeMember(p, g); return true }
    if (g === 'Date' && judgeDate(p, at)) return true
    return ts.isBinaryExpression(p) && p.operatorToken.kind === ts.SyntaxKind.InstanceOfKeyword && p.right === at
  }
  /** @param {TsNode} p  a member access on Date/Math @param {string} g */
  const judgeMember = (p, g) => {
    const n = nameOf(p)
    if (n == null) refuse(p, `a computed member of ${g}, which may be ${g}.${FORBIDDEN[g]}`)
    else if (n === FORBIDDEN[g]) refuse(p, `${g}.${n}`)
  }
  /** @param {TsNode} p @param {TsNode} at  Date, as `p` uses it @returns {boolean} judged here (a `new Date` or a `Date()` call) */
  const judgeDate = (p, at) => {
    if (ts.isNewExpression(p) && p.expression === at) {
      if (!(p.arguments ?? []).some(a => !ts.isSpreadElement(a))) refuse(p, 'an argless new Date')
      return true
    }
    if (ts.isCallExpression(p) && p.expression === at) { refuse(p, 'Date() called without new'); return true }
    return false
  }
  /** @param {TsNode} node  a read of globalThis: only `globalThis.x` with a literal name is not a value */
  const judgeGlobalThis = node => {
    const at = outermostParens(ts, node)
    const p = at.parent
    if (p && readsNothingOutOf(p, at)) return
    refuse(node, 'globalThis as a value', 'through which a destructure, an alias or a computed member reaches Date.now or Math.random out of sight')
  }
  /** @param {TsNode} p @param {TsNode} at  globalThis, as `p` uses it @returns {boolean} */
  const readsNothingOutOf = (p, at) =>
    // `globalThis.globalThis` is globalThis again: it was judged as a whole, so its own use decides.
    (isMemberAccess(ts, p) && p.expression === at && nameOf(p) != null) ||
    // `typeof globalThis` and `'x' in globalThis` read nothing out of it.
    (ts.isTypeOfExpression(p) && p.expression === at) ||
    (ts.isBinaryExpression(p) && p.operatorToken.kind === ts.SyntaxKind.InKeyword && p.right === at)
  // es2023 declares these, so tsc lets them through; whether the sandbox restricts them is not observed
  // (realm #134), so they are refused to keep the engines off dynamic code and the host.
  const HOST = 'which es2023 declares and nothing shows the sandbox restricts — refused to keep the engines off dynamic code and the host'
  /** @param {string | null} n */
  const dynamic = n => n === 'eval' || n === 'Function'
  /** @param {TsNode} node @returns {string | null} what `node` reads when it is a host escape */
  const hostRoute = node => {
    if (ts.isIdentifier(node)) return dynamic(node.text) && isValueRef(node) ? node.text : null
    if (isMemberAccess(ts, node)) return dynamic(nameOf(node)) && isGlobalThis(node.expression) ? `globalThis.${nameOf(node)}` : null
    return importRoute(ts, node)
  }
  /** @param {TsNode} node @returns {boolean} refused as a host escape */
  const hostEscape = node => {
    const what = hostRoute(node)
    if (what == null) return false
    refuse(node, what, HOST)
    return true
  }
  /** @param {TsNode} node */
  const visit = node => {
    if (hostEscape(node)) return
    // A parenthesized read is judged once, at its innermost node.
    const g = !ts.isParenthesizedExpression(node) && (ts.isIdentifier(node) || ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) ? global(node) : null
    if (g) judge(node, g)
    else if (!ts.isParenthesizedExpression(node) && isGlobalThis(node)) judgeGlobalThis(node)
    else ts.forEachChild(node, visit)
  }
  visit(sf)
  return out
}

/**
 * `node`, or the outermost parenthesized expression wrapping it.
 * @param {TS} ts @param {TsNode} node @returns {TsNode}
 */
function outermostParens(ts, node) {
  let at = node
  while (at.parent && ts.isParenthesizedExpression(at.parent)) at = at.parent
  return at
}

/**
 * @param {TS} ts @param {TsNode} n
 * @returns {n is import('../opencode/plugin/node_modules/typescript/lib/typescript.js').PropertyAccessExpression | import('../opencode/plugin/node_modules/typescript/lib/typescript.js').ElementAccessExpression}
 */
function isMemberAccess(ts, n) {
  return ts.isPropertyAccessExpression(n) || ts.isElementAccessExpression(n)
}

/**
 * Whether the identifier `n` is a value read, not a property, binding, declaration, label or import/export name.
 * @param {TS} ts @param {TsNode} n @returns {boolean}
 */
function isValueReference(ts, n) {
  const p = n.parent
  if (!p) return false
  if ((namesAMember(ts, p) || declaresAName(ts, p)) && p.name === n) return false
  if (ts.isBindingElement(p) && p.propertyName === n) return false
  return !isLabelOrModuleName(ts, p)
}

/** A label, or a name an import or export binds. @param {TS} ts @param {TsNode} p @returns {boolean} */
export function isLabelOrModuleName(ts, p) {
  return ts.isLabeledStatement(p) || ts.isBreakOrContinueStatement(p) || ts.isImportSpecifier(p) || ts.isExportSpecifier(p) || ts.isImportClause(p)
}

/** What `node` reads when it is a dynamic `import()` or `import.meta`, else null. @param {TS} ts @param {TsNode} node @returns {string | null} */
function importRoute(ts, node) {
  if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) return 'a dynamic import()'
  if (ts.isMetaProperty(node) && node.keywordToken === ts.SyntaxKind.ImportKeyword) return 'import.meta'
  return null
}

/**
 * @param {TS} ts @param {TsNode} p
 * @returns {p is import('../opencode/plugin/node_modules/typescript/lib/typescript.js').PropertyAccessExpression | import('../opencode/plugin/node_modules/typescript/lib/typescript.js').PropertyAssignment | import('../opencode/plugin/node_modules/typescript/lib/typescript.js').MethodDeclaration | import('../opencode/plugin/node_modules/typescript/lib/typescript.js').PropertyDeclaration | import('../opencode/plugin/node_modules/typescript/lib/typescript.js').GetAccessorDeclaration | import('../opencode/plugin/node_modules/typescript/lib/typescript.js').SetAccessorDeclaration}
 */
export function namesAMember(ts, p) {
  return ts.isPropertyAccessExpression(p) || ts.isPropertyAssignment(p) || ts.isMethodDeclaration(p) || ts.isPropertyDeclaration(p) ||
    ts.isGetAccessorDeclaration(p) || ts.isSetAccessorDeclaration(p)
}

/**
 * @param {TS} ts @param {TsNode} p
 * @returns {p is import('../opencode/plugin/node_modules/typescript/lib/typescript.js').VariableDeclaration | import('../opencode/plugin/node_modules/typescript/lib/typescript.js').ParameterDeclaration | import('../opencode/plugin/node_modules/typescript/lib/typescript.js').FunctionDeclaration | import('../opencode/plugin/node_modules/typescript/lib/typescript.js').ClassDeclaration | import('../opencode/plugin/node_modules/typescript/lib/typescript.js').BindingElement}
 */
function declaresAName(ts, p) {
  return ts.isVariableDeclaration(p) || ts.isParameter(p) || ts.isFunctionDeclaration(p) || ts.isClassDeclaration(p) || ts.isBindingElement(p)
}
