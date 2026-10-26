// What the crateScope probe tells the batching about each Cargo package (realm @nick/craft, #355): its size,
// its dependencies by package name, and the changed lines of each file. The probe prints one line per
// package and `git diff --numstat` lines (lib/review-crate-prompts.mjs, cratesPrompt); these parse them.
import { crateRootOf } from './crate-scope.mjs'

/**
 * @typedef {{ root: string, name: string, codeLines: number, sigLines: number, deps: string[] }} Package
 */

/** A count as the probe printed it; anything else is 0. @param {unknown} v */
const probeCount = v => (/^\d+$/.test(String(v)) ? Number(v) : 0)

// Cargo matches a dependency to a package by name with `-` and `_` taken as one character.
/** @param {string} name */
const crateName = name => name.replace(/-/g, '_')

/**
 * One package per `@@ <dir> <code lines> <pub lines> <name> <dep>...` line, sorted by root; the first
 * line wins for a root printed twice, and a line in another shape is skipped.
 * @param {unknown} lines @returns {Package[]}
 */
export function parsePackageLines(lines) {
  /** @type {Map<string, Package>} */
  const byRoot = new Map()
  for (const line of Array.isArray(lines) ? lines : []) {
    const f = String(line).trim().split(/\s+/)
    if (f[0] !== '@@' || f.length < 5) continue
    const root = crateRootOf(f[1])
    if (byRoot.has(root)) continue
    const deps = [...new Set(f.slice(5).map(crateName))].sort()
    byRoot.set(root, { root, name: crateName(String(f[4])), codeLines: probeCount(f[2]), sigLines: probeCount(f[3]), deps })
  }
  return [...byRoot.values()].sort((a, b) => a.root.localeCompare(b.root))
}

/**
 * Changed lines (added + deleted) by file from `git diff --numstat` lines; a binary file (`-  -`) is 0.
 * @param {unknown} lines @returns {Map<string, number>}
 */
export function parseNumstat(lines) {
  /** @type {Map<string, number>} */
  const out = new Map()
  for (const line of Array.isArray(lines) ? lines : []) {
    const m = /^(\d+|-)\t(\d+|-)\t(.+)$/.exec(String(line))
    if (m) out.set(String(m[3]), probeCount(m[1]) + probeCount(m[2]))
  }
  return out
}

/**
 * The dependency edges among `roots`, undirected: a root's neighbours are the roots it depends on or that
 * depend on it, by package name. @param {string[]} roots @param {Package[]} packages
 * @returns {Map<string, string[]>}
 */
export function crateEdges(roots, packages) {
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
 * The pub-signature lines a unit of crates may read in its dependencies: every workspace package one of
 * them depends on, outside the unit, counted once. @param {string[]} unit @param {Package[]} packages
 */
export function depSigLines(unit, packages) {
  const inUnit = new Set(unit)
  const byName = new Map(packages.map(p => [p.name, p]))
  const deps = new Set(packages.filter(p => inUnit.has(p.root)).flatMap(p => p.deps))
  return [...deps].map(d => byName.get(d)).filter(p => p && !inUnit.has(p.root)).reduce((n, p) => n + (p?.sigLines ?? 0), 0)
}
