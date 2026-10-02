// The engines' type check, run through the TypeScript API rather than the CLI: one program gives both
// the diagnostics (formatted exactly as `tsc --pretty false` prints them) and the checker that counts
// where an engine's values are `any` — spelled or not (realm @nick/craft, #136).
/** @typedef {typeof import('../opencode/plugin/node_modules/typescript/lib/typescript.js')} TS */
/** @typedef {import('../opencode/plugin/node_modules/typescript/lib/typescript.js').Node} TsNode */
/** @typedef {import('../opencode/plugin/node_modules/typescript/lib/typescript.js').Program} Program */
/** @typedef {import('../opencode/plugin/node_modules/typescript/lib/typescript.js').SourceFile} SourceFile */
/** @typedef {import('../opencode/plugin/node_modules/typescript/lib/typescript.js').TypeChecker} TypeChecker */

/**
 * `tsc -p <config> --pretty false`, in process: the same config parse, the same pre-emit diagnostics,
 * the same text. `status` is 1 when any diagnostic is an error, as the CLI's exit code.
 * @param {TS} ts @param {string} configPath
 * @returns {{ program: Program | null, text: string, status: number }}
 */
export function compileProject(ts, configPath) {
  /** @type {import('../opencode/plugin/node_modules/typescript/lib/typescript.js').Diagnostic[]} */
  const fatal = []
  const host = { getCurrentDirectory: () => ts.sys.getCurrentDirectory(), getCanonicalFileName: (/** @type {string} */ f) => f, getNewLine: () => '\n' }
  const parsed = ts.getParsedCommandLineOfConfigFile(configPath, {}, { ...ts.sys, onUnRecoverableConfigFileDiagnostic: d => { fatal.push(d) } })
  if (!parsed) return { program: null, text: ts.formatDiagnostics(fatal, host), status: 1 }
  const program = ts.createProgram({
    rootNames: parsed.fileNames, options: parsed.options, ...(parsed.projectReferences ? { projectReferences: parsed.projectReferences } : {}),
    configFileParsingDiagnostics: ts.getConfigFileParsingDiagnostics(parsed),
  })
  const diags = [...fatal, ...ts.getPreEmitDiagnostics(program)]
  return { program, text: ts.formatDiagnostics(diags, host), status: diags.some(d => d.category === ts.DiagnosticCategory.Error) ? 1 : 0 }
}

/**
 * Every place in lines [first, last) of `sf` where the checker sees a value of type `any` — an untyped
 * collection read, an untyped callback parameter, a `JSON.parse` result — counted where the `any`
 * enters, not again at each step it flows through: an expression is skipped when one of its operands
 * is already `any` (`x.a.b` on an `any` x is one site, x), and a property name is left to its access.
 * A read of a variable declared in the same lines is left to its declaration (an `any` parameter is
 * one site, however often it is read); a read of anything declared elsewhere — an inlined lib export,
 * a sandbox global — is counted where it is read. A JSDoc cast to an `any` type is left to the
 * spelled count (countAny), which already holds it.
 * Skipped as unavoidable: the declaration name of an evolving `let x` / `let x = null` (no JSDoc
 * type) — its declared type is the checker's placeholder `any` while each assignment's right side
 * is what is counted (an `any` value assigned to it is a site there).
 * @param {TS} ts @param {TypeChecker} checker @param {SourceFile} sf @param {number} first @param {number} last  0-based lines
 * @returns {{ line: number, text: string }[]}  `line` 0-based in `sf`
 */
export function implicitAnySites(ts, checker, sf, first, last) {
  /** @type {{ line: number, text: string }[]} */
  const sites = []
  /** @param {TsNode} n */
  const isAny = n => (checker.getTypeAtLocation(n).flags & ts.TypeFlags.Any) !== 0
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
    if (!(d.parent.flags & ts.NodeFlags.Let) && (d.parent.flags & ts.NodeFlags.Const)) return false
    const init = d.initializer
    return !init || init.kind === ts.SyntaxKind.NullKeyword || (ts.isIdentifier(init) && init.text === 'undefined')
  }
  /** @param {TsNode} n  a read of a variable whose declaration is in the counted lines, so counted there */
  const localRead = n => {
    if (!ts.isIdentifier(n)) return false
    const sym = ts.isShorthandPropertyAssignment(n.parent) ? checker.getShorthandAssignmentValueSymbol(n.parent) : checker.getSymbolAtLocation(n)
    const d = sym?.valueDeclaration
    if (!d || d.getSourceFile() !== sf || d === n.parent) return false
    const line = sf.getLineAndCharacterOfPosition(d.getStart(sf)).line
    return line >= first && line < last
  }
  /** @param {TsNode} n */
  const spelledCast = n => ts.isParenthesizedExpression(n) && ts.getJSDocTypeTag(n) !== undefined
  /** @param {TsNode} n */
  const inherited = n => {
    /** @type {TsNode[]} */
    const operands = []
    if (ts.isPropertyAccessExpression(n)) operands.push(n.expression)
    else ts.forEachChild(n, c => { if (isValue(c)) operands.push(c) })
    if (ts.isVariableDeclaration(n.parent) && n.parent.name === n && n.parent.initializer) operands.push(n.parent.initializer)
    if (ts.isBindingElement(n.parent) && n.parent.name === n) {
      // A destructured name inherits from the value it is taken out of, when that value is itself `any`.
      /** @type {TsNode} */
      let d = n.parent
      while (ts.isBindingElement(d) || ts.isObjectBindingPattern(d) || ts.isArrayBindingPattern(d)) d = d.parent
      if (ts.isVariableDeclaration(d) && d.initializer) operands.push(d.initializer)
    }
    return operands.some(isAny)
  }
  /** @param {TsNode} node */
  const visit = node => {
    const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line
    if (line >= last) return
    if (line >= first && (isValue(node) || ts.isIdentifier(node)) && !isNameOnly(node) && !evolving(node) && !spelledCast(node) &&
      isAny(node) && !localRead(node) && !inherited(node))
      sites.push({ line, text: node.getText(sf).split('\n')[0]?.slice(0, 60) ?? '' })
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return sites
}
