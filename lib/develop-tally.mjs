// The DEVELOP section of analyze-runs (realm @nick/craft, node #281): how the craft:develop cycles in the
// store ended — converged, capped at the round limit, stopped without a verdict (node #263) — how many
// rounds they took, the open Medium+ left after each round, and what the full review after convergence
// found (node #278). Read off the records lib/develop-cycle.mjs shapes; a record it would refuse is
// counted apart, never guessed at.
import { readDevelopCycle } from './develop-cycle.mjs'

/**
 * @typedef {{ cycles: number, unreadable: number, converged: number, capped: number, noVerdict: number, light: number, full: number,
 *   rounds: number, convergedRounds: number, mediumPlusByRound: number[], cyclesByRound: number[],
 *   fullReviews: number, fullReopened: number, fullNoVerdict: number }} DevelopTally
 */

/** @returns {DevelopTally} */
export function newDevelopTally() {
  return { cycles: 0, unreadable: 0, converged: 0, capped: 0, noVerdict: 0, light: 0, full: 0, rounds: 0, convergedRounds: 0, mediumPlusByRound: [], cyclesByRound: [], fullReviews: 0, fullReopened: 0, fullNoVerdict: 0 }
}

/** Adds one develop record. @param {DevelopTally} t @param {import('./run-record.mjs').RunRecord} r @returns {void} */
export function tallyDevelop(t, r) {
  /** @type {import('./develop-cycle.mjs').DevelopCycle} */
  let c
  try { c = readDevelopCycle(r['develop']) } catch { t.unreadable++; return }
  t.cycles++
  if (c.outcome === 'converged') { t.converged++; t.convergedRounds += c.rounds.length } else if (c.outcome === 'capped') t.capped++
  else t.noVerdict++
  if (c.mode === 'full') t.full++
  else t.light++
  t.rounds += c.rounds.length
  c.rounds.forEach((round, i) => {
    t.cyclesByRound[i] = (t.cyclesByRound[i] ?? 0) + 1
    t.mediumPlusByRound[i] = (t.mediumPlusByRound[i] ?? 0) + (round.mediumPlus ?? 0)
  })
  for (const f of c.fullReviews) {
    t.fullReviews++
    if (f.mediumPlus === null) t.fullNoVerdict++
    else if (f.mediumPlus > 0) t.fullReopened++
  }
}

/** @param {number} a @param {number} b */
const avg = (a, b) => (b ? Math.round((a / b) * 10) / 10 : 0)

/** The section's lines. @param {DevelopTally} t @returns {string[]} */
export function renderDevelopSection(t) {
  const L = ['## DEVELOP — craft:develop cycles: rounds, convergence, the full review']
  const bad = t.unreadable ? [`- ⚠️ ${t.unreadable} develop record(s) unreadable — not counted`] : []
  if (!t.cycles) return [...L, '- NOT MEASURED — no develop cycle record in the store', ...bad]
  L.push(`- ${t.cycles} cycle(s) · ${t.converged} converged · ${t.capped} capped at the round limit · ${t.noVerdict} stopped without a verdict · light ${t.light} / full ${t.full}`)
  L.push(`- rounds per cycle: ${avg(t.rounds, t.cycles)} on average${t.converged ? ` · ${avg(t.convergedRounds, t.converged)} to converge` : ''}`)
  L.push(`- open Medium+ after each round (summed over the cycles that reached it): ${t.cyclesByRound.map((n, i) => `r${i + 1} ${t.mediumPlusByRound[i] ?? 0} in ${n}`).join(' · ')}`)
  L.push(t.fullReviews
    ? `- full review: ${t.fullReviews} run(s) · ${t.fullReopened} reopened the loop with open Medium+ · ${t.fullNoVerdict} without a verdict · ${t.fullReviews - t.fullReopened - t.fullNoVerdict} clean`
    : '- full review: none ran (no cycle converged, or none recorded one)')
  return [...L, ...bad]
}
