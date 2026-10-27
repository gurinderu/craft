// Unit-scoped slicing for the review engine's `unitScope` mode (off by default; a unit is what the profile's
// discovery finds, realm @nick/craft, #362): each code-intrinsic lens gets one unit instead of a directory
// bucket, judges it and reads bodies only in it, and asks a coordinator about the others (#319, #316). The
// partition reuses lib/lens-scope.mjs: shared files (manifests, lockfile) ride on every slice, an oversized
// unit splits by module directory, and files in no unit keep the directory slicing they had.
import { partitionOwned, sliceDiff, splitDeep } from './lens-scope.mjs'

/** @typedef {import('./lens-scope.mjs').Group & { unit?: string, units?: string[], volume?: number, changedLines?: number }} UnitGroup */

// A unit root as git spells a directory: no `./`, no trailing `/`, the repository root as `.`.
/** @param {unknown} root @returns {string} */
export function unitRootOf(root) {
  const segs = String(root ?? '').split('/').filter(s => s && s !== '.')
  return segs.length ? segs.join('/') : '.'
}

// The unit that owns `file`: the root with the most segments that is a strict directory prefix of it,
// compared segment by segment (`crates/a` does not own `crates/ab/x.rs`); '' when none does.
/** @param {string} file @param {string[]} roots @returns {string} */
export function unitOf(file, roots) {
  const parts = String(file).split('/')
  let best = ''
  let bestLen = -1
  for (const r of roots) {
    const root = unitRootOf(r)
    const segs = root === '.' ? [] : root.split('/')
    if (segs.length > bestLen && segs.length < parts.length && segs.every((s, i) => s === parts[i])) {
      best = root
      bestLen = segs.length
    }
  }
  return best
}

// The units a change touches, sorted: every changed file that lies in one, manifests included.
/** @param {unknown} files @param {unknown} roots @returns {string[]} */
export function touchedUnits(files, roots) {
  const rs = Array.isArray(roots) ? roots.map(String) : []
  const list = Array.isArray(files) ? files.map(String) : []
  return [...new Set(list.map(f => unitOf(f, rs)).filter(Boolean))].sort()
}

// The key of a unit slice: `unit:<root>`, and `unit:<root>//<module>` for one module of an oversized
// unit — the root stays readable in the dispatch label, which is how lib/unit-boundary.mjs finds it.
/** @param {string} root @param {string} moduleKey */
export function unitSliceKey(root, moduleKey) {
  const sub = moduleKey === root ? '' : root === '.' ? moduleKey : moduleKey.slice(root.length + 1)
  return sub ? `unit:${root}//${sub}` : `unit:${root}`
}

// Slices keyed by unit: `{ key, files, unit }`, `unit` the owning root ('' for the directory slices of
// files outside every unit). Returns [] — "do not slice" — on the same terms as sliceDiff: fewer owned
// files than `minFiles`, or a single slice. Units are never merged with each other: a slice spanning two
// units is what this mode exists to remove; the cap only splits a unit larger than a sixth of the change.
/**
 * @param {unknown} files @param {unknown} roots
 * @param {{ minFiles?: number, maxSlices?: number, owns?: ((f: string) => boolean) | null }} [opts]
 * @returns {UnitGroup[]}
 */
export function sliceByUnit(files, roots, { minFiles = 12, maxSlices = 6, owns = null } = {}) {
  const groups = unitSlices(files, roots, { minFiles, maxSlices, owns })
  return groups.length > 1 ? groups : []
}

// The unit slices of sliceByUnit with a single slice kept, not read as "do not slice": the plan of one agent
// per unit slice, for an estimate to compare against (lib/review-unit-batches.mjs); never dispatched.
/**
 * @param {unknown} files @param {unknown} roots
 * @param {{ minFiles?: number, maxSlices?: number, owns?: ((f: string) => boolean) | null }} [opts]
 * @returns {UnitGroup[]}
 */
export function unitSlices(files, roots, { minFiles = 1, maxSlices = 6, owns = null } = {}) {
  const all = (Array.isArray(files) ? files : []).map(String).filter(Boolean)
  const { shared, owned } = partitionOwned(all, owns)
  if (owned.length < minFiles) return []
  const cap = Math.max(1, Math.ceil(owned.length / maxSlices))
  const { byUnit, loose } = filesByUnit(owned, Array.isArray(roots) ? roots.map(String) : [])
  return [...unitGroups(byUnit, cap, shared), ...looseGroups(loose, shared, maxSlices, owns)]
}

// Owned files bucketed by their unit root, and those in no unit.
/** @param {string[]} owned @param {string[]} roots @returns {{ byUnit: Map<string, string[]>, loose: string[] }} */
function filesByUnit(owned, roots) {
  /** @type {Map<string, string[]>} */
  const byUnit = new Map()
  /** @type {string[]} */
  const loose = []
  for (const f of owned) {
    const c = unitOf(f, roots)
    if (!c) loose.push(f)
    else byUnit.set(c, [...(byUnit.get(c) || []), f])
  }
  return { byUnit, loose }
}

// One slice per unit, an oversized unit split by module directory below its root.
/** @param {Map<string, string[]>} byUnit @param {number} cap @param {string[]} shared @returns {UnitGroup[]} */
function unitGroups(byUnit, cap, shared) {
  return [...byUnit.entries()].sort(([a], [b]) => a.localeCompare(b)).flatMap(([root, fs]) =>
    splitDeep({ key: root, files: fs }, cap, (root === '.' ? 0 : root.split('/').length) + 1)
      .map(g => ({ key: unitSliceKey(root, g.key), files: [...g.files, ...shared], unit: root })))
}

// Files in no unit keep the directory slicing; too few to split are one slice of their own.
/** @param {string[]} loose @param {string[]} shared @param {number} maxSlices @param {((f: string) => boolean) | null} owns @returns {UnitGroup[]} */
export function looseGroups(loose, shared, maxSlices, owns) {
  if (!loose.length) return []
  const gs = sliceDiff([...loose, ...shared], { minFiles: 1, maxSlices, owns }).map(g => ({ ...g, unit: '' }))
  return gs.length ? gs : [{ key: 'outside units', files: [...loose, ...shared], unit: '' }]
}

// The report's line for each profile that asked for unitScope and did not get it (realm @nick/craft, #362):
// a warning, never a failure — the review ran in the normal mode. '' when there is none.
/** @param {string[]} notices @returns {string} */
export function unitNoticeSection(notices) {
  return notices.length ? `\n\n${notices.map(n => `⚠️ ${n}`).join('\n')}` : ''
}

// The lenses' questions as they reported them, counted for the run record: `blocking` were written to the
// channel and waited on, `deferred` were left to the seam pass, `noCoordinator` waited until the round's
// coordinator had left (the lens answered "NO-COORDINATOR"), `timedOut` waited on a live one and got no answer.
/** @param {unknown} questions @returns {{ blocking: number, deferred: number, answered: number, timedOut: number, noCoordinator: number }} */
export function questionTally(questions) {
  const qs = (Array.isArray(questions) ? questions : []).filter(q => q && typeof q === 'object')
  const blocking = qs.filter(q => q.blocking === true)
  const answered = blocking.filter(q => q.answered === true).length
  const noCoordinator = blocking.filter(q => q.answered !== true && /^\s*NO-COORDINATOR/.test(String(q.answer ?? ''))).length
  return { blocking: blocking.length, deferred: qs.length - blocking.length, answered, timedOut: blocking.length - answered - noCoordinator, noCoordinator }
}
