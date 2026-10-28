// The pure half of the units CLI (lib/craft-units.mjs; realm @nick/craft, #377 under #375): what `cargo
// metadata`, `git ls-files`, `git grep -c` and `git diff --numstat` print, reshaped into the unit probe's
// answer (UNITS_SCHEMA, lib/review-unit-schemas.mjs) — one `@@ <dir> <.rs lines> <pub lines> <name> <deps>...`
// line per Cargo package, as lib/unit-graph.mjs parses it (#355, #362). Deterministic work an agent used to
// do by reading command output; no process is spawned here.

/** @typedef {{ dir: string, name: string, deps: string[] }} CargoPackage  a package, its directory relative to the repository root */

/** A path with `/` separators and no `.` or empty segments; '.' for the root. @param {string} p */
function normalDir(p) {
  const segs = String(p).split(/[\\/]+/).filter(s => s && s !== '.')
  return segs.length ? segs.join('/') : '.'
}

/**
 * The packages of `cargo metadata --format-version 1` output, each with its directory relative to the
 * repository root `toplevel` (absolute) and the package names it depends on — a renamed dependency by its
 * package name, every kind (normal, dev, build) — sorted by directory. A manifest outside `toplevel` is not
 * the repository's and is dropped.
 * @param {unknown} metadata  the parsed JSON @param {string} toplevel
 * @returns {CargoPackage[]}
 */
export function cargoPackages(metadata, toplevel) {
  const pkgs = /** @type {{ packages?: unknown }} */ (metadata ?? {}).packages
  const top = normalDir(toplevel)
  return (Array.isArray(pkgs) ? pkgs : []).map(p => packageOf(p, top)).filter(p => p != null).sort((a, b) => a.dir.localeCompare(b.dir))
}

/**
 * One package of cargo metadata as a CargoPackage, null when it has no name or lies outside `top`.
 * @param {any} p @param {string} top  normalDir'd @returns {CargoPackage | null}
 */
function packageOf(p, top) {
  const dir = normalDir(normalDir(String(p?.manifest_path ?? '')).split('/').slice(0, -1).join('/'))
  if (!p?.name || (dir !== top && !dir.startsWith(`${top}/`))) return null
  const deps = (Array.isArray(p.dependencies) ? p.dependencies : []).map((/** @type {{ name?: unknown }} */ d) => String(d?.name ?? '')).filter(Boolean)
  return { dir: dir === top ? '.' : dir.slice(top.length + 1), name: String(p.name), deps: [...new Set(deps)].sort() }
}

/** The NUL-separated paths of `git ls-files -z`. @param {string} text @returns {string[]} */
export function parseLsFiles(text) {
  return String(text).split('\0').filter(Boolean)
}

/**
 * Matching lines by file from `git grep -c -z`: `<path>\0<count>` per line.
 * @param {string} text @returns {Map<string, number>}
 */
export function parseGrepCounts(text) {
  /** @type {Map<string, number>} */
  const out = new Map()
  for (const line of String(text).split('\n')) {
    const at = line.lastIndexOf('\0')
    if (at < 1) continue
    const n = Number(line.slice(at + 1))
    if (Number.isInteger(n) && n >= 0) out.set(line.slice(0, at), n)
  }
  return out
}

/** The lines `wc -l` counts: newline characters. @param {string} text */
export function countLines(text) {
  let n = 0
  for (let i = text.indexOf('\n'); i !== -1; i = text.indexOf('\n', i + 1)) n++
  return n
}

/** Whether `file` lies under the directory `dir` ('.' holds everything). @param {string} file @param {string} dir */
function under(file, dir) {
  return dir === '.' || file.startsWith(`${dir}/`)
}

/**
 * One `@@ <dir> <.rs lines> <pub lines> <name> <deps>...` line per package. Its sizes are summed over the files
 * git lists under its directory, a nested package's included, as the prose probe counted them: `.rs` lines
 * from `rsLines`, `pub` lines (over every tracked file, not only `.rs`) from `pubLines`.
 * @param {CargoPackage[]} packages @param {Map<string, number>} rsLines @param {Map<string, number>} pubLines
 * @returns {string[]}
 */
export function packageLines(packages, rsLines, pubLines) {
  /** @param {Map<string, number>} m @param {string} dir */
  const sum = (m, dir) => [...m].reduce((n, [f, c]) => (under(f, dir) ? n + c : n), 0)
  return packages.map(p => ['@@', p.dir, sum(rsLines, p.dir), sum(pubLines, p.dir), p.name, ...p.deps].join(' '))
}

/** The non-empty lines of `git diff --numstat` output, verbatim (a binary file is `-\t-\t<path>`). @param {string} text */
export function numstatLines(text) {
  return String(text).split('\n').filter(l => l.trim())
}

/**
 * The probe's answer: every package's root and line, and the diff's numstat lines.
 * @param {CargoPackage[]} packages @param {Map<string, number>} rsLines @param {Map<string, number>} pubLines @param {string} numstat
 * @returns {import('./review-unit-schemas.mjs').UnitsAnswer}
 */
export function unitsAnswer(packages, rsLines, pubLines, numstat) {
  return { roots: packages.map(p => p.dir), packages: packageLines(packages, rsLines, pubLines), numstat: numstatLines(numstat) }
}
