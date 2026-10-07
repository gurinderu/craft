// What an inlined region carries of its lib/ declarations: the code and JSDoc, without the whole-line `//`
// comments, so the engines stay under the harness's registration limit (lib/check-workflow-size.mjs).
// The drop is a line rule, blind to strings; the compiler judges it — `strippedProgram` refuses a region
// whose stripped text parses to another program than its source does (realm @nick/craft, node #199).

/** @typedef {typeof import('../opencode/plugin/node_modules/typescript/lib/typescript.js')} TypeScript */

// A line that is nothing but a `//` comment, unless it is a directive a tool reads in the engine: a
// `// @ts-…` (the engines' strict type check), an `// eslint-…` (their lint), a `// nosemgrep` (semgrep
// scans workflows/). A JSDoc block is not one: the engines' type check reads its types.
const LINE_COMMENT = /^\s*\/\/(?!\s*(?:@ts-|eslint-|nosemgrep))/
const BLANK = /^\s*$/

/**
 * Whether a block comment is still open after `line`, given whether one was open before it. Only a block that
 * opens its line with `/**`, or `/*` and a space, counts — a JSDoc block, as lib/ writes them: a `/*` elsewhere
 * may sit in a string (a shell `case` pattern such as `/*)` in a template literal), and reading it as an
 * opener would keep every `//` line after it. A block opened otherwise and left open is missed; dropping a
 * `//` line inside it loses comment text, never code.
 * @param {string} line @param {boolean} inBlock @returns {boolean}
 */
function blockOpenAfter(line, inBlock) {
  if (!inBlock && !/^\s*\/\*(?:\*|\s|$)/.test(line)) return false
  return !line.includes('*/', inBlock ? 0 : line.indexOf('/*') + 2)
}

/**
 * A declaration as the engines carry it: every whole-line `//` comment but a directive dropped — not a line
 * inside a block comment, which is the block's text — then each blank line that would lead the text or
 * follow another blank one: the blank lines that only separated the dropped comments. A comment after code
 * on its line stays.
 * @param {string} text @returns {string}
 */
export function withoutLineComments(text) {
  /** @type {string[]} */
  const out = []
  let inBlock = false
  for (const line of text.split('\n')) {
    if (!inBlock && LINE_COMMENT.test(line)) continue
    inBlock = blockOpenAfter(line, inBlock)
    if (BLANK.test(line) && (out.length === 0 || BLANK.test(/** @type {string} */ (out.at(-1))))) continue
    out.push(line)
  }
  return out.join('\n')
}

/** `text` as tsc parses it, printed without comments. @param {TypeScript} ts @param {string} text */
function printed(ts, text) {
  const sf = ts.createSourceFile('region.js', text, ts.ScriptTarget.Latest, false, ts.ScriptKind.JS)
  return ts.createPrinter({ removeComments: true }).printFile(sf)
}

/**
 * The declarations joined as a region carries them, stripped of their line comments — or an error, when tsc
 * parses the stripped text to another program than the whole one: a dropped `//` line was text inside a
 * string or template literal, not a comment.
 * @param {TypeScript} ts @param {string[]} declarations @param {string} label  names the region in the error
 * @returns {string}
 */
export function strippedProgram(ts, declarations, label) {
  const body = declarations.map(withoutLineComments).join('\n\n')
  if (printed(ts, body) !== printed(ts, declarations.join('\n\n'))) {
    throw new Error(`${label}: dropping its whole-line \`//\` comments changes the program — a \`//\` line sits inside a string or template literal; move it off the line start`)
  }
  return body
}
