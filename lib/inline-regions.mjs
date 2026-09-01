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
// named declarations extracted from the source file — leading `//` comment block included, the
// `export ` keyword stripped, entries separated by one blank line. Nothing else is compared: the
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

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export const FENCE_OPEN = /^\/\/ >>> craft-inline (\S+)((?: +\S+)+)\s*$/
export const FENCE_CLOSE = /^\/\/ <<< craft-inline\s*$/

// Source text of one exported top-level declaration, with any contiguous `//` comment block that
// precedes it, and the `export ` keyword stripped.
export function extractDeclaration(source, name) {
  const lines = source.split('\n')
  const head = lines.findIndex(l => new RegExp(`^export (?:async function|function|const|let) ${name}\\b`).test(l))
  if (head === -1) throw new Error(`no exported declaration named '${name}'`)

  let start = head
  while (start > 0 && /^\/\//.test(lines[start - 1])) start--

  let end = head
  if (/^export (?:async function|function) /.test(lines[head])) {
    // A one-line function (`function f(x) { return … }`) closes on its own line and has no `}` at
    // column 0 to find; scanning for one ran to EOF and reported it as unterminated.
    if (balanced(lines[head]) && /\}\s*$/.test(lines[head])) return lines.slice(start, head + 1).join('\n').replace(/^export /m, '')
    while (end < lines.length && lines[end] !== '}') end++
    if (end === lines.length) throw new Error(`unterminated function '${name}' (no '}' at column 0)`)
  } else if (!balanced(lines[head])) {
    // A multi-line const (a table, a Set of names) ends the same way a function does: at the first
    // line whose CLOSERS sit at column 0 — `}`, `])`, `]` — with nothing else on it. Same rule, same
    // reason it is sound: nothing at column 0 inside a top-level declaration's body. The slice is
    // then required to be bracket-balanced, and (like every region) compile-checked before use.
    while (end < lines.length && !/^[)\]}]+[;,]?$/.test(lines[end])) end++
    if (end === lines.length) throw new Error(`unterminated const '${name}' (no closer at column 0)`)
    if (!balanced(lines.slice(head, end + 1).join('\n'))) {
      throw new Error(`multi-line const '${name}' is not extractable — brackets do not balance at its closer`)
    }
  }

  return lines.slice(start, end + 1).join('\n').replace(/^export /m, '')
}

// Whether a const's brackets close within the text given. Used only to DECIDE whether a const is
// single-line and to sanity-check a multi-line slice the closer rule already delimited — never to
// find the end of a declaration, so it is not the brace-counting slicer this module exists to
// avoid. It counts brackets inside strings and comments too, which is why it stays a check and not
// a slicer.
function balanced(line) {
  let depth = 0
  for (const ch of line) {
    if (ch === '{' || ch === '[' || ch === '(') depth++
    else if (ch === '}' || ch === ']' || ch === ')') depth--
  }
  return depth === 0
}

export function renderRegion(sourceText, names) {
  const body = names.map(n => extractDeclaration(sourceText, n)).join('\n\n')
  // Guard: the generated region must itself be valid JS. If lib/ ever grows a shape the extractor
  // slices wrong, this fails here rather than shipping a broken workflow script.
  new Function(`async function __region(){\n${body}\n}`)
  return body
}

// Every fenced region in a workflow file: its source file, names, current bytes and line span.
export function findRegions(text) {
  const lines = text.split('\n')
  const regions = []
  for (let i = 0; i < lines.length; i++) {
    const m = FENCE_OPEN.exec(lines[i])
    if (!m) continue
    let close = i + 1
    while (close < lines.length && !FENCE_CLOSE.test(lines[close])) {
      if (FENCE_OPEN.test(lines[close])) throw new Error(`nested craft-inline fence at line ${close + 1}`)
      close++
    }
    if (close === lines.length) throw new Error(`unclosed craft-inline fence opened at line ${i + 1}`)
    regions.push({
      source: m[1],
      names: m[2].trim().split(/\s+/),
      open: i,
      close,
      actual: lines.slice(i + 1, close).join('\n'),
    })
    i = close
  }
  return regions
}

const sourceCache = new Map()
function readSource(rel) {
  if (!sourceCache.has(rel)) sourceCache.set(rel, fs.readFileSync(path.join(ROOT, rel), 'utf8'))
  return sourceCache.get(rel)
}

// Check one workflow file. Returns { regions, mismatches:[{file,names,diff}], fixed:string|null }.
export function checkFile(file, { fix = false } = {}) {
  const abs = path.isAbsolute(file) ? file : path.join(ROOT, file)
  const text = fs.readFileSync(abs, 'utf8')
  const regions = findRegions(text)
  const mismatches = []
  // Rebuild the file in one pass, splicing each region's regenerated body between its fences.
  const lines = text.split('\n')
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

// Minimal unified-ish line diff: enough to point at the drifted lines without a dependency.
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
