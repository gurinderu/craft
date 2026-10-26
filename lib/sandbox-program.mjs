// A program of engine copies compiled against what the Workflow sandbox provides, and nothing else: the ES library
// and lib/workflow-sandbox.d.ts (realm @nick/craft, #134, #135). Shared by the check of inlined regions
// (lib/inlined-sandbox-names.mjs) and the check of every built engine whole (lib/built-sandbox-names.mjs).
import path from 'node:path'

/** @typedef {typeof import('../opencode/plugin/node_modules/typescript/lib/typescript.js')} TS */
/** @typedef {import('../opencode/plugin/node_modules/typescript/lib/typescript.js').Node} TsNode */
/** @typedef {import('../opencode/plugin/node_modules/typescript/lib/typescript.js').SourceFile} TsSourceFile */
/** @typedef {import('../opencode/plugin/node_modules/typescript/lib/typescript.js').Program} TsProgram */

// Name resolution only: every other diagnostic of the compiled code is lib/'s to report. 2304/2552
// cannot find (did you mean); 2580-2584, 2591-2593 the same with an install or lib hint; 2585 a value
// that is only a type here, 2693 the same where a JSDoc typedef shares a host global's name; 2662/2663
// a free name that matches a class member; 18004 a shorthand
// property with no value in scope.
const FREE_NAME = new Set([2304, 2552, 2580, 2581, 2582, 2583, 2584, 2585, 2591, 2592, 2593, 2662, 2663, 2693, 18004])

/**
 * `files` compiled against the ES library and the sandbox declaration only; the reasons when lib/tsconfig.json cannot be read.
 * @param {string} root @param {TS} ts @param {string[]} files  absolute @param {string} who  names the check in a reason
 * @returns {{ program: TsProgram, sandbox: string } | string[]}
 */
export function compileAgainstSandbox(root, ts, files, who) {
  const read = ts.readConfigFile(path.join(root, 'lib', 'tsconfig.json'), ts.sys.readFile)
  if (read.error) return [`lib/tsconfig.json: ${ts.flattenDiagnosticMessageText(read.error.messageText, ' ')} — ${who} compiled nothing`]
  const base = ts.parseJsonConfigFileContent(read.config, ts.sys, path.join(root, 'lib'))
  if (base.errors.length) return base.errors.map(e => `lib/tsconfig.json: ${ts.flattenDiagnosticMessageText(e.messageText, ' ')} — ${who} compiled nothing`)
  const sandbox = path.resolve(root, 'lib', 'workflow-sandbox.d.ts')
  // `lib` pinned here, not taken from lib/tsconfig.json: that file serves the Node-typed check of lib/,
  // and a `dom` added there for it must not quietly hand the sandbox check TextEncoder and the rest.
  const program = ts.createProgram([...files, sandbox], { ...base.options, lib: ['lib.es2023.d.ts'], types: [], typeRoots: [], noEmit: true })
  return { program, sandbox }
}

/**
 * A program that is not closed: a file beyond the copies, the ES library and the sandbox declaration would bring
 * its own globals in, so each one is a failure, not a quiet widening.
 * @param {TsProgram} program @param {Set<string>} copies  absolute @param {string} sandbox @param {string} who
 * @returns {string[]}
 */
export function openProgramProblems(program, copies, sandbox, who) {
  return program.getSourceFiles().filter(sf => {
    const p = path.resolve(sf.fileName)
    return !copies.has(p) && p !== sandbox && !program.isSourceFileDefaultLibrary(sf)
  }).map(sf => `${who} compiled ${sf.fileName}, which can declare globals the sandbox lacks — its program must hold only the engines, the ES library and lib/workflow-sandbox.d.ts`)
}

/**
 * Every place in `sf` where the code uses a name the sandbox lacks or reaches the host around name resolution,
 * handed to `refuse` with why — which keeps the ones its check is about. A free name inside JSDoc is a type name,
 * not code, and is left out.
 * @param {TS} ts @param {TsProgram} program @param {TsSourceFile} sf @param {(pos: number, what: string) => void} refuse
 */
export function refusedIn(ts, program, sf, refuse) {
  for (const d of program.getSemanticDiagnostics(sf)) {
    if (d.start === undefined || !FREE_NAME.has(d.code) || !startsCode(ts, sf, d.start)) continue
    refuse(d.start, `uses a name the Workflow sandbox does not provide — ${ts.flattenDiagnosticMessageText(d.messageText, ' ')}`)
  }
  /** @param {TsNode} node */
  const visit = node => {
    const what = hostRoute(ts, node)
    if (what) refuse(node.getStart(sf), what)
    ts.forEachChild(node, visit)
  }
  visit(sf)
}

/**
 * Why `node` reaches the host around name resolution, or null. The cases exclude each other by node kind and text.
 * @param {TS} ts @param {TsNode} node @returns {string | null}
 */
function hostRoute(ts, node) {
  if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'require') {
    return 'calls require, which the Workflow sandbox does not provide'
  }
  if (ts.isIdentifier(node)) return identifierRoute(ts, node)
  // Routes to the host that resolve cleanly against the ES library: a dynamic import or
  // import.meta, and code built from a string by eval or the Function constructor.
  if (node.kind === ts.SyntaxKind.ImportKeyword && ts.isCallExpression(node.parent)) return 'imports a module at run time, which the Workflow sandbox cannot'
  if (ts.isMetaProperty(node)) return 'reads import.meta, which the Workflow sandbox has no module for'
  return null
}

/**
 * hostRoute for an identifier: `globalThis`, `eval` or `Function` referring to a binding, not naming a property.
 * @param {TS} ts @param {import('../opencode/plugin/node_modules/typescript/lib/typescript.js').Identifier} node @returns {string | null}
 */
function identifierRoute(ts, node) {
  if (node.text === 'globalThis' && !isPropertyName(ts, node)) return 'reaches for globalThis, which carries more in Node than in the sandbox'
  if ((node.text === 'eval' || node.text === 'Function') && !isPropertyName(ts, node)) return `uses ${node.text}, which runs code no check here can read`
  return null
}

/** True for an identifier that names a property rather than referring to a binding. @param {TS} ts @param {TsNode} node */
function isPropertyName(ts, node) {
  const p = node.parent
  return ((ts.isPropertyAccessExpression(p) || ts.isPropertyAssignment(p) || ts.isMethodDeclaration(p) || ts.isPropertyDeclaration(p) ||
    ts.isGetAccessorDeclaration(p) || ts.isSetAccessorDeclaration(p)) && p.name === node) || (ts.isBindingElement(p) && p.propertyName === node)
}

/**
 * True when `pos` starts a token of the code itself — not one inside a comment, where JSDoc lives
 * (the AST walk does not descend into JSDoc, so a position there is reached by no code node).
 * @param {TS} ts @param {TsSourceFile} sf @param {number} pos
 */
function startsCode(ts, sf, pos) {
  /** @param {TsNode} node @returns {boolean} */
  const hit = node => {
    if (node.getStart(sf) === pos) return true
    return node.pos <= pos && pos < node.end && (ts.forEachChild(node, hit) ?? false)
  }
  return ts.forEachChild(sf, hit) ?? false
}
