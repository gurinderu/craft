// What the memory's bounds keep when a run holds more than they let through, as the craft CLI's
// `memory/bounds.rs` keeps it (realm @nick/craft, nodes #203, #218, #230): the recall prompt's changed
// paths grouped by directory instead of cut, the records past the cap ranked by how close their scope is
// to the reviewed paths, and the judges' pairs ranked so the reviewed paths, then every finding's best
// candidate, come first. Under its bound each list is left exactly as it was.
// Imported by integrations/shared/memory-recall.mjs and prior-decisions.mjs.
import { decisionScopeParts, decisionText } from './prior-decision-record.mjs'

/** `path` cut to its first `depth` segments, as `dir/`; unchanged when it is no deeper. @param {string} path @param {number} depth */
function cutTo(path, depth) {
  const parts = decisionScopeParts(path)
  return parts.length <= depth ? parts.join('/') : `${parts.slice(0, depth).join('/')}/`
}

/**
 * The recall prompt's entries for `paths` under `max`: the paths themselves when they fit, else each cut
 * to its leading directories (`dir/`), as deep as still fits; past `max` top-level entries, the first
 * `max` of them. Also how many paths a directory entry stands for, and how many no entry covers.
 * @param {string[]} paths @param {number} max @returns {{ entries: string[], grouped: number, cut: number }}
 */
export function pathEntries(paths, max) {
  if (paths.length <= max) return { entries: [...paths], grouped: 0, cut: 0 }
  const deepest = Math.max(1, ...paths.map(p => decisionScopeParts(p).length))
  /** @param {number} level */
  const at = level => [...new Set(paths.map(p => cutTo(p, level)))].sort(codeUnitOrder)
  let fits = 1
  for (let level = deepest - 1; level >= 1; level--) {
    if (at(level).length <= max) {
      fits = level
      break
    }
  }
  const entries = at(fits).slice(0, max)
  // Entries are built from normalised segments, so a path is compared in the same form.
  const normal = paths.map(p => decisionScopeParts(p).join('/'))
  /** @param {string} p */
  const covered = p => entries.some(e => e === p || (e.endsWith('/') && p.startsWith(e)))
  return {
    entries,
    grouped: normal.filter(p => covered(p) && !entries.includes(p)).length,
    cut: normal.filter(p => !covered(p)).length,
  }
}

/** Ordering by UTF-16 code units, as Rust's byte order agrees for the ASCII paths it meets. @param {string} a @param {string} b */
function codeUnitOrder(a, b) {
  if (a < b) return -1
  return a > b ? 1 : 0
}

/**
 * How close a record's scope is to the reviewed `paths`, lowest first: naming one of them, a directory
 * holding one, any other scope, the whole repository.
 * @param {string} scope @param {string[]} paths @returns {number}
 */
function closeness(scope, paths) {
  const parts = decisionScopeParts(scope)
  if (!parts.length) return 3
  const files = paths.map(decisionScopeParts)
  if (files.some(f => f.length === parts.length && parts.every((s, i) => s === f[i]))) return 0
  return files.some(f => parts.length <= f.length && parts.every((s, i) => s === f[i])) ? 1 : 2
}

/** A field of a raw record, trimmed. @param {unknown} item @param {string} k */
function field(item, k) {
  return item && typeof item === 'object' ? decisionText(/** @type {Record<string, unknown>} */ (item)[k]) : ''
}

/**
 * Which records of `list` a cap of `max` keeps, by index: all under it; past it the closest to the
 * reviewed `paths`, a deeper scope before a shallower one, a newer before an older, then the order given.
 * @param {unknown[]} list @param {string[]} paths @param {number} max @returns {boolean[]}
 */
export function keptRecords(list, paths, max) {
  if (list.length <= max) return list.map(() => true)
  const keyed = list.map((item, i) => {
    const scope = field(item, 'scope')
    return { i, c: closeness(scope, paths), depth: decisionScopeParts(scope).length, date: field(item, 'date') }
  })
  keyed.sort((a, b) => a.c - b.c || b.depth - a.depth || codeUnitOrder(b.date, a.date) || a.i - b.i)
  const kept = list.map(() => false)
  for (const k of keyed.slice(0, max)) kept[k.i] = true
  return kept
}
