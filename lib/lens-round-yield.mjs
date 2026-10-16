// What each lens round's findings became after verification (realm @nick/craft, node #248).
//
// A finding remembers the round that first put it in the pool as `foundInRound`: 1..maxRounds for a
// lens round, 0 for a gate seed. A finding no round produced — a resurrected lens's answer, a critic
// follow-up, a carried prior — has no `foundInRound` and is counted in no round. Lives here, outside
// the workflow, for the reason lib/review-waves.mjs does, and is pasted back through a `craft-inline`
// fenced region.
import { countBySeverity } from './run-record.mjs'

/**
 * The earliest round among findings merged into one; undefined when none of them carries one.
 * @param {ReadonlyArray<object>} members
 * @returns {number | undefined}
 */
export function earliestRound(members) {
  const rounds = members.map(m => /** @type {{ foundInRound?: unknown }} */ (m).foundInRound).filter(r => typeof r === 'number')
  return rounds.length ? Math.min(...rounds) : undefined
}

/**
 * `f` as the merge of `members`: it was first found when the earliest of them was.
 * @template {object} F
 * @param {F} f @param {ReadonlyArray<object>} members
 * @returns {F}
 */
export function withEarliestRound(f, members) {
  const round = earliestRound(members)
  return round === undefined ? f : { ...f, foundInRound: round }
}

/**
 * What verification made of the findings first found in `round`.
 * @param {number} round @param {unknown[]} confirmed @param {unknown[]} suspected
 */
export function roundYield(round, confirmed, suspected) {
  /** @param {unknown} f */
  const inRound = f => f != null && /** @type {{ foundInRound?: unknown }} */ (f).foundInRound === round
  const c = (confirmed || []).filter(inRound)
  return { confirmedCount: c.length, confirmedBySeverity: countBySeverity(c), suspectedCount: (suspected || []).filter(inRound).length }
}

/**
 * Each lens round's record entry with its yield beside the fields it already had.
 * @template {{ round: number }} R
 * @param {R[]} lensRounds @param {unknown[]} confirmed @param {unknown[]} suspected
 */
export function lensRoundYield(lensRounds, confirmed, suspected) {
  return (lensRounds || []).map(x => ({ ...x, ...roundYield(x.round, confirmed, suspected) }))
}
