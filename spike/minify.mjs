// Spike (realm @nick/craft, #208): minify an engine with esbuild, no renaming.
// The engines carry top-level export + await + return, legal only in the sandbox's wrapper, so esbuild
// (which refuses a top-level return in ESM) is handed the same wrapper check-workflows uses, and the
// wrapper is taken off the output again.
import * as esbuild from 'esbuild'
import ts from 'typescript'

const HEAD = 'async function __wf(){\n'

/** @param {string} src @param {{ whitespace: boolean }} o */
export async function minifyEngine(src, { whitespace }) {
  if (!/^export const meta = \{/.test(src)) throw new Error('engine does not start with `export const meta = {`')
  const wrapped = HEAD + src.replace(/^export const meta/, 'const meta') + '\n}\n'
  const r = await esbuild.transform(wrapped, {
    format: 'esm', target: 'esnext', legalComments: 'none', charset: 'utf8',
    minifyWhitespace: whitespace, minifySyntax: true, minifyIdentifiers: false,
  })
  let code = r.code
  if (whitespace) {
    const open = 'async function __wf(){'
    if (!code.startsWith(open) || !code.trimEnd().endsWith('}')) throw new Error('unexpected wrapper shape: ' + code.slice(0, 60))
    code = code.slice(open.length, code.trimEnd().length - 1)
  } else {
    code = unwrapPretty(code)
  }
  return { code: 'export ' + code + (code.endsWith('\n') ? '' : '\n'), warnings: r.warnings, rawStart: code.slice(0, 40) }
}

// esbuild's pretty output: `async function __wf() {\n  <body indented by 2>\n}\n`. Drop the first and
// last line and one indent level from every line that does not start inside a string or template.
/** @param {string} code */
function unwrapPretty(code) {
  const sf = ts.createSourceFile('x.mjs', code, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
  /** @type {[number, number][]} */
  const lit = []
  const visit = (/** @type {ts.Node} */ n) => {
    if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n) || ts.isTemplateHead(n) || ts.isTemplateMiddle(n) || ts.isTemplateTail(n)) lit.push([n.getStart(sf), n.end])
    n.getChildren(sf).forEach(visit)
  }
  visit(sf)
  const inside = (/** @type {number} */ p) => lit.some(([a, b]) => p > a && p < b)
  const lines = code.split('\n')
  if (!lines[0].startsWith('async function __wf() {')) throw new Error('unexpected pretty wrapper: ' + lines[0])
  let off = 0
  const out = []
  for (const l of lines) {
    out.push(!inside(off) && l.startsWith('  ') ? l.slice(2) : l)
    off += l.length + 1
  }
  // first line is the wrapper head; the closing `}` is the last non-empty line
  out.shift()
  while (out.length && out[out.length - 1] === '') out.pop()
  if (out.pop() !== '}') throw new Error('unexpected pretty wrapper tail')
  return out.join('\n') + '\n'
}
