// The DEPTH section of analyze-runs (realm @nick/craft, node #295): craft:review's light runs (one round,
// no whole-diff lens, Medium and above verified) beside its full ones, so the two can be compared. A
// light run is kept out of the cost and surface-gate populations, whose numbers assume the full plan;
// a record without `depth` was written before the field existed and counts as full. Each chain — the JS
// engine's and the Rust CLI's (lib/run-record.mjs, reviewChain) — is its own population, never averaged
// with the other.
import { isReviewRun, reviewChain } from './run-record.mjs'

/** @param {object | null | undefined} r @returns {boolean} */
export function isLightRun(r) {
  return !!r && /** @type {{ depth?: unknown }} */ (r).depth === 'light'
}

/** @typedef {{ runs: number, agents: number, agentRuns: number, minutes: number, minuteRuns: number, confirmed: number, confirmedRuns: number }} DepthPopulation */
/** @typedef {{ light: DepthPopulation, full: DepthPopulation }} DepthPair */
/** @typedef {{ js: DepthPair, cli: DepthPair }} DepthTally */

/** @returns {DepthPopulation} */
function newPopulation() {
  return { runs: 0, agents: 0, agentRuns: 0, minutes: 0, minuteRuns: 0, confirmed: 0, confirmedRuns: 0 }
}

/** @returns {DepthTally} */
export function newDepthTally() {
  return { js: { light: newPopulation(), full: newPopulation() }, cli: { light: newPopulation(), full: newPopulation() } }
}

// Adds one craft:review record to its chain's and depth's population; what a record does not carry is not
// counted as zero, so each average has its own denominator.
/** @param {DepthTally} t @param {{ name?: unknown, driver?: unknown, depth?: unknown, runtimeStats?: { agents?: unknown, wallClockMinutes?: unknown } | null, verification?: { confirmed?: unknown } | null }} r @returns {void} */
export function tallyDepth(t, r) {
  if (!isReviewRun(r)) return
  const chain = t[reviewChain(r)]
  const p = isLightRun(r) ? chain.light : chain.full
  p.runs++
  const agents = r.runtimeStats?.agents
  if (typeof agents === 'number') { p.agents += agents; p.agentRuns++ }
  const minutes = r.runtimeStats?.wallClockMinutes
  if (typeof minutes === 'number') { p.minutes += minutes; p.minuteRuns++ }
  const confirmed = r.verification?.confirmed
  if (typeof confirmed === 'number') { p.confirmed += confirmed; p.confirmedRuns++ }
}

/** @param {number} sum @param {number} n */
const per = (sum, n) => (n ? String(Math.round((sum / n) * 10) / 10) : 'not measured')

/** @param {string} name @param {DepthPopulation} p */
function populationLine(name, p) {
  return `- ${name}: ${p.runs} run(s), agents/run ${per(p.agents, p.agentRuns)}, wall min/run ${per(p.minutes, p.minuteRuns)}, confirmed/run ${per(p.confirmed, p.confirmedRuns)}`
}

/** One chain's lines. @param {string} who @param {DepthPair} t @returns {string[]} */
function chainSection(who, t) {
  const L = [`## DEPTH -- craft:review (${who}) light runs beside full ones (light runs are outside the cost and surface-gate figures)`]
  if (!t.full.runs && !t.light.runs) return [...L, `- NOT MEASURED -- no ${who} review run in the store`]
  if (!t.light.runs) return [...L, populationLine('full', t.full), '- light: NOT MEASURED -- no light run in the store']
  return [...L, populationLine('full', t.full), populationLine('light', t.light)]
}

/** The section's lines: the JS engine's runs, then the CLI's. @param {DepthTally} t @returns {string[]} */
export function renderDepthSection(t) {
  return [...chainSection('JS engine', t.js), '', ...chainSection('CLI', t.cli)]
}
