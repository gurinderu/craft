// The pure half of the units CLI (lib/craft-units.mjs; realm @nick/craft, #377 under #375): the prose unit
// probe of lib/rust-units.mjs ported step for step — the tracked `Cargo.toml` list as `while read -r` reads
// it, the `[package]` test, dirname, the awk that reads a manifest's name and dependencies, `wc -l` — so the
// CLI's answer is the prose probe's by construction (#355, #362), and no cargo is needed. Nothing is spawned here.

// awk's [[:space:]], spelled out: JS `\s` is wider (Unicode spaces).
const SP = '[ \\t\\n\\v\\f\\r]'
// awk's `.` matches every character of a record, \r included; the JS regexes below that use `.` carry the `s` flag.
const SECTION = new RegExp(`^${SP}*[[]`)
const ALL_SP = new RegExp(SP, 'g')
const LEAD_SP = new RegExp(`^${SP}*`)
const NAME_KEY = new RegExp(`^${SP}*name${SP}*=`)
const PACKAGE_KEY = new RegExp(`^${SP}*package${SP}*=`)
const DEP_KEY = new RegExp(`^${SP}*[A-Za-z0-9_-]`)
const RENAME = new RegExp(`package${SP}*=${SP}*"`)
const RENAME_HEAD = new RegExp(`^.*package${SP}*=${SP}*"`, 's')

/** awk's sub(/^[^"]*"/,"",v); sub(/".*$/,"",v): the first quoted string's text, the line itself when unquoted. @param {string} line */
function quoted(line) {
  return line.replace(/^[^"]*"/, '').replace(/".*$/s, '')
}

/** The lines of a text as awk and `read` see them: the empty one after a final newline is not a line. @param {string} text */
function records(text) {
  const lines = String(text).split('\n')
  if (lines[lines.length - 1] === '') lines.pop()
  return lines
}

/**
 * One section header line, as the awk's first rule reads it: the new section, and the dependency key a
 * `[...dependencies.<name>]` table opens ('' for any other).
 * @param {string} line @returns {{ sec: string, dk: string }}
 */
function sectionOf(line) {
  const h = line.replace(ALL_SP, '')
  if (/^[[]workspace/.test(h)) return { sec: 'ws', dk: '' }
  if (!/dependencies[.]/.test(h)) return { sec: h, dk: '' }
  return { sec: 'dep-table', dk: h.replace(/^.*dependencies[.]/s, '').replace(/[\]].*$/s, '') }
}

/** The dependency a key line of a `...dependencies]` section names: its key, or the `package = "..."` it renames. @param {string} line */
function depOf(line) {
  const k = line.replace(LEAD_SP, '').replace(/[^A-Za-z0-9_-].*$/s, '')
  return { k, p: RENAME.test(line) ? line.replace(RENAME_HEAD, '').replace(/".*$/s, '') : k }
}

/**
 * The prose probe's awk over one manifest (PACKAGE_AWK in lib/rust-units.mjs), rule for rule:
 * `@@ <dir> <code> <sig> <[package] name> <dependency>...` — a `[dependencies.<name>]` table, a key in any
 * section ending `dependencies]` (a `package = "..."` rename wins), never `[workspace.*]`. awk prints the
 * dependencies in its own hash order; this prints the same values in first-key order.
 * @param {string} dir @param {number} code @param {number} sig @param {string} manifest
 */
export function manifestLine(dir, code, sig, manifest) {
  let sec = ''
  let dk = ''
  let name = ''
  /** @type {Map<string, string>} */
  const dep = new Map()
  for (const line of records(manifest)) {
    if (SECTION.test(line)) {
      ({ sec, dk } = sectionOf(line))
      if (sec === 'dep-table') dep.set(dk, dk)
    } else if (sec === '[package]' && NAME_KEY.test(line)) name = quoted(line)
    else if (sec === 'dep-table' && PACKAGE_KEY.test(line)) dep.set(dk, quoted(line))
    else if (/dependencies[\]]$/.test(sec) && DEP_KEY.test(line)) {
      const { k, p } = depOf(line)
      dep.set(k, p)
    }
  }
  return [`@@ ${dir} ${code} ${sig} ${name}`, ...dep.values()].join(' ')
}

/** Whether a manifest has a line starting `[package]` (`grep -q '^\[package\]'`). @param {string} text */
export function hasPackageSection(text) {
  return String(text).split('\n').some(l => l.startsWith('[package]'))
}

/** The paths `while read -r f` takes from `git ls-files` output: each line, its leading and trailing blanks cut. @param {string} text */
export function readLines(text) {
  return records(text).map(l => l.replace(/^[ \t\n]+|[ \t\n]+$/g, '')).filter(Boolean)
}

/** POSIX dirname: '.' for a bare name. @param {string} p */
export function dirnameOf(p) {
  const trimmed = p.replace(/\/+$/, '')
  if (!trimmed) return p ? '/' : '.'
  const at = trimmed.lastIndexOf('/')
  if (at === -1) return '.'
  return trimmed.slice(0, at).replace(/\/+$/, '') || '/'
}

/** The `.rs` paths of `git ls-files` output (`grep '[.]rs$'`). @param {string} text */
export function rsPaths(text) {
  return records(text).filter(l => /[.]rs$/.test(l))
}

/** The lines `wc -l` counts: newline characters. @param {string} text */
export function countLines(text) {
  let n = 0
  for (let i = text.indexOf('\n'); i !== -1; i = text.indexOf('\n', i + 1)) n++
  return n
}

/**
 * The probe's answer: every package line, its directory as a root (the line's second field, as the prose
 * prompt asked), and the diff's numstat lines verbatim (a binary file is `-\t-\t<path>`).
 * @param {Array<{ dir: string, line: string }>} packages @param {string} numstat
 * @returns {import('./review-unit-schemas.mjs').UnitsAnswer}
 */
export function unitsAnswer(packages, numstat) {
  return { roots: packages.map(p => p.dir), packages: packages.map(p => p.line), numstat: records(numstat) }
}
