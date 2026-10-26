// The deterministic same-spot fold of the review engine's dedup (src/review.js): one defect two lenses reported at
// one file:line.
import { shingleOverlap } from './run-record.mjs'
import { toolDistinct } from './prior-decision-match.mjs'

/** @typedef {import('./review-schemas.mjs').Finding} Finding */

// Two findings at the SAME file:line whose titles are near-identical are one defect, and the model
// dedup pass is measurably bad at saying so: it runs on haiku with a 160-char slice of `why`, and its
// own "same file+line alone is NOT enough / when in doubt do NOT group" instruction biases it toward
// keeping both. Measured on a payments-service run: the 'reconciler' and 'errors' lenses filed the same
// reconcile-alarm defect at one line with titles sharing their first 76 characters, survived dedup as
// two findings, and each paid a full 4-vote individual verification. Catch that deterministically — the
// model pass then only has to handle the genuinely reworded cross-file duplicates it is good at.
export const SAME_SPOT_OVERLAP = 0.6

/** @param {Finding[]} pool */
export function sameSpotGroups(pool) {
  /** @type {Map<string, number[]>} */
  const bySpot = new Map()
  pool.forEach((/** @type {Finding} */ f, /** @type {number} */ i) => {
    if (!f || !f['file']) return // no location → nothing to key on; leave it to the model pass
    const k = `${String(f['file']).toLowerCase()}:${f['line'] || 0}`
    const at = bySpot.get(k)
    if (at) at.push(i)
    else bySpot.set(k, [i])
  })
  const groups = []
  for (const [, idxs] of bySpot) {
    if (idxs.length < 2) continue
    groups.push(...spotGroups(pool, idxs))
  }
  return groups
}

/** Near-identical titles among the findings at one spot, grouped (first match takes a finding). @param {Finding[]} pool @param {number[]} idxs */
export function spotGroups(pool, idxs) {
  const groups = []
  /** @type {Set<number>} */
  const taken = new Set()
  for (const i of idxs) {
    if (taken.has(i)) continue
    const g = [i, ...sameTitleAt(pool, idxs, i, taken)]
    if (g.length > 1) { taken.add(i); groups.push(g) }
  }
  return groups
}

/** The not-yet-taken findings at the spot whose title matches finding i's; each one returned is marked taken. @param {Finding[]} pool @param {number[]} idxs @param {number} i @param {Set<number>} taken */
export function sameTitleAt(pool, idxs, i, taken) {
  const g = []
  for (const j of idxs) {
    if (j === i || taken.has(j)) continue
    const [a, b] = [/** @type {Finding} */ (pool[i]), /** @type {Finding} */ (pool[j])]
    // Two gate-tool findings distinct by the tool's own identity are two findings, however alike their titles (realm @nick/craft, node #238).
    if (shingleOverlap(a['title'], b['title']) >= SAME_SPOT_OVERLAP && !toolDistinct(a, b)) { g.push(j); taken.add(j) }
  }
  return g
}
