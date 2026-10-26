// The seam pass's dispositions in crateScope mode (realm @nick/craft, node #321): which candidate findings an
// open cross-crate question named, what the seam pass did with each, and the report's list of what it set aside.
import { titleKey } from './prior-decision-match.mjs'

// One finding's identity for a disposition: the lens that raised it, its file and its title. A title alone
// is not one — two lenses, or two files, raise findings under one title.
/** @param {unknown} lens @param {unknown} file @param {unknown} title */
export function dependentKey(lens, file, title) {
  const t = titleKey(title)
  return t ? `${String(lens ?? '')}|${String(file ?? '').trim().toLowerCase()}|${t}` : ''
}

// The seam pass's dispositions applied to the candidate pool, for the findings an open lens question named
// (`dependent`): `drop` and `convert` take the finding they name by lens, file and title out of the pool (a
// converted one comes back as the seam finding the pass reports); `confirm` keeps it. A disposition naming any
// other finding, or an unknown action, is ignored: the seam pass judges dependent findings, not the pool. What
// left the pool is returned as `setAside`, each with the seam's why, for the record and the report — a finding
// never leaves a review silently.
/**
 * @template {{ title?: unknown, file?: unknown, line?: unknown, severity?: unknown, source?: unknown }} F
 * @param {F[]} pool @param {unknown} dispositions
 * @param {Array<{ lens?: unknown, findingFile?: unknown, findingTitle?: unknown }>} dependent
 * @returns {{ kept: F[], counts: { confirm: number, drop: number, convert: number }, setAside: SetAside[] }}
 */
export function applyDispositions(pool, dispositions, dependent) {
  const counts = { confirm: 0, drop: 0, convert: 0 }
  const named = new Set(dependent.map(q => dependentKey(q.lens, q.findingFile, q.findingTitle)).filter(Boolean))
  /** @type {Map<string, { action: 'drop' | 'convert', why: string }>} */
  const gone = new Map()
  for (const d of /** @type {unknown[]} */ (Array.isArray(dispositions) ? dispositions : [])) {
    const one = dispositionOf(d, named)
    if (!one) continue
    counts[one.action]++
    if (one.action !== 'confirm') gone.set(one.key, { action: one.action, why: one.why })
  }
  /** @type {SetAside[]} */
  const setAside = []
  const kept = pool.filter(f => {
    const g = gone.get(dependentKey(f.source, f.file, f.title))
    if (g) setAside.push({ action: g.action, lens: String(f.source ?? ''), title: String(f.title ?? ''), file: String(f.file ?? ''), line: Number(f.line) || 0, severity: String(f.severity ?? ''), why: g.why })
    return !g
  })
  return { kept, counts, setAside }
}

/** @typedef {{ action: 'drop' | 'convert', lens: string, title: string, file: string, line: number, severity: string, why: string }} SetAside */

// One disposition when its action is known and it names a dependent finding, else null.
/** @param {unknown} d @param {Set<string>} named @returns {{ action: 'confirm' | 'drop' | 'convert', key: string, why: string } | null} */
function dispositionOf(d, named) {
  const o = /** @type {{ action?: unknown, lens?: unknown, findingFile?: unknown, findingTitle?: unknown, why?: unknown }} */ (d && typeof d === 'object' ? d : {})
  const action = String(o.action || '')
  const key = dependentKey(o.lens, o.findingFile, o.findingTitle)
  return (action === 'confirm' || action === 'drop' || action === 'convert') && named.has(key) ? { action, key, why: String(o.why ?? '') } : null
}

// The report's section for what the seam pass set aside, '' when it set aside nothing.
/** @param {Array<{ language: string, seam: { setAside: SetAside[] } }>} runs @returns {string} */
export function seamSetAsideSection(runs) {
  const rows = runs.flatMap(r => r.seam.setAside.map(s => `- ${s.action} · ${s.severity || '?'} · \`${s.file || '?'}:${s.line}\` · ${s.lens} · ${s.title} — ${s.why || '(no why given)'}`))
  if (!rows.length) return ''
  return `\n\n## Set aside by the seam pass (crateScope)\nThese candidates were taken out before verification: an open cross-crate question named each, and the seam pass answered it — \`drop\` (its premise is false) or \`convert\` (reported as a seam finding instead). Not verified; listed so none leaves the review silently.\n${rows.join('\n')}`
}
