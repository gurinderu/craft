// Where an engine's values are `any` by the type checker's reading — spelled or not — counted where
// the `any` enters (realm @nick/craft, #136). Fed the checker of the program lib/engine-checker.mjs compiles.
/** @typedef {typeof import('../opencode/plugin/node_modules/typescript/lib/typescript.js')} TS */
/** @typedef {import('../opencode/plugin/node_modules/typescript/lib/typescript.js').Node} TsNode */
/** @typedef {import('../opencode/plugin/node_modules/typescript/lib/typescript.js').SourceFile} SourceFile */
/** @typedef {import('../opencode/plugin/node_modules/typescript/lib/typescript.js').TypeChecker} TypeChecker */
/** @typedef {import('../opencode/plugin/node_modules/typescript/lib/typescript.js').Type} TsType */

/**
 * Every place in lines [first, last) of `sf` where the checker sees a value of type `any` — an untyped
 * collection read, an untyped callback parameter, a `JSON.parse` result — counted where the `any`
 * enters, not again at each step it flows through: an expression is skipped when one of its operands
 * is already `any` (`x.a.b` on an `any` x is one site, x), and a property name is left to its access.
 * An `any` inside a type counts too (`any[]` from Array.isArray on `unknown`, `Promise<any>`); a call
 * on such a receiver, its callback's parameters, and a call whose callback returns one inherit it.
 * A read of a variable declared in the same lines is left to its declaration (an `any` parameter is
 * one site, however often it is read), unless only the read is `any` — a narrowing, one site per
 * variable; a read of anything declared elsewhere — an inlined lib export, a sandbox global — is
 * counted where it is read. A JSDoc cast to an `any` type is left to the spelled count (countAny); a
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
  /** @type {Set<import('../opencode/plugin/node_modules/typescript/lib/typescript.js').Symbol>} */
  const narrowed = new Set()
  /** @param {TsNode} n */
  const isValue = n => ts.isExpression(n) && !isNameOnly(n)
  /** @param {TsNode} n  an identifier that names a property, a label or an import, not a value of its own */
  const isNameOnly = n => {
    const p = n.parent
    if (!ts.isIdentifier(n) || !p) return false
    if ((ts.isPropertyAccessExpression(p) || ts.isPropertyAssignment(p) || ts.isMethodDeclaration(p) || ts.isPropertyDeclaration(p) ||
      ts.isGetAccessorDeclaration(p) || ts.isSetAccessorDeclaration(p)) && p.name === n) return true
    if (ts.isBindingElement(p) && p.propertyName === n) return true
    // The target of a plain `=`: what it holds is the right side, counted there (and an evolving
    // `let`'s target reads as the placeholder `any` the skip below describes).
    if (ts.isBinaryExpression(p) && p.left === n && p.operatorToken.kind === ts.SyntaxKind.EqualsToken) return true
    return ts.isLabeledStatement(p) || ts.isBreakOrContinueStatement(p) || ts.isImportSpecifier(p) || ts.isExportSpecifier(p) ||
      ts.isImportClause(p) || ts.isNamespaceImport(p)
  }
  /** @param {TsNode} n */
  const evolving = n => {
    const d = n.parent
    if (!d || !ts.isVariableDeclaration(d) || d.name !== n || !ts.isVariableStatement(d.parent.parent) || ts.getJSDocType(d)) return false
    const init = d.initializer
    // An empty array literal evolves by its pushes, `let` or `const` alike.
    if (init && ts.isArrayLiteralExpression(init) && init.elements.length === 0) return true
    if (!(d.parent.flags & ts.NodeFlags.Let) && (d.parent.flags & ts.NodeFlags.Const)) return false
    return !init || init.kind === ts.SyntaxKind.NullKeyword || (ts.isIdentifier(init) && init.text === 'undefined')
  }
  /** @param {TsNode} n  a read of a variable whose declaration is in the counted lines, so counted there */
  const localRead = n => {
    if (!ts.isIdentifier(n)) return false
    const sym = ts.isShorthandPropertyAssignment(n.parent) ? checker.getShorthandAssignmentValueSymbol(n.parent) : checker.getSymbolAtLocation(n)
    const d = sym?.valueDeclaration
    if (!sym || !d || d.getSourceFile() !== sf || d === n.parent) return false
    const line = sf.getLineAndCharacterOfPosition(d.getStart(sf)).line
    if (line < first || line >= last) return false
    if (anyBearing(checker.getTypeOfSymbol(sym))) return true
    // A narrowing: the declaration is not `any`, this read is. Counted at its first read only.
    if (narrowed.has(sym)) return true
    narrowed.add(sym)
    return false
  }
  /** @param {TsNode} n */
  const spelledCast = n => ts.isParenthesizedExpression(n) && ts.getJSDocTypeTag(n) !== undefined
  /**
   * The value a JSDoc cast or a JSDoc-typed declaration, to a type without `any`, gives its type —
   * reached through parentheses, a conditional's branches and `||`/`??`.
   * @param {TsNode} n
   */
  const castToTyped = n => {
    /** @type {TsNode} */
    let at = n
    for (let p = at.parent; p; at = p, p = p.parent) {
      if (spelledCast(p)) return !isAny(p)
      if (ts.isParenthesizedExpression(p) || (ts.isConditionalExpression(p) && p.condition !== at)) continue
      if (ts.isBinaryExpression(p) && (p.operatorToken.kind === ts.SyntaxKind.BarBarToken || p.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken)) continue
      // A declaration asserts nothing about an `any` a value carries (a parse, a narrowed any[]): it only
      // fixes the checker's placeholder for a type it could not infer — an argless `new Map()`.
      if (ts.isVariableDeclaration(p) && p.initializer === at && ts.getJSDocType(p))
        return ts.isNewExpression(n) && !n.typeArguments && !n.arguments?.length && !anyBearing(checker.getTypeAtLocation(p.name))
      return false
    }
    return false
  }
  /** @param {TsNode} n */
  const inherited = n => {
    /** @type {TsNode[]} */
    const operands = []
    if (ts.isPropertyAccessExpression(n)) operands.push(n.expression)
    else if (ts.isObjectLiteralExpression(n)) n.properties.forEach(pr => { if (ts.isPropertyAssignment(pr)) operands.push(pr.initializer) })
    else ts.forEachChild(n, c => { if (isValue(c)) operands.push(c) })
    // A method called on an `any`-bearing receiver (`v.map(…)` on an `any[]` v) inherits from it.
    if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression)) operands.push(n.expression.expression)
    // …or from a callback whose return carries the `any`, already counted inside it (`p.catch(e => [e])`).
    if (ts.isCallExpression(n) && n.arguments.some(a => (ts.isArrowFunction(a) || ts.isFunctionExpression(a)) &&
      checker.getSignaturesOfType(checker.getTypeAtLocation(a), ts.SignatureKind.Call).some(sig => anyBearing(sig.getReturnType())))) return true
    // A callback parameter typed by such a call: `e` in `v.map(e => …)`.
    const fn = ts.isParameter(n.parent) && n.parent.name === n ? n.parent.parent : null
    if (fn && (ts.isArrowFunction(fn) || ts.isFunctionExpression(fn)) && fn.parent && ts.isCallExpression(fn.parent) &&
      ts.isPropertyAccessExpression(fn.parent.expression)) operands.push(fn.parent.expression.expression)
    if (ts.isVariableDeclaration(n.parent) && n.parent.name === n && n.parent.initializer) operands.push(n.parent.initializer)
    // `e` in `for (const e of xs)` inherits from xs.
    const loop = ts.isVariableDeclaration(n.parent) && n.parent.name === n ? n.parent.parent.parent : null
    if (loop && ts.isForOfStatement(loop)) operands.push(loop.expression)
    if (ts.isBindingElement(n.parent) && n.parent.name === n) {
      // A destructured name inherits from the value it is taken out of, when that value is itself `any`.
      /** @type {TsNode} */
      let d = n.parent
      while (ts.isBindingElement(d) || ts.isObjectBindingPattern(d) || ts.isArrayBindingPattern(d)) d = d.parent
      if (ts.isVariableDeclaration(d) && d.initializer) operands.push(d.initializer)
      if (ts.isVariableDeclaration(d) && ts.isForOfStatement(d.parent.parent)) operands.push(d.parent.parent.expression)
    }
    return operands.some(isAny)
  }
  /** @param {TsNode} node */
  const visit = node => {
    const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line
    if (line >= last) return
    if (line >= first && (isValue(node) || ts.isIdentifier(node)) && !isNameOnly(node) && !evolving(node) && !spelledCast(node) &&
      !castToTyped(node) && isAny(node) && !inherited(node) && !localRead(node))
      sites.push({ line, text: node.getText(sf).split('\n')[0]?.slice(0, 60) ?? '' })
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return sites
}
