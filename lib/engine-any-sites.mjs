// Where an engine's values are `any` by the type checker's reading — spelled or not — counted where
// the `any` enters (realm @nick/craft, #136). Fed the checker of the program lib/engine-checker.mjs compiles.
/** @typedef {typeof import('../opencode/plugin/node_modules/typescript/lib/typescript.js')} TS */
/** @typedef {import('../opencode/plugin/node_modules/typescript/lib/typescript.js').Node} TsNode */
/** @typedef {import('../opencode/plugin/node_modules/typescript/lib/typescript.js').SourceFile} SourceFile */
/** @typedef {import('../opencode/plugin/node_modules/typescript/lib/typescript.js').TypeChecker} TypeChecker */
/** @typedef {import('../opencode/plugin/node_modules/typescript/lib/typescript.js').Type} TsType */
/** @typedef {import('../opencode/plugin/node_modules/typescript/lib/typescript.js').Symbol} TsSymbol */
/** @typedef {import('../opencode/plugin/node_modules/typescript/lib/typescript.js').Identifier} TsIdentifier */
import { isLabelOrModuleName, namesAMember } from './engine-clock-rule.mjs'

/**
 * Every place in lines [first, last) of `sf` where the checker sees a value of type `any` — an untyped
 * collection read, an untyped callback parameter, a `JSON.parse` result — counted where the `any`
 * enters, not again at each step it flows through: an expression is skipped when one of its operands
 * is already `any` (`x.a.b` on an `any` x is one site, x), and a property name is left to its access.
 * An `any` inside a type counts too (`any[]` from Array.isArray on `unknown`, `Promise<any>`); a call
 * on such a receiver, its callback's parameters, and a call whose callback returns one inherit it.
 * A read of a variable declared in the same lines is left to its declaration (an `any` parameter is
 * one site, however often it is read), unless only the read is `any` — a narrowing, one site per
 * variable and outermost if/?:/&&/|| whose test reads it (reads nested under it are the same site; two
 * sibling narrowings are two; nested narrowings under an outer test of the same variable are one); a
 * read of anything declared elsewhere — an inlined lib export, a sandbox global — is counted where it is read. A JSDoc cast to an `any` type is left to the spelled count (countAny); a
 * value cast to a type without `any` takes its type there and is no site (`JSON.parse` under a typed
 * cast); a JSDoc-typed declaration fixes only the checker's placeholder (an argless `new Map()`),
 * never an `any` a value carries (a parse, a narrowed any[]).
 * Skipped as unavoidable: the declaration name of an evolving `let x` / `let x = null` / `x = []` (no
 * JSDoc type) — its declared type is the checker's placeholder while each assignment's right side, or
 * each pushed value, is what is counted.
 * @param {TS} ts @param {TypeChecker} checker @param {SourceFile} sf @param {number} first @param {number} last  0-based lines
 * @returns {{ line: number, text: string }[]}  `line` 0-based in `sf`
 */
export function implicitAnySites(ts, checker, sf, first, last) {
  /** @type {{ line: number, text: string }[]} */
  const sites = []
  /** @param {TsType} t @param {number} [depth] @returns {boolean} */
  const anyBearing = (t, depth = 0) => {
    if (t.flags & ts.TypeFlags.Any) return true
    if (depth > 3) return false
    if (t.isUnionOrIntersection()) return t.types.some(x => anyBearing(x, depth + 1))
    // An anonymous object type (an object literal's) carries what its properties carry.
    if ((t.flags & ts.TypeFlags.Object) && (/** @type {import('../opencode/plugin/node_modules/typescript/lib/typescript.js').ObjectType} */ (t).objectFlags & ts.ObjectFlags.Anonymous))
      return checker.getPropertiesOfType(t).some(p => anyBearing(checker.getTypeOfSymbol(p), depth + 1))
    if ((t.flags & ts.TypeFlags.Object) && (/** @type {import('../opencode/plugin/node_modules/typescript/lib/typescript.js').ObjectType} */ (t).objectFlags & ts.ObjectFlags.Reference))
      return checker.getTypeArguments(/** @type {import('../opencode/plugin/node_modules/typescript/lib/typescript.js').TypeReference} */ (t)).some(x => anyBearing(x, depth + 1))
    return false
  }
  /** @param {TsNode} n */
  const isAny = n => anyBearing(checker.getTypeAtLocation(n))
  /** @type {Map<TsSymbol, Set<TsNode>>} */
  const narrowed = new Map()
  /** @param {TsIdentifier} n @returns {TsSymbol | null} the variable `n` reads, when it is declared in the counted lines */
  const localSymbol = n => {
    const sym = ts.isShorthandPropertyAssignment(n.parent) ? checker.getShorthandAssignmentValueSymbol(n.parent) : checker.getSymbolAtLocation(n)
    const d = sym?.valueDeclaration
    if (!sym || !d || d.getSourceFile() !== sf || d === n.parent) return null
    const line = sf.getLineAndCharacterOfPosition(d.getStart(sf)).line
    return line < first || line >= last ? null : sym
  }
  /** @param {TsNode} n  a read of a variable whose declaration is in the counted lines, so counted there */
  const localRead = n => {
    if (!ts.isIdentifier(n)) return false
    const sym = localSymbol(n)
    if (!sym) return false
    if (anyBearing(checker.getTypeOfSymbol(sym))) return true
    // A narrowing: the declaration is not `any`, this read is. One site per narrowing (narrowingSite).
    const at = narrowingSite(ts, checker, n, sym)
    const seen = narrowed.get(sym) ?? new Set()
    if (seen.has(at)) return true
    narrowed.set(sym, seen.add(at))
    return false
  }
  /**
   * The value a JSDoc cast or a JSDoc-typed declaration, to a type without `any`, gives its type —
   * reached through parentheses, a conditional's branches and `||`/`??`.
   * @param {TsNode} n
   */
  const castToTyped = n => {
    /** @type {TsNode} */
    let at = n
    for (let p = at.parent; p; at = p, p = p.parent) {
      if (spelledCast(ts, p)) return !isAny(p)
      if (passesTypeThrough(ts, p, at)) continue
      return declarationTypes(p, at, n)
    }
    return false
  }
  /** @param {TsNode} p @param {TsNode} at  `p`'s child on the way up from `n` @param {TsNode} n @returns {boolean} */
  const declarationTypes = (p, at, n) => {
    // A declaration asserts nothing about an `any` a value carries (a parse, a narrowed any[]): it only
    // fixes the checker's placeholder for a type it could not infer — an argless `new Map()`.
    if (ts.isVariableDeclaration(p) && p.initializer === at && ts.getJSDocType(p))
      return ts.isNewExpression(n) && !n.typeArguments && !n.arguments?.length && !anyBearing(checker.getTypeAtLocation(p.name))
    return false
  }
  /** @param {import('../opencode/plugin/node_modules/typescript/lib/typescript.js').CallExpression} call  a call with a callback whose return carries an `any` */
  const callbackCarriesAny = call => call.arguments.some(a => (ts.isArrowFunction(a) || ts.isFunctionExpression(a)) &&
    checker.getSignaturesOfType(checker.getTypeAtLocation(a), ts.SignatureKind.Call).some(sig => anyBearing(sig.getReturnType())))
  /** @param {TsNode} n */
  const inherited = n => {
    // …from a callback whose return carries the `any`, already counted inside it (`p.catch(e => [e])`).
    if (ts.isCallExpression(n) && callbackCarriesAny(n)) return true
    return [...valueOperands(ts, n), ...bindingSources(ts, n)].some(isAny)
  }
  /** @param {TsNode} node */
  const isSite = node => (isValue(ts, node) || ts.isIdentifier(node)) && !isNameOnly(ts, node) && !evolving(ts, node) &&
    !spelledCast(ts, node) && !castToTyped(node) && isAny(node) && !inherited(node) && !localRead(node)
  /** @param {TsNode} node */
  const visit = node => {
    const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line
    if (line >= last) return
    if (line >= first && isSite(node)) sites.push({ line, text: node.getText(sf).split('\n')[0]?.slice(0, 60) ?? '' })
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return sites
}

/** @param {TS} ts @param {TsNode} n */
function isValue(ts, n) {
  return ts.isExpression(n) && !isNameOnly(ts, n)
}

/** An identifier that names a property, a label or an import, not a value of its own. @param {TS} ts @param {TsNode} n */
function isNameOnly(ts, n) {
  const p = n.parent
  if (!ts.isIdentifier(n) || !p) return false
  if (namesAMember(ts, p) && p.name === n) return true
  if (ts.isBindingElement(p) && p.propertyName === n) return true
  if (isAssignmentTarget(ts, p, n)) return true
  return isLabelOrModuleName(ts, p) || ts.isNamespaceImport(p)
}

/**
 * The target of a plain `=`: what it holds is the right side, counted there (and an evolving
 * `let`'s target reads as the placeholder `any` the skip in implicitAnySites describes).
 * @param {TS} ts @param {TsNode} p @param {TsNode} n
 */
function isAssignmentTarget(ts, p, n) {
  return ts.isBinaryExpression(p) && p.left === n && p.operatorToken.kind === ts.SyntaxKind.EqualsToken
}

/** The name of an evolving `let x` / `let x = null` / `x = []` with no JSDoc type. @param {TS} ts @param {TsNode} n */
function evolving(ts, n) {
  const d = n.parent
  if (!d || !ts.isVariableDeclaration(d) || d.name !== n || !ts.isVariableStatement(d.parent.parent) || ts.getJSDocType(d)) return false
  return evolvesFromItsInitializer(ts, d)
}

/** @param {TS} ts @param {import('../opencode/plugin/node_modules/typescript/lib/typescript.js').VariableDeclaration} d  an untyped declaration in a variable statement */
function evolvesFromItsInitializer(ts, d) {
  const init = d.initializer
  // An empty array literal evolves by its pushes, `let` or `const` alike.
  if (init && ts.isArrayLiteralExpression(init) && init.elements.length === 0) return true
  if (!(d.parent.flags & ts.NodeFlags.Let) && (d.parent.flags & ts.NodeFlags.Const)) return false
  return !init || init.kind === ts.SyntaxKind.NullKeyword || (ts.isIdentifier(init) && init.text === 'undefined')
}

/** An if, a conditional, or `&&`/`||`: a construct that narrows. @param {TS} ts @param {TsNode} n */
function narrows(ts, n) {
  return ts.isIfStatement(n) || ts.isConditionalExpression(n) ||
    (ts.isBinaryExpression(n) && (n.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken || n.operatorToken.kind === ts.SyntaxKind.BarBarToken))
}

/** @param {TS} ts @param {TypeChecker} checker @param {TsNode} e @param {TsSymbol} sym @returns {boolean} `e` reads `sym` */
function reads(ts, checker, e, sym) {
  return (ts.isIdentifier(e) && checker.getSymbolAtLocation(e) === sym) || (ts.forEachChild(e, c => reads(ts, checker, c, sym) || undefined) ?? false)
}

/** The test of a narrowing construct, or null. @param {TS} ts @param {TsNode} at @returns {TsNode | null} */
function narrowingTest(ts, at) {
  if (ts.isIfStatement(at)) return at.expression
  if (ts.isConditionalExpression(at)) return at.condition
  return ts.isBinaryExpression(at) && narrows(ts, at) ? at.left : null
}

/**
 * Where a narrowing read of `sym` at `n` is keyed: the outermost if/?:/&&/|| whose test reads this
 * variable — so reads nested under it (an inner `if`, the narrowing's own `&&`, a closure) are the same
 * site; with no such test (an early return), the nearest narrowing construct, else the enclosing function.
 * @param {TS} ts @param {TypeChecker} checker @param {TsNode} n @param {TsSymbol} sym @returns {TsNode}
 */
function narrowingSite(ts, checker, n, sym) {
  /** @type {TsNode | null} */
  let key = null
  /** @type {TsNode} */
  let near = n
  while (near.parent && !(narrows(ts, near) || ts.isFunctionLike(near) || ts.isSourceFile(near))) near = near.parent
  for (let at = n.parent; at; at = at.parent) {
    const test = narrowingTest(ts, at)
    if (test && reads(ts, checker, test, sym)) key = at
  }
  return key ?? near
}

/** @param {TS} ts @param {TsNode} n */
function spelledCast(ts, n) {
  return ts.isParenthesizedExpression(n) && ts.getJSDocTypeTag(n) !== undefined
}

/** Parentheses, a conditional's branch, or `||`/`??`: a value's type passes up through `p`. @param {TS} ts @param {TsNode} p @param {TsNode} at */
function passesTypeThrough(ts, p, at) {
  return ts.isParenthesizedExpression(p) || (ts.isConditionalExpression(p) && p.condition !== at) ||
    (ts.isBinaryExpression(p) && (p.operatorToken.kind === ts.SyntaxKind.BarBarToken || p.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken))
}

/**
 * The operands an expression's `any` would come from: an access's object, an object literal's values,
 * every value child otherwise, and the receiver of a method call (`v.map(…)` on an `any[]` v).
 * @param {TS} ts @param {TsNode} n @returns {TsNode[]}
 */
function valueOperands(ts, n) {
  /** @type {TsNode[]} */
  const operands = []
  if (ts.isPropertyAccessExpression(n)) operands.push(n.expression)
  else if (ts.isObjectLiteralExpression(n)) n.properties.forEach(pr => { if (ts.isPropertyAssignment(pr)) operands.push(pr.initializer) })
  else ts.forEachChild(n, c => { if (isValue(ts, c)) operands.push(c) })
  if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression)) operands.push(n.expression.expression)
  return operands
}

/**
 * What a bound name inherits from: a callback parameter typed by a method call (`e` in `v.map(e => …)`),
 * a declared name's initializer or for-of source, a destructured name's (when that value is itself `any`).
 * @param {TS} ts @param {TsNode} n @returns {TsNode[]}
 */
function bindingSources(ts, n) {
  /** @type {TsNode[]} */
  const operands = []
  const receiver = callbackReceiver(ts, n)
  if (receiver) operands.push(receiver)
  if (ts.isVariableDeclaration(n.parent) && n.parent.name === n) operands.push(...declarationSources(ts, n.parent))
  if (ts.isBindingElement(n.parent) && n.parent.name === n) {
    /** @type {TsNode} */
    let d = n.parent
    while (ts.isBindingElement(d) || ts.isObjectBindingPattern(d) || ts.isArrayBindingPattern(d)) d = d.parent
    if (ts.isVariableDeclaration(d)) operands.push(...declarationSources(ts, d))
  }
  return operands
}

/** The receiver of the method call whose callback declares `n` as a parameter, or null. @param {TS} ts @param {TsNode} n @returns {TsNode | null} */
function callbackReceiver(ts, n) {
  const fn = ts.isParameter(n.parent) && n.parent.name === n ? n.parent.parent : null
  if (!fn || !(ts.isArrowFunction(fn) || ts.isFunctionExpression(fn))) return null
  const call = fn.parent
  return call && ts.isCallExpression(call) && ts.isPropertyAccessExpression(call.expression) ? call.expression.expression : null
}

/**
 * A declaration's initializer, and the iterable of the for-of it heads (`e` in `for (const e of xs)` inherits from xs).
 * @param {TS} ts @param {import('../opencode/plugin/node_modules/typescript/lib/typescript.js').VariableDeclaration} d @returns {TsNode[]}
 */
function declarationSources(ts, d) {
  /** @type {TsNode[]} */
  const out = []
  if (d.initializer) out.push(d.initializer)
  const loop = d.parent.parent
  if (ts.isForOfStatement(loop)) out.push(loop.expression)
  return out
}
