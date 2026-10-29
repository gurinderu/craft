// The cost estimate of a unitScope lens plan before dispatch (realm @nick/craft, #353): per lens × per unit.
// Each touched unit has a diff cost — from its changed lines and files, its code lines and the public
// signature lines of its dependencies; each lens kind a fixed part and a rate on that diff cost. The review
// sends one agent per lens per batch (#355); an agent costs agentFixed once, plus its lens's fixed part and
// its rate times the summed diff cost of its batch's units (the estimator also prices a group of lenses as
// one agent, each lens's part added). The record keeps the estimate
// beside the run's real cost (#99), so the coefficients can be refitted from the pairs (#356).
import { depSigLines } from './unit-graph.mjs'
import { isShared } from './lens-scope.mjs'

/**
 * @typedef {{ perChangedLine: number, perFile: number, perCodeLine: number, perSigLine: number }} UnitRates
 * @typedef {{ fixed: number, rate: number }} LensCost
 * @typedef {{ agentFixed: number, unit: UnitRates, lenses: Record<string, LensCost>, pooled: LensCost }} CostModel
 * @typedef {import('./unit-graph.mjs').Package} Package
 * @typedef {import('./unit-batches.mjs').Batch} Batch
 * @typedef {{ changedLines: number, files: number, codeLines: number, sigLines: number }} DiffFeatures
 * @typedef {DiffFeatures & { batch: string, lenses: string[], estimate: number }} AgentEstimate
 */

// Fitted on 1555 returned Rust lens agents of 49 review runs in the run store, one repository (realm
// @nick/craft, node #356): least squares of an agent's deduplicated tokens on its slice's changed lines and
// files, pooled, then a fixed part and a rate per lens on that diff cost. agentFixed is the smallest fitted
// lens intercept (every agent in the data ran one lens, so the shared overhead cannot be told from the lens's own). Code lines
// and signature lines are 0: one crate and a constant dependency surface in the data, not identifiable.
// api-boundary, api-idioms and performance had 11 agents each, under 30 — they and every other lens take the
// pooled cost. Held-out error, each run left out in turn: per agent |err| median 39%, p90 174%; per run sum
// median 24%, p90 108%. `costModel` overrides any part.
/** @type {Readonly<CostModel>} */
const FITTED_COST_MODEL = Object.freeze({
  agentFixed: 198065,
  unit: Object.freeze({ perChangedLine: 169.2, perFile: 4855.7, perCodeLine: 0, perSigLine: 0 }),
  lenses: Object.freeze({
    compat: { fixed: 64421, rate: 1.207 }, concurrency: { fixed: 98849, rate: 0.285 }, errors: { fixed: 0, rate: 1.133 },
    'failure-windows': { fixed: 421945, rate: 0.361 }, intent: { fixed: 874501, rate: 1.375 }, invariants: { fixed: 166296, rate: 1.489 },
    maintainability: { fixed: 26097, rate: 0.534 }, 'negative-space': { fixed: 1172551, rate: 1.55 }, reconciler: { fixed: 509054, rate: 0.452 },
    safety: { fixed: 211220, rate: 0.462 }, tests: { fixed: 175921, rate: 1.672 },
  }),
  pooled: Object.freeze({ fixed: 275570, rate: 1 }),
})

/** A finite non-negative number, else `dflt`. @param {unknown} v @param {number} dflt */
const num = (v, dflt) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : dflt)
/** @param {unknown} v @returns {Record<string, unknown>} */
const obj = v => (v && typeof v === 'object' && !Array.isArray(v) ? /** @type {Record<string, unknown>} */ (v) : {})
/** @param {unknown} v @param {LensCost} d @returns {LensCost} */
const lensOf = (v, d) => ({ fixed: num(obj(v)['fixed'], d.fixed), rate: num(obj(v)['rate'], d.rate) })

/**
 * A cost model from the `costModel` argument: each finite non-negative number it names — agentFixed,
 * unit.{perChangedLine, perFile, perCodeLine, perSigLine}, lenses.<lens>.{fixed, rate}, pooled.{fixed, rate}
 * — over the fitted one. @param {unknown} arg @returns {CostModel}
 */
export function costModelOf(arg) {
  const a = obj(arg)
  const d = FITTED_COST_MODEL
  const u = obj(a['unit'])
  const given = obj(a['lenses'])
  /** @type {Record<string, LensCost>} */
  const lenses = {}
  for (const l of new Set([...Object.keys(d.lenses), ...Object.keys(given)])) lenses[l] = lensOf(given[l], d.lenses[l] ?? d.pooled)
  return {
    agentFixed: num(a['agentFixed'], d.agentFixed),
    unit: { perChangedLine: num(u['perChangedLine'], d.unit.perChangedLine), perFile: num(u['perFile'], d.unit.perFile), perCodeLine: num(u['perCodeLine'], d.unit.perCodeLine), perSigLine: num(u['perSigLine'], d.unit.perSigLine) },
    lenses,
    pooled: lensOf(a['pooled'], d.pooled),
  }
}

/** The diff cost of what an agent judges and may read. @param {CostModel} m @param {DiffFeatures} f */
export const diffCost = (m, f) => m.unit.perChangedLine * f.changedLines + m.unit.perFile * f.files + m.unit.perCodeLine * f.codeLines + m.unit.perSigLine * f.sigLines

/** One agent carrying `lenses` over a diff cost: agentFixed once, each lens's own part. @param {CostModel} m @param {string[]} lenses @param {DiffFeatures} f */
export function agentCost(m, lenses, f) {
  const d = diffCost(m, f)
  return Math.round(m.agentFixed + lenses.reduce((n, l) => { const c = m.lenses[l] ?? m.pooled; return n + c.fixed + c.rate * d }, 0))
}

/**
 * What one batch's agent judges and may read: its changed files outside the shared ones, the code lines of
 * its units, and each unit's dependency signature lines summed per unit.
 * @param {Batch} u @param {string[]} roots @param {(file: string) => number} linesOf @param {Package[]} packages @returns {DiffFeatures}
 */
export function batchFeatures(u, roots, linesOf, packages) {
  const byRoot = new Map(packages.map(p => [p.root, p]))
  const own = u.files.filter(x => !isShared(x))
  return { changedLines: own.reduce((n, x) => n + linesOf(x), 0), files: own.length, codeLines: roots.reduce((n, r) => n + (byRoot.get(r)?.codeLines ?? 0), 0), sigLines: roots.reduce((n, r) => n + depSigLines([r], packages), 0) }
}

/**
 * The estimate of one lens plan over unit batches: each batch gets one agent per lens group of `lensGroups`
 * (the review passes one lens per group: one agent per lens per batch), and each touched unit one contract agent (signatures
 * only). A batch outside every unit is left out — it is dispatched as before batching. `heaviest` is the
 * heaviest batch agent's estimate.
 * @param {{ batches: Batch[], lensGroups: string[][], units: string[], changedOf: (root: string) => { lines: number, files: number }, linesOf: (file: string) => number, packages: Package[], model: CostModel }} p
 * @returns {{ agents: number, total: number, heaviest: number, perAgent: AgentEstimate[] }}
 */
export function estimatePlan({ batches, lensGroups, units, changedOf, linesOf, packages, model }) {
  const byRoot = new Map(packages.map(p => [p.root, p]))
  /** @type {AgentEstimate[]} */
  const perAgent = []
  for (const u of batches) {
    const roots = u.units?.length ? u.units : u.unit ? [u.unit] : []
    if (!roots.length) continue
    const f = batchFeatures(u, roots, linesOf, packages)
    for (const lenses of lensGroups) perAgent.push({ batch: u.key, lenses, ...f, estimate: agentCost(model, lenses, f) })
  }
  // The heaviest batch agent: the contract agents are the same whatever the partition.
  const heaviest = perAgent.reduce((n, a) => Math.max(n, a.estimate), 0)
  for (const c of units) {
    const ch = changedOf(c)
    const f = { changedLines: ch.lines, files: ch.files, codeLines: 0, sigLines: byRoot.get(c)?.sigLines ?? 0 }
    perAgent.push({ batch: `unit:${c}`, lenses: ['contract'], ...f, estimate: agentCost(model, ['contract'], f) })
  }
  return { agents: perAgent.length, total: perAgent.reduce((n, a) => n + a.estimate, 0), heaviest, perAgent }
}
