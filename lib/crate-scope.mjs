// Crate-scoped slicing for the review engine's `crateScope` mode (rust profile only, off by default): each
// code-intrinsic lens gets one Cargo package instead of a directory bucket, judges it and reads bodies only in
// it, and asks a coordinator about the others (realm @nick/craft, nodes #319, #316). The partition reuses
// lib/lens-scope.mjs: shared files (manifests, lockfile) ride on every slice, an oversized crate splits by
// module directory, and files in no crate keep the directory slicing they had.
import { partitionOwned, sliceDiff, splitDeep } from './lens-scope.mjs'
import { titleKey } from './prior-decision-match.mjs'

/** @typedef {import('./lens-scope.mjs').Group & { crate?: string }} CrateGroup */

// A crate root as git spells a directory: no `./`, no trailing `/`, the repository root as `.`.
/** @param {unknown} root @returns {string} */
export function crateRootOf(root) {
  const segs = String(root ?? '').split('/').filter(s => s && s !== '.')
  return segs.length ? segs.join('/') : '.'
}

// The crate that owns `file`: the root with the most segments that is a strict directory prefix of it,
// compared segment by segment (`crates/a` does not own `crates/ab/x.rs`); '' when none does.
/** @param {string} file @param {string[]} roots @returns {string} */
export function crateOf(file, roots) {
  const parts = String(file).split('/')
  let best = ''
  let bestLen = -1
  for (const r of roots) {
    const root = crateRootOf(r)
    const segs = root === '.' ? [] : root.split('/')
    if (segs.length > bestLen && segs.length < parts.length && segs.every((s, i) => s === parts[i])) {
      best = root
      bestLen = segs.length
    }
  }
  return best
}

// The crates a change touches, sorted: every changed file that lies in one, manifests included.
/** @param {unknown} files @param {unknown} roots @returns {string[]} */
export function touchedCrates(files, roots) {
  const rs = Array.isArray(roots) ? roots.map(String) : []
  const list = Array.isArray(files) ? files.map(String) : []
  return [...new Set(list.map(f => crateOf(f, rs)).filter(Boolean))].sort()
}

// The key of a crate slice: `crate:<root>`, and `crate:<root>//<module>` for one module of an oversized
// crate — the root stays readable in the dispatch label, which is how lib/crate-boundary.mjs finds it.
/** @param {string} root @param {string} moduleKey */
export function crateSliceKey(root, moduleKey) {
  const sub = moduleKey === root ? '' : root === '.' ? moduleKey : moduleKey.slice(root.length + 1)
  return sub ? `crate:${root}//${sub}` : `crate:${root}`
}

// Slices keyed by crate: `{ key, files, crate }`, `crate` the owning root ('' for the directory slices of
// files outside every crate). Returns [] — "do not slice" — on the same terms as sliceDiff: fewer owned
// files than `minFiles`, or a single slice. Crates are never merged with each other: a slice spanning two
// crates is what this mode exists to remove; the cap only splits a crate larger than a sixth of the change.
/**
 * @param {unknown} files @param {unknown} roots
 * @param {{ minFiles?: number, maxSlices?: number, owns?: ((f: string) => boolean) | null }} [opts]
 * @returns {CrateGroup[]}
 */
export function sliceByCrate(files, roots, { minFiles = 12, maxSlices = 6, owns = null } = {}) {
  const all = (Array.isArray(files) ? files : []).map(String).filter(Boolean)
  const { shared, owned } = partitionOwned(all, owns)
  if (owned.length < minFiles) return []
  const cap = Math.max(1, Math.ceil(owned.length / maxSlices))
  const { byCrate, loose } = filesByCrate(owned, Array.isArray(roots) ? roots.map(String) : [])
  const groups = [...crateGroups(byCrate, cap, shared), ...looseGroups(loose, shared, maxSlices, owns)]
  return groups.length > 1 ? groups : []
}

// Owned files bucketed by their crate root, and those in no crate.
/** @param {string[]} owned @param {string[]} roots @returns {{ byCrate: Map<string, string[]>, loose: string[] }} */
function filesByCrate(owned, roots) {
  /** @type {Map<string, string[]>} */
  const byCrate = new Map()
  /** @type {string[]} */
  const loose = []
  for (const f of owned) {
    const c = crateOf(f, roots)
    if (!c) loose.push(f)
    else byCrate.set(c, [...(byCrate.get(c) || []), f])
  }
  return { byCrate, loose }
}

// One slice per crate, an oversized crate split by module directory below its root.
/** @param {Map<string, string[]>} byCrate @param {number} cap @param {string[]} shared @returns {CrateGroup[]} */
function crateGroups(byCrate, cap, shared) {
  return [...byCrate.entries()].sort(([a], [b]) => a.localeCompare(b)).flatMap(([root, fs]) =>
    splitDeep({ key: root, files: fs }, cap, (root === '.' ? 0 : root.split('/').length) + 1)
      .map(g => ({ key: crateSliceKey(root, g.key), files: [...g.files, ...shared], crate: root })))
}

// Files in no crate keep the directory slicing; too few to split are one slice of their own.
/** @param {string[]} loose @param {string[]} shared @param {number} maxSlices @param {((f: string) => boolean) | null} owns @returns {CrateGroup[]} */
function looseGroups(loose, shared, maxSlices, owns) {
  if (!loose.length) return []
  const gs = sliceDiff([...loose, ...shared], { minFiles: 1, maxSlices, owns }).map(g => ({ ...g, crate: '' }))
  return gs.length ? gs : [{ key: 'outside crates', files: [...loose, ...shared], crate: '' }]
}

// The lenses' questions as they reported them, counted for the run record: `blocking` were written to the
// channel and waited on, `deferred` were left to the seam pass, `timedOut` waited and got no answer.
/** @param {unknown} questions @returns {{ blocking: number, deferred: number, answered: number, timedOut: number }} */
export function questionTally(questions) {
  const qs = (Array.isArray(questions) ? questions : []).filter(q => q && typeof q === 'object')
  const blocking = qs.filter(q => q.blocking === true)
  const answered = blocking.filter(q => q.answered === true).length
  return { blocking: blocking.length, deferred: qs.length - blocking.length, answered, timedOut: blocking.length - answered }
}

// One finding's identity for a disposition: the lens that raised it, its file and its title. A title alone
// is not one — two lenses, or two files, raise findings under one title.
/** @param {unknown} lens @param {unknown} file @param {unknown} title */
export function dependentKey(lens, file, title) {
  const t = titleKey(title)
  return t ? `${String(lens ?? '')}|${String(file ?? '').trim().toLowerCase()}|${t}` : ''
}

// The seam pass's dispositions applied to the candidate pool, for the findings an open lens question named
// (`dependent`): `drop` and `convert` remove the finding they name by lens, file and title (a converted one
// comes back as the seam finding the pass reports); `confirm` keeps it. A disposition naming any other
// finding, or an unknown action, is ignored: the seam pass judges dependent findings, not the pool.
/**
 * @template {{ title?: unknown, file?: unknown, source?: unknown }} F
 * @param {F[]} pool @param {unknown} dispositions
 * @param {Array<{ lens?: unknown, findingFile?: unknown, findingTitle?: unknown }>} dependent
 * @returns {{ kept: F[], counts: { confirm: number, drop: number, convert: number } }}
 */
export function applyDispositions(pool, dispositions, dependent) {
  const counts = { confirm: 0, drop: 0, convert: 0 }
  const named = new Set(dependent.map(q => dependentKey(q.lens, q.findingFile, q.findingTitle)).filter(Boolean))
  const gone = new Set()
  for (const d of /** @type {unknown[]} */ (Array.isArray(dispositions) ? dispositions : [])) {
    const one = dispositionOf(d, named)
    if (!one) continue
    counts[one.action]++
    if (one.action !== 'confirm') gone.add(one.key)
  }
  return { kept: pool.filter(f => !gone.has(dependentKey(f.source, f.file, f.title))), counts }
}

// One disposition when its action is known and it names a dependent finding, else null.
/** @param {unknown} d @param {Set<string>} named @returns {{ action: 'confirm' | 'drop' | 'convert', key: string } | null} */
function dispositionOf(d, named) {
  const o = /** @type {{ action?: unknown, lens?: unknown, findingFile?: unknown, findingTitle?: unknown }} */ (d && typeof d === 'object' ? d : {})
  const action = String(o.action || '')
  const key = dependentKey(o.lens, o.findingFile, o.findingTitle)
  return (action === 'confirm' || action === 'drop' || action === 'convert') && named.has(key) ? { action, key } : null
}
