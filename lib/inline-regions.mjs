// Workflow scripts run in a sandbox with no filesystem and no `import`, so the shared helpers in
// lib/run-record.mjs are pasted into them verbatim. The pasting is forced; the drift is not. This
// module makes each pasted block a DERIVED region: the workflow marks it with fences naming its
// source, and the checker regenerates the region from lib/ and compares.
//
// Fence syntax (the workflow file owns these two lines; everything between them is generated):
//
//   // >>> craft-inline lib/run-record.mjs countBySeverity summarizeFindings
//   ...generated...
//   // <<< craft-inline
//
// WHAT THE GATE COMPARES: the bytes strictly between the fences, against the concatenation of the
// named declarations extracted from the source file — the JSDoc blocks stacked directly above a
// declaration and the `//` comment block above them included, the `export ` keyword stripped, entries separated by one blank line. Nothing else is compared: the
// fence lines themselves, the order the names are listed in, and every line outside a fence are
// free. THEREFORE: a workflow-local comment or helper may NOT live inside a region (it would read
// as drift) — put it above or below the fence. Comments in lib/ that precede a mirrored
// declaration are part of the region and travel with it.
//
// Extraction is deliberately NOT brace-counting (braces inside strings/regexes/comments make that
// unsound). A declaration ends at the first line at column 0 that is nothing but its closers (`}`
// for a function or object, `])` for a Set/array table) — a rule that is exact for the top-level
// style of the lib/ modules mirrored here, and that we verify: every extracted region is
// compile-checked with `new Function` before it is compared or written.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * @typedef {{ source: string, names: string[], open: number, close: number, actual: string }} Region
 * @typedef {{ file: string, source: string, names: string[], line: number, diff: string }} Mismatch
 */

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export const FENCE_OPEN = /^\/\/ >>> craft-inline (\S+)((?: +\S+)+)\s*$/
export const FENCE_CLOSE = /^\/\/ <<< craft-inline\s*$/

// `name` as a pattern matching that whole identifier: its regex characters escaped (a `$` is one),
// bounded by lookarounds on identifier characters — `\b` does not hold beside a `$`.
/** @param {string} name @returns {string} */
function identifier(name) {
  return `(?<![\\w$])${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w$])`
}

// Source text of one exported top-level declaration, with the JSDoc blocks stacked directly above
// it and any contiguous `//` comment block above those, and the `export ` keyword stripped.
/**
 * @param {string} source
 * @param {string} name
 * @returns {string}
 */
export function extractDeclaration(source, name) {
  const lines = source.split('\n')
  // `name` is a declaration name from a `craft-inline` fence in this repo's own workflows/, not
  // outside input; the pattern is anchored and has no nested quantifier to backtrack on.
  // nosemgrep: javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp
  const head = lines.findIndex(l => new RegExp(`^export (?:async function|function|const|let) ${identifier(name)}`).test(l))
  if (head === -1) throw new Error(`no exported declaration named '${name}'`)
  const start = commentStart(lines, head)
  const end = declarationEnd(lines, head, name)
  return lines.slice(start, end + 1).join('\n').replace(/^export /m, '')
}

/**
 * The first line of the comments that travel with the declaration at `head`.
 * @param {string[]} lines @param {number} head @returns {number}
 */
function commentStart(lines, head) {
  let start = head
  // Every JSDoc block stacked directly above the declaration travels with it, and the `//` block
  // above them still does: stopping at a JSDoc cut what sat above it off every engine's copy, silently.
  for (let open = jsdocAbove(lines, start); open !== -1; open = jsdocAbove(lines, start)) start = open
  while (start > 0 && /^\/\//.test(/** @type {string} */ (lines[start - 1]))) start--
  return start
}

/**
 * The first line of the JSDoc block that ends right above line `start`, or -1 when none does.
 * @param {string[]} lines @param {number} start @returns {number}
 */
function jsdocAbove(lines, start) {
  /** @param {number} i  an index the surrounding bounds checks keep inside `lines` */
  const at = i => /** @type {string} */ (lines[i])
  if (start > 0 && /^\/\*\*.*\*\/\s*$/.test(at(start - 1))) return start - 1
  // A multi-line block: its last line closes with `*/` (alone, or after a tag), its middle lines
  // start with ` *`, its first line opens with `/**`.
  if (!(start > 0 && /^ \*(?:.*\*)?\/\s*$/.test(at(start - 1)))) return -1
  let open = start - 1
  while (open > 0 && /^ \*/.test(at(open))) open--
  return /^\/\*\*/.test(at(open)) ? open : -1
}

/**
 * The last line of the declaration at `head`.
 * @param {string[]} lines @param {number} head @param {string} name @returns {number}
 */
function declarationEnd(lines, head, name) {
  const first = /** @type {string} */ (lines[head])
  if (/^export (?:async function|function) /.test(first)) return functionEnd(lines, head, name)
  return balanced(first) ? head : constEnd(lines, head, name)
}

/**
 * The last line of the function declared at `head`.
 * @param {string[]} lines @param {number} head @param {string} name @returns {number}
 */
function functionEnd(lines, head, name) {
  const first = /** @type {string} */ (lines[head])
  // A one-line function (`function f(x) { return … }`) closes on its own line and has no `}` at
  // column 0 to find; scanning for one ran to EOF and reported it as unterminated.
  // A comment after its closing `}` (one holding no `}` itself) is not part of it, and its brackets
  // are not counted: such a function too ends on its line, rather than at the next one's `}`.
  const code = /^(.*\})\s*(?:\/\/[^}]*|\/\*[^}]*\*\/)?\s*$/.exec(first)?.[1]
  if (code !== undefined && balanced(code)) return head
  let end = head
  while (end < lines.length && lines[end] !== '}') end++
  if (end === lines.length) throw new Error(`unterminated function '${name}' (no '}' at column 0)`)
  return end
}

/**
 * The last line of the multi-line const declared at `head`.
 * @param {string[]} lines @param {number} head @param {string} name @returns {number}
 */
function constEnd(lines, head, name) {
  // A multi-line const (a table, a Set of names) ends the same way a function does: at the first
  // line whose CLOSERS sit at column 0 — `}`, `])`, `]` — with nothing else on it. Same rule, same
  // reason it is sound: nothing at column 0 inside a top-level declaration's body. The slice is
  // then required to be bracket-balanced, and (like every region) compile-checked before use.
  let end = head
  while (end < lines.length && !/^[)\]}]+[;,]?$/.test(/** @type {string} */ (lines[end]))) end++
  if (end === lines.length) throw new Error(`unterminated const '${name}' (no closer at column 0)`)
  if (!balanced(lines.slice(head, end + 1).join('\n'))) {
    throw new Error(`multi-line const '${name}' is not extractable — brackets do not balance at its closer`)
  }
  return end
}

// Whether a const's brackets close within the text given. Used only to DECIDE whether a const is
// single-line and to sanity-check a multi-line slice the closer rule already delimited — never to
// find the end of a declaration, so it is not the brace-counting slicer this module exists to
// avoid. It counts brackets inside strings and comments too, which is why it stays a check and not
// a slicer.
/**
 * @param {string} line
 * @returns {boolean}
 */
function balanced(line) {
  let depth = 0
  for (const ch of line) {
    if (ch === '{' || ch === '[' || ch === '(') depth++
    else if (ch === '}' || ch === ']' || ch === ')') depth--
  }
  return depth === 0
}

/**
 * @param {string} sourceText
 * @param {string[]} names
 * @returns {string}
 */
export function renderRegion(sourceText, names) {
  const body = names.map(n => extractDeclaration(sourceText, n)).join('\n\n')
  // Guard: the generated region must itself be valid JS. If lib/ ever grows a shape the extractor
  // slices wrong, this fails here rather than shipping a broken workflow script.
  new Function(`async function __region(){\n${body}\n}`)
  return body
}

// Every fenced region in a workflow file: its source file, names, current bytes and line span.
/**
 * @param {string} text
 * @returns {Region[]}
 */
export function findRegions(text) {
  const lines = text.split('\n')
  /** @param {number} i  an index the surrounding loop bounds keep inside `lines` */
  const at = i => /** @type {string} */ (lines[i])
  /** @type {Region[]} */
  const regions = []
  for (let i = 0; i < lines.length; i++) {
    const m = FENCE_OPEN.exec(at(i))
    if (!m) continue
    let close = i + 1
    while (close < lines.length && !FENCE_CLOSE.test(at(close))) {
      if (FENCE_OPEN.test(at(close))) throw new Error(`nested craft-inline fence at line ${close + 1}`)
      close++
    }
    if (close === lines.length) throw new Error(`unclosed craft-inline fence opened at line ${i + 1}`)
    regions.push({
      source: /** @type {string} */ (m[1]),
      names: /** @type {string} */ (m[2]).trim().split(/\s+/),
      open: i,
      close,
      actual: lines.slice(i + 1, close).join('\n'),
    })
    i = close
  }
  return regions
}

const sourceCache = new Map()
/**
 * @param {string} rel
 * @returns {string}
 */
function readSource(rel) {
  if (!sourceCache.has(rel)) sourceCache.set(rel, fs.readFileSync(path.join(ROOT, rel), 'utf8'))
  return sourceCache.get(rel)
}

// Check one workflow file. Returns { regions, mismatches:[{file,names,diff}], fixed:string|null }.
/**
 * @param {string} file
 * @param {{ fix?: boolean }} [opts]
 * @returns {{ regions: Region[], mismatches: Mismatch[], fixed: string | null }}
 */
export function checkFile(file, { fix = false } = {}) {
  const abs = path.isAbsolute(file) ? file : path.join(ROOT, file)
  const text = fs.readFileSync(abs, 'utf8')
  const regions = findRegions(text)
  /** @type {Mismatch[]} */
  const mismatches = []
  // Rebuild the file in one pass, splicing each region's regenerated body between its fences.
  const lines = text.split('\n')
  /** @type {string[]} */
  const out = []
  let cursor = 0
  for (const r of regions) {
    const expected = renderRegion(readSource(r.source), r.names)
    if (expected !== r.actual) {
      mismatches.push({ file, source: r.source, names: r.names, line: r.open + 1, diff: lineDiff(expected, r.actual) })
    }
    out.push(...lines.slice(cursor, r.open + 1), ...expected.split('\n'))
    cursor = r.close
  }
  out.push(...lines.slice(cursor))
  return { regions, mismatches, fixed: fix && mismatches.length ? out.join('\n') : null }
}

// A region can be byte-identical to its source and still be broken: the source's helper calls a
// SIBLING export that the fence header does not name, so the workflow ends up calling a function it
// never defines. The gate saw nothing — it compares only the declarations it was told to name — and
// the script still parses, because a free identifier is a runtime error in JavaScript, not a syntax
// one. It fails at the first call, after the whole agent spend and before the record is written.
//
// Scoped deliberately to the region's OWN module: a name the source exports, the region calls, and
// the fence does not carry. Free identifiers in general cannot be judged here (the workflow runs
// with harness-injected globals — agent, parallel, log, budget — that are declared nowhere), and a
// check that guesses at those would cry wolf until nobody read it.
/**
 * @param {string} text
 * @param {Region[]} regions
 * @param {(rel: string) => string} [readSourceText]
 * @returns {{ name: string, source: string, line: number }[]}
 */
export function unresolvedSiblings(text, regions, readSourceText = readSource) {
  const out = []
  for (const r of regions) {
    let sourceText
    try {
      sourceText = readSourceText(r.source)
    } catch {
      continue   // a missing source is already the mismatch check's finding, not ours
    }
    for (const name of exportedNames(sourceText)) {
      if (!r.names.includes(name) && callsUndeclared(r.actual, name, text)) out.push({ name, source: r.source, line: r.open + 1 })
    }
  }
  return out
}

/**
 * The names a lib module exports, in source order.
 * @param {string} sourceText @returns {Set<string>}
 */
function exportedNames(sourceText) {
  /** @type {Set<string>} */
  const exported = new Set()
  for (const m of sourceText.matchAll(/(?:^|\n)export\s+(?:async\s+)?(?:function\s+([A-Za-z_$][\w$]*)|(?:const|let|var)\s+([A-Za-z_$][\w$]*))/g)) {
    exported.add(/** @type {string} */ (m[1] || m[2]))
  }
  return exported
}

/**
 * Whether the region's code calls `name` and the workflow declares it nowhere.
 * @param {string} actual  the region's text @param {string} name @param {string} text  the workflow
 */
function callsUndeclared(actual, name, text) {
  // Comments are prose: a name mentioned in a `// noLanguageMessage(0, 0) produced …` note is not
  // a call. Strip line and block comments before asking whether the region calls it.
  const code = actual.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|\n)\s*\/\/[^\n]*/g, '$1')
  // `name` is an identifier exported by one of this repo's own lib/ modules, not outside input; both
  // patterns have fixed lookarounds and no nested quantifier to backtrack on.
  // nosemgrep: javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp
  if (!new RegExp(`(?<!\\.)${identifier(name)}\\s*\\(`).test(code)) return false
  // nosemgrep: javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp
  return !new RegExp(`(?:function|const|let|var)\\s+${identifier(name)}`).test(text)   // declared elsewhere in the workflow
}

// Minimal unified-ish line diff: enough to point at the drifted lines without a dependency.
/**
 * @param {string} expected
 * @param {string} actual
 * @returns {string}
 */
export function lineDiff(expected, actual) {
  const e = expected.split('\n')
  const a = actual.split('\n')
  const out = []
  for (let i = 0; i < Math.max(e.length, a.length); i++) {
    if (e[i] === a[i]) continue
    if (a[i] !== undefined) out.push(`    - ${a[i]}`)
    if (e[i] !== undefined) out.push(`    + ${e[i]}`)
  }
  return out.join('\n')
}

// Check every workflow script. Returns { files, regionCount, mismatches }.
export function checkAll({ dir = path.join(ROOT, 'workflows'), fix = false } = {}) {
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.js')).sort()
  let regionCount = 0
  const mismatches = []
  for (const f of files) {
    const res = checkFile(path.join(dir, f), { fix })
    regionCount += res.regions.length
    for (const m of res.mismatches) mismatches.push({ ...m, file: f })
    if (res.fixed !== null) fs.writeFileSync(path.join(dir, f), res.fixed)
  }
  return { files, regionCount, mismatches }
}

// The strictness flags lib/tsconfig.json must keep on, beyond `strict` itself.
export const STRICT_FLAGS = /** @type {const} */ (['noUncheckedIndexedAccess', 'exactOptionalPropertyTypes',
  'noImplicitReturns', 'noFallthroughCasesInSwitch', 'noImplicitOverride', 'noPropertyAccessFromIndexSignature',
  'noUnusedLocals', 'noUnusedParameters', 'noUncheckedSideEffectImports', 'verbatimModuleSyntax'])

// The `allow*` flags lib/tsconfig.json must keep explicitly false: left unset, tsc only suggests, never errors.
export const STRICT_OFF_FLAGS = /** @type {const} */ (['allowUnreachableCode', 'allowUnusedLabels'])

// The family `strict` turns on — every option tsc declares with `strictFlag` (a test pins this list
// to the installed tsc). An explicit `false` on one overrides `strict`, and --showConfig reports it.
export const STRICT_FAMILY_FLAGS = /** @type {const} */ (['noImplicitAny', 'strictNullChecks', 'strictFunctionTypes',
  'strictBindCallApply', 'strictPropertyInitialization', 'strictBuiltinIteratorReturn', 'noImplicitThis',
  'useUnknownInCatchVariables', 'alwaysStrict'])

// Every way a tsconfig's compilerOptions fall short of the maximum strictness: a flag not on, an
// `allow*` not explicitly false, a strict-family flag switched off. Shared by the inline gate (on
// lib/tsconfig.json as --showConfig resolves it) and the parity test (on both configs as written).
/**
 * @param {string} label  the config named in each problem
 * @param {Record<string, unknown>} opts
 * @returns {string[]}
 */
export function strictnessProblems(label, opts) {
  const problems = []
  for (const flag of ['allowJs', 'checkJs', 'strict', ...STRICT_FLAGS]) {
    if (opts[flag] !== true) problems.push(`${label}: ${flag} is not on`)
  }
  for (const flag of STRICT_OFF_FLAGS) {
    if (opts[flag] !== false) problems.push(`${label}: ${flag} is not false`)
  }
  for (const flag of STRICT_FAMILY_FLAGS) {
    if (opts[flag] === false) problems.push(`${label}: ${flag} is turned off`)
  }
  return problems
}

// Inlined code ships into every consumer's review, so it must be code the strict type check actually
// reads, at full strictness, with nothing switched off. The answer comes from tsc itself — the files it
// lists and the config it resolves — rather than a copy of its include/exclude rules, which drift.
/**
 * @param {{ root: string, sources: string[], typedFiles: string[], config: { compilerOptions?: Record<string, unknown> },
 *   readSource: (source: string) => string }} input  `typedFiles`: `tsc --listFilesOnly`; `config`: `tsc --showConfig`
 * @returns {string[]} one line per problem; empty when every inlined source is strictly type-checked
 */
export function typedScopeProblems({ root, sources, typedFiles, config, readSource }) {
  const problems = strictnessProblems('lib/tsconfig.json', config.compilerOptions || {})
  const typed = new Set(typedFiles.map(f => path.resolve(f)))
  for (const s of [...new Set(sources)].sort()) {
    // tsc also reads the tests and the OpenCode run-record they import; neither is code an engine
    // may carry, whatever tsc's list says.
    if (!/^lib\/(?:[^/.][^/]*\/)*[^/.][^/]*\.mjs$/.test(s) || /\.test\.mjs$/.test(s) || s.split('/').includes('..')) {
      problems.push(`${s} is inlined into workflows/ but is not a non-test lib module`)
      continue
    }
    if (!typed.has(path.resolve(root, s))) {
      problems.push(`${s} is inlined into workflows/ but not read by the strict type check (tsc -p lib/tsconfig.json)`)
      continue
    }
    const m = /@ts-(?:nocheck|ignore|expect-error)\b/.exec(readSource(s))
    if (m) problems.push(`${s} is inlined into workflows/ but switches the type check off with ${m[0]}`)
  }
  return problems
}
