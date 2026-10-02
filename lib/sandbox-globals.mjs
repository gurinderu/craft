// What the Workflow sandbox does NOT provide, observed with a probe workflow (realm @nick/craft, #135):
// TextEncoder, TextDecoder, process and require are undefined there. One list, read by the engine
// harness (which shadows each name) and by check-workflows (which refuses each name in inlined code —
// that code is type-checked in its lib module against Node typings, where every one of them exists).
// The check parses rather than pattern-matches: a backtick or quote inside a regex literal once hid
// hundreds of lines from a hand-written stripper.
export const SANDBOX_ABSENT = ['TextEncoder', 'TextDecoder', 'process', 'require']

/** @typedef {typeof import('../opencode/plugin/node_modules/typescript/lib/typescript.js')} TS */

/**
 * Each use of a SANDBOX_ABSENT name as code — found by parsing, so comments, strings, templates and
 * regex literals cannot hide one or fake one. A property name (`x.process`, `{ require: 1 }`) is not a
 * use; any other identifier with the name is, a local declaration included (it would mask the absence).
 * `ts` is the TypeScript module, passed in so this file stays loadable where it is not installed.
 * @param {string} text @param {TS} ts @returns {{ line: number, name: string }[]}
 */
export function absentGlobalUses(text, ts) {
  const sf = ts.createSourceFile('region.js', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
  const names = new Set(SANDBOX_ABSENT)
  /** @type {{ line: number, name: string }[]} */
  const out = []
  /** @param {import('../opencode/plugin/node_modules/typescript/lib/typescript.js').Node} node */
  const visit = node => {
    if (ts.isIdentifier(node) && names.has(node.text)) {
      const p = node.parent
      const propertyName = (ts.isPropertyAccessExpression(p) && p.name === node) ||
        ((ts.isPropertyAssignment(p) || ts.isMethodDeclaration(p) || ts.isPropertyDeclaration(p) || ts.isGetAccessorDeclaration(p) || ts.isSetAccessorDeclaration(p)) && p.name === node)
      if (!propertyName) out.push({ line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1, name: node.text })
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return out
}
