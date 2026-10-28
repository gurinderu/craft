// What the unitScope probe tells the batching about each unit (realm @nick/craft, #355, #362): its size, its
// dependencies by name, and the changed lines of each file. A profile's probe (its `units.probePrompt`, the
// Rust one in lib/rust-units.mjs) prints one `@@` line per unit and `git diff --numstat` lines; these parse
// them, and the graph the batching walks is built from what they parse.
import { unitRootOf } from './unit-scope.mjs'

/**
 * @typedef {{ root: string, name: string, codeLines: number, sigLines: number, deps: string[] }} Package  a unit as the probe sized it
 * @typedef {{ craftRoot: string, version: string, repo: string }} PluginPlace  where the probe may find the plugin's
 *   own scripts (lib/run-logging.mjs pluginScriptPrelude) and the repository it runs them in
 * @typedef {{ noun: string, probePrompt: (range: string, plugin?: PluginPlace) => string, nameKey: (name: string) => string,
 *   signatures: string, surface: (root: string) => string, publicItems: string, changedItems: string }} UnitDiscovery
 *   A language profile's unit discovery (#362): what its units are called, the probe that lists them (one
 *   `@@ <dir> <code lines> <public lines> <name> <dep>...` line each, and the numstat), how a dependency name
 *   matches a unit's, and what a confined lens and the contract lens read of a unit they may not open: the
 *   signatures of another unit (`<its path>` its directory), the public surface at a root, what a public
 *   contract is made of, and the public items the seam pass follows. A profile without one has no units.
 */

/** A count as the probe printed it; anything else is 0. @param {unknown} v */
const probeCount = v => (/^\d+$/.test(String(v)) ? Number(v) : 0)

/**
 * One unit per `@@ <dir> <code lines> <public lines> <name> <dep>...` line, sorted by root; the first
 * line wins for a root printed twice, and a line in another shape is skipped; names are kept by `nameKey`.
 * @param {unknown} lines @param {(name: string) => string} [nameKey] @returns {Package[]}
 */
export function parsePackageLines(lines, nameKey = n => n) {
  /** @type {Map<string, Package>} */
  const byRoot = new Map()
  for (const line of Array.isArray(lines) ? lines : []) {
    const f = String(line).trim().split(/\s+/)
    if (f[0] !== '@@' || f.length < 5) continue
    const root = unitRootOf(f[1])
    if (byRoot.has(root)) continue
    const deps = [...new Set(f.slice(5).map(nameKey))].sort()
    byRoot.set(root, { root, name: nameKey(String(f[4])), codeLines: probeCount(f[2]), sigLines: probeCount(f[3]), deps })
  }
  return [...byRoot.values()].sort((a, b) => a.root.localeCompare(b.root))
}

/**
 * Changed lines (added + deleted) by file from `git diff --numstat` lines; a binary file (`-  -`) is 0. The
 * fields may be parted by any whitespace run (a probe's shell or model can turn tabs into spaces); only the
 * first two are split off, the path is the rest of the line and may hold spaces.
 * @param {unknown} lines @returns {Map<string, number>}
 */
export function parseNumstat(lines) {
  /** @type {Map<string, number>} */
  const out = new Map()
  for (const line of Array.isArray(lines) ? lines : []) {
    const m = /^\s*(\d+|-)\s+(\d+|-)\s+(.*\S)\s*$/.exec(String(line))
    if (m) out.set(String(m[3]), probeCount(m[1]) + probeCount(m[2]))
  }
  return out
}

/**
 * The dependency edges among `roots`, undirected: a root's neighbours are the roots it depends on or that
 * depend on it, by name. @param {string[]} roots @param {Package[]} packages
 * @returns {Map<string, string[]>}
 */
export function unitEdges(roots, packages) {
  const among = new Set(roots)
  const rootOfName = new Map(packages.filter(p => among.has(p.root)).map(p => [p.name, p.root]))
  /** @type {Map<string, Set<string>>} */
  const adj = new Map(roots.map(r => [r, new Set()]))
  for (const p of packages) {
    if (!among.has(p.root)) continue
    for (const d of p.deps) {
      const q = rootOfName.get(d)
      if (q && q !== p.root) { adj.get(p.root)?.add(q); adj.get(q)?.add(p.root) }
    }
  }
  return new Map([...adj.entries()].map(([r, s]) => [r, [...s].sort()]))
}

/**
 * The public-signature lines a batch of units may read in its dependencies: every discovered unit one of
 * them depends on, outside the batch, counted once. @param {string[]} members @param {Package[]} packages
 */
export function depSigLines(members, packages) {
  const inBatch = new Set(members)
  const byName = new Map(packages.map(p => [p.name, p]))
  const deps = new Set(packages.filter(p => inBatch.has(p.root)).flatMap(p => p.deps))
  return [...deps].map(d => byName.get(d)).filter(p => p && !inBatch.has(p.root)).reduce((n, p) => n + (p?.sigLines ?? 0), 0)
}
