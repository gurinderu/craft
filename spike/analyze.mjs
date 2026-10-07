// Spike (realm @nick/craft, #208): where the bytes are in each engine, by TypeScript's AST (leaf tokens
// partition the file: each token's leading trivia holds its comments and whitespace).
import ts from 'typescript'

const HEAD = 'async function __wf(){\n'
const B = (/** @type {string} */ s) => Buffer.byteLength(s, 'utf8')

/** Parse an engine in the sandbox wrapper; offsets are shifted back to the engine's own text. @param {string} src */
export function parseEngine(src) {
  const text = HEAD + src.replace(/^export const meta/m, '       const meta') + '\n}\n'
  const sf = ts.createSourceFile('e.mjs', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
  return { sf, text, shift: HEAD.length, diagnostics: /** @type {any} */ (sf).parseDiagnostics }
}

/** @param {ts.SourceFile} sf @returns {ts.Node[]} */
function leaves(sf) {
  const out = []
  const visit = (/** @type {ts.Node} */ n) => {
    // getChildren hands JSDoc nodes in as children; they live inside comment trivia, counted there
    if (n.kind >= ts.SyntaxKind.FirstJSDocNode && n.kind <= ts.SyntaxKind.LastJSDocNode) return
    const kids = n.getChildren(sf)
    if (!kids.length) out.push(n); else kids.forEach(visit)
  }
  visit(sf)
  return out
}

const STRINGISH = new Set([ts.SyntaxKind.StringLiteral, ts.SyntaxKind.NoSubstitutionTemplateLiteral,
  ts.SyntaxKind.TemplateHead, ts.SyntaxKind.TemplateMiddle, ts.SyntaxKind.TemplateTail])

/** @param {string} src */
export function breakdown(src) {
  const { sf, text, shift } = parseEngine(src)
  const inEngine = (/** @type {number} */ a, /** @type {number} */ b) => [Math.max(a, shift), Math.min(b, shift + src.length)]
  const r = { total: B(src), wholeLineComment: 0, trailingComment: 0, jsdoc: 0, blockComment: 0, whitespace: 0, strings: 0, templates: 0, code: 0 }
  /** @type {{ pos: number, end: number, kind: string }[]} */
  const comments = []
  for (const t of leaves(sf)) {
    const start = t.getStart(sf)
    let cursor = t.pos
    // same-line comments after the previous token are "trailing" to TS; the rest of the trivia is "leading"
    const ranges = [...(ts.getTrailingCommentRanges(text, t.pos) ?? []), ...(ts.getLeadingCommentRanges(text, t.pos) ?? [])]
    for (const c of ranges) {
      const [a, b] = inEngine(c.pos, c.end)
      const s = text.slice(a, b)
      let kind
      if (c.kind === ts.SyntaxKind.MultiLineCommentTrivia) kind = s.startsWith('/**') ? 'jsdoc' : 'blockComment'
      else kind = /(^|\n)[ \t]*$/.test(text.slice(0, c.pos)) ? 'wholeLineComment' : 'trailingComment'
      r[kind] += B(s)
      comments.push({ pos: a - shift, end: b - shift, kind })
      const [wa, wb] = inEngine(cursor, c.pos); if (wb > wa) r.whitespace += B(text.slice(wa, wb))
      cursor = c.end
    }
    const [wa, wb] = inEngine(cursor, start); if (wb > wa) r.whitespace += B(text.slice(wa, wb))
    const [ta, tb] = inEngine(start, t.end)
    if (tb <= ta) continue
    const tok = B(text.slice(ta, tb))
    if (t.kind === ts.SyntaxKind.StringLiteral) r.strings += tok
    else if (STRINGISH.has(t.kind)) r.templates += tok
    else r.code += tok
  }
  r.accounted = r.wholeLineComment + r.trailingComment + r.jsdoc + r.blockComment + r.whitespace + r.strings + r.templates + r.code
  return { r, comments }
}

/** The engine with every comment removed; a line that held only a comment goes with it. @param {string} src */
export function stripComments(src) {
  const { comments } = breakdown(src)
  let out = ''
  let at = 0
  for (const c of comments) {
    let a = c.pos, b = c.end
    if (c.kind === 'wholeLineComment' || c.kind === 'jsdoc' || c.kind === 'blockComment') {
      const ls = src.lastIndexOf('\n', a - 1) + 1
      const le = src.indexOf('\n', b)
      if (/^[ \t]*$/.test(src.slice(ls, a)) && /^[ \t]*$/.test(src.slice(b, le < 0 ? src.length : le))) { a = ls; b = le < 0 ? src.length : le + 1 }
    } else {
      while (a > 0 && (src[a - 1] === ' ' || src[a - 1] === '\t')) a--
    }
    if (a < at) a = at
    out += src.slice(at, a)
    at = b
  }
  return out + src.slice(at)
}

/** Every string and template piece by cooked value, and each template's sequence of cooked parts. @param {string} src */
export function literals(src) {
  const { sf } = parseEngine(src)
  /** @type {string[]} */ const flat = []
  /** @type {string[]} */ const templates = []
  const visit = (/** @type {ts.Node} */ n) => {
    if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) flat.push(n.text)
    else if (ts.isTemplateExpression(n)) templates.push(JSON.stringify([n.head.text, ...n.templateSpans.map(s => s.literal.text)]))
    ts.forEachChild(n, visit)
  }
  visit(sf)
  return { flat, templates }
}
