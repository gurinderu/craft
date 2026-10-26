// What a bundled engine may not carry (realm @nick/craft, #210): a module route the sandbox cannot follow — an
// `import` or `export` beyond the banner's meta, a dynamic `import()`, `import.meta`, `require` — and a name its
// sources never spell. esbuild renames a binding that shadows another or a used global, with no option to stop
// it (#343, #345), and adds helpers of its own for some module shapes; either way the shipped file would no
// longer read as its source, so the build refuses it, naming the name.

/** @typedef {import('./region-strip.mjs').TypeScript} TypeScript */
/** @typedef {import('../opencode/plugin/node_modules/typescript/lib/typescript.js').Node} TsNode */
/** @typedef {import('../opencode/plugin/node_modules/typescript/lib/typescript.js').SourceFile} TsSourceFile */

/** @param {TypeScript} ts @param {string} name @param {string} text */
const parse = (ts, name, text) => ts.createSourceFile(name, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)

/** Every identifier the code of `sf` spells (JSDoc not included). @param {TypeScript} ts @param {TsSourceFile} sf @returns {Set<string>} */
export function spelledNames(ts, sf) {
  /** @type {Set<string>} */
  const names = new Set()
  /** @param {TsNode} n */
  const visit = n => {
    if (ts.isIdentifier(n) || ts.isPrivateIdentifier(n)) names.add(n.text)
    ts.forEachChild(n, visit)
  }
  visit(sf)
  return names
}

/**
 * Why `node` is a module route the sandbox cannot follow, or null.
 * @param {TypeScript} ts @param {TsNode} node @param {TsSourceFile} sf
 * @returns {string | null}
 */
function moduleRoute(ts, node, sf) {
  /** @param {string} what */
  const quoted = what => `${what} survives (\`${node.getText(sf).slice(0, 60)}\`)`
  if (ts.isImportDeclaration(node) || ts.isImportEqualsDeclaration(node)) return quoted('an import')
  if (ts.isExportDeclaration(node) || ts.isExportAssignment(node)) return quoted('an export')
  return hostModuleRoute(ts, node)
}

/** A dynamic import, import.meta or require, or null. @param {TypeScript} ts @param {TsNode} node @returns {string | null} */
function hostModuleRoute(ts, node) {
  if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) return 'a dynamic import() survives'
  if (ts.isMetaProperty(node) && node.keywordToken === ts.SyntaxKind.ImportKeyword) return 'import.meta survives'
  const named = ts.isIdentifier(node) && node.text === 'require'
  return named && !(ts.isPropertyAccessExpression(node.parent) && node.parent.name === node) ? 'require survives' : null
}

/**
 * Every problem of a bundle: its module routes, then the names no source spells.
 * @param {TypeScript} ts @param {string} body  the bundle, banner first, its trailing `export{__run}` dropped
 * @param {string} banner  what heads it, meta first
 * @param {{ file: string, text: string }[]} inputs  every source esbuild read
 * @returns {string[]}
 */
export function bundleProblems(ts, body, banner, inputs) {
  const sf = parse(ts, 'bundle.js', body)
  /** @type {string[]} */
  const problems = []
  const first = sf.statements[0]
  if (!first || !body.startsWith(banner) || !ts.isVariableStatement(first)) problems.push('the bundle does not open with its banner')
  for (const s of sf.statements.slice(1)) if (exported(ts, s)) problems.push(`an export survives (\`${s.getText(sf).slice(0, 60)}\`)`)
  /** @param {TsNode} n */
  const visit = n => {
    const why = moduleRoute(ts, n, sf)
    if (why) problems.push(why)
    ts.forEachChild(n, visit)
  }
  visit(sf)
  return [...problems, ...unspelledNames(ts, sf, inputs)]
}

/** @param {TypeScript} ts @param {TsNode} s */
const exported = (ts, s) => ts.canHaveModifiers(s) && !!ts.getModifiers(s)?.some(m => m.kind === ts.SyntaxKind.ExportKeyword)

/**
 * Each name the bundle spells and none of its sources does.
 * @param {TypeScript} ts @param {TsSourceFile} sf @param {{ file: string, text: string }[]} inputs @returns {string[]}
 */
function unspelledNames(ts, sf, inputs) {
  /** @type {Set<string>} */
  const spelled = new Set()
  for (const { file, text } of inputs) for (const n of spelledNames(ts, parse(ts, file, text))) spelled.add(n)
  return [...spelledNames(ts, sf)].filter(x => !spelled.has(x)).sort().map(n =>
    `the bundle spells \`${n}\`, a name none of its sources spells — esbuild renamed a binding that shadows another or a used global (rename it in the source), or added a helper of its own`)
}
