// Crate batches for the review engine's crateScope mode (realm @nick/craft, #355, #354): the touched crates
// packed into units of lens work under a volume batchBudget. Crates joined by a Cargo dependency go together, so
// one agent sees the seam between them whole; a component over the batchBudget is split greedily along its edges;
// what is left, and the unconnected crates, is bin-packed by volume; a crate over the batchBudget alone is split
// by module directory. Volume is a crate's changed lines plus the pub-signature lines of the workspace
// packages it depends on. Every order here is sorted, so one input gives one plan.
import { partitionOwned, groupKey } from './lens-scope.mjs'
import { crateOf, crateSliceKey, looseGroups } from './crate-scope.mjs'
import { crateEdges, depSigLines } from './crate-manifests.mjs'

/**
 * @typedef {import('./crate-manifests.mjs').Package} Package
 * @typedef {import('./crate-scope.mjs').CrateGroup} Batch
 * @typedef {{ key: string, files: string[], w: number }} Piece
 */

// Placeholders until the cost model is fitted (realm @nick/craft, #356): the volume one batch may hold, and
// the changed lines assumed for a file the probe's numstat did not list.
export const PLACEHOLDER_BATCH_BUDGET = 1500
const PLACEHOLDER_LINES_PER_FILE = 60

/** The changed lines of a file by the probe's numstat, the placeholder for one it did not list. @param {Map<string, number>} numstat */
export const changedLinesOf = numstat => (/** @type {string} */ f) => numstat.get(f) ?? PLACEHOLDER_LINES_PER_FILE

/** Largest weight first, then by key. @param {{ key: string, w: number }} a @param {{ key: string, w: number }} b */
const heavyFirst = (a, b) => b.w - a.w || a.key.localeCompare(b.key)

/**
 * First-fit decreasing into bins of `cap`; an item heavier than `cap` gets a bin of its own.
 * @template {{ key: string, w: number }} T @param {T[]} items @param {number} cap @returns {T[][]}
 */
function binPack(items, cap) {
  /** @type {Array<{ items: T[], w: number }>} */
  const bins = []
  for (const it of [...items].sort(heavyFirst)) {
    const bin = bins.find(b => b.w + it.w <= cap)
    if (bin) { bin.items.push(it); bin.w += it.w } else bins.push({ items: [it], w: it.w })
  }
  return bins.map(b => b.items.sort((x, y) => x.key.localeCompare(y.key))).sort((x, y) => String(x[0]?.key).localeCompare(String(y[0]?.key)))
}

/**
 * A crate's files cut by module directory until each piece is under `cap`, as lens-scope's splitDeep cuts
 * by file count. @param {Piece} piece @param {(f: string) => number} lines @param {number} cap @param {number} depth
 * @returns {Piece[]}
 */
function splitModules(piece, lines, cap, depth) {
  if (piece.w <= cap || piece.files.length <= 1 || depth > 8) return [piece]
  /** @type {Map<string, string[]>} */
  const byKey = new Map()
  for (const f of piece.files) byKey.set(groupKey(f, depth), [...(byKey.get(groupKey(f, depth)) || []), f])
  if (byKey.size <= 1) return splitModules(piece, lines, cap, depth + 1)
  return [...byKey.entries()].sort(([a], [b]) => a.localeCompare(b))
    .flatMap(([key, files]) => splitModules({ key, files, w: files.reduce((n, f) => n + lines(f), 0) }, lines, cap, depth + 1))
}

/**
 * The connected components of `roots` under `adj`, each in breadth-first order from its smallest root.
 * @param {string[]} roots @param {Map<string, string[]>} adj @returns {string[][]}
 */
function components(roots, adj) {
  const seen = new Set()
  /** @type {string[][]} */
  const out = []
  for (const r of roots) {
    if (seen.has(r)) continue
    const comp = [r]
    seen.add(r)
    for (let i = 0; i < comp.length; i++) for (const n of adj.get(String(comp[i])) || []) if (!seen.has(n)) { seen.add(n); comp.push(n) }
    out.push(comp)
  }
  return out
}

/**
 * A component over the batchBudget, grown into batches along its edges: from each crate not yet placed, add
 * neighbours of the batch (breadth-first, sorted) while the volume fits. @param {string[]} comp
 * @param {Map<string, string[]>} adj @param {(r: string) => number} vol @param {number} batchBudget @returns {string[][]}
 */
function growAlongEdges(comp, adj, vol, batchBudget) {
  const placed = new Set()
  /** @type {string[][]} */
  const out = []
  for (const seed of comp) {
    if (placed.has(seed)) continue
    const batch = [seed]
    placed.add(seed)
    let w = vol(seed)
    for (let i = 0; i < batch.length; i++) {
      for (const n of adj.get(String(batch[i])) || []) {
        if (!placed.has(n) && w + vol(n) <= batchBudget) { placed.add(n); batch.push(n); w += vol(n) }
      }
    }
    out.push(batch)
  }
  return out
}

/**
 * The crates within the budget grouped into units: each connected component whole when it fits, else grown
 * along its edges; what is left alone is bin-packed by volume. @param {string[]} small @param {Package[]} packages
 * @param {(r: string) => number} vol @param {number} batchBudget @returns {string[][]}
 */
function crateUnits(small, packages, vol, batchBudget) {
  const adj = crateEdges(small, packages)
  /** @type {string[][]} */
  const units = []
  /** @type {Array<{ key: string, w: number }>} */
  const singles = []
  for (const comp of components(small, adj)) {
    const parts = comp.reduce((n, r) => n + vol(r), 0) <= batchBudget ? [comp] : growAlongEdges(comp, adj, vol, batchBudget)
    for (const p of parts) if (p.length > 1) units.push(p.sort()); else singles.push({ key: String(p[0]), w: vol(String(p[0])) })
  }
  return [...units, ...binPack(singles, batchBudget).map(bin => bin.map(x => x.key))]
}

/**
 * A crate over the budget alone: its module pieces packed into bins of what the budget leaves after its
 * dependencies' signatures; each bin is keyed `crate:<root>//<module>[+<module>...]`.
 * @param {string} root @param {string[]} files @param {(f: string) => number} lines @param {number} cap
 * @returns {Array<{ key: string, files: string[] }>}
 */
function moduleUnits(root, files, lines, cap) {
  const depth = (root === '.' ? 0 : root.split('/').length) + 1
  const sub = (/** @type {Piece} */ p) => crateSliceKey(root, p.key).slice(`crate:${root}//`.length)
  return binPack(splitModules({ key: root, files, w: files.reduce((n, f) => n + lines(f), 0) }, lines, cap, depth), cap)
    .map(bin => ({ key: bin.length === 1 ? crateSliceKey(root, String(bin[0]?.key)) : `crate:${root}//${bin.map(sub).join('+')}`, files: bin.flatMap(p => p.files) }))
}

/** Owned files bucketed by crate root, and those in no crate. @param {string[]} owned @param {string[]} roots */
function bucketByCrate(owned, roots) {
  /** @type {Map<string, string[]>} */
  const byCrate = new Map()
  /** @type {string[]} */
  const loose = []
  for (const f of owned) { const c = crateOf(f, roots); if (c) byCrate.set(c, [...(byCrate.get(c) || []), f]); else loose.push(f) }
  return { byCrate, loose }
}

/**
 * The batches of a crateScope review: `{ key, files, crate, crates, volume, changedLines }`, `crate` the
 * batch's first root, `files` its changed files plus the shared ones; files in no crate keep the directory
 * slicing. [] — "do not slice" — with fewer owned files than `minFiles`, or no crate and one directory slice.
 * @param {unknown} files @param {string[]} roots
 * @param {{ packages: Package[], numstat: Map<string, number>, batchBudget: number, owns?: ((f: string) => boolean) | null, minFiles?: number, maxSlices?: number }} o
 * @returns {Batch[]}
 */
export function batchByCrate(files, roots, { packages, numstat, batchBudget, owns = null, minFiles = 12, maxSlices = 6 }) {
  const { shared, owned } = partitionOwned((Array.isArray(files) ? files : []).map(String).filter(Boolean), owns)
  if (owned.length < minFiles) return []
  const lines = changedLinesOf(numstat)
  const { byCrate, loose } = bucketByCrate(owned, roots)
  const crates = [...byCrate.keys()].sort()
  const filesOf = (/** @type {string} */ r) => byCrate.get(r) || []
  const sig = (/** @type {string} */ r) => depSigLines([r], packages)
  const vol = (/** @type {string} */ r) => filesOf(r).reduce((n, f) => n + lines(f), 0) + sig(r)
  /** @param {string[]} unit @param {string[]} fs @param {string} key @returns {Batch} */
  const batch = (unit, fs, key) => {
    const changedLines = fs.reduce((n, f) => n + lines(f), 0)
    return { key, files: [...fs, ...shared], crate: String(unit[0]), crates: unit, changedLines, volume: changedLines + depSigLines(unit, packages) }
  }
  const crateBatches = crateUnits(crates.filter(r => vol(r) <= batchBudget), packages, vol, batchBudget)
    .map(u => batch(u, u.flatMap(filesOf), u.map(r => `crate:${r}`).join(' ')))
  const moduleBatches = crates.filter(r => vol(r) > batchBudget)
    .flatMap(r => moduleUnits(r, filesOf(r), lines, Math.max(1, batchBudget - sig(r))).map(m => batch([r], m.files, m.key)))
  const groups = [...crateBatches, ...moduleBatches].sort((a, b) => a.key.localeCompare(b.key))
  const all = [...groups, ...looseGroups(loose, shared, maxSlices, owns)]
  // One batch is still a boundary (the crate rule holds at its edge); only one directory slice is "do not slice".
  return all.length > 1 || groups.length ? all : []
}
