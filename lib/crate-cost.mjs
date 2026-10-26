// The cost estimate of a crateScope lens plan before dispatch (realm @nick/craft, #353): per agent, a fixed
// part plus coefficients on what it judges (the changed lines of its unit), what it may read (the code lines
// of its crates) and the pub signatures of their dependencies; summed over the plan's agents. The record
// keeps it beside the run's real cost (#99), so the coefficients can be fitted from the pairs (#356).
import { depSigLines } from './crate-manifests.mjs'
import { isShared } from './lens-scope.mjs'

/**
 * @typedef {{ fixed: number, perChangedLine: number, perCodeLine: number, perSigLine: number }} CostModel
 * @typedef {import('./crate-manifests.mjs').Package} Package
 * @typedef {import('./crate-batches.mjs').Batch} Batch
 * @typedef {{ unit: string, lenses: string[], changedLines: number, codeLines: number, sigLines: number, estimate: number }} AgentEstimate
 */

// Placeholder coefficients, in tokens, NOT fitted: the model is being fitted from the run store (#356).
/** @type {Readonly<CostModel>} */
const PLACEHOLDER_COST_MODEL = Object.freeze({ fixed: 400000, perChangedLine: 300, perCodeLine: 2, perSigLine: 20 })

/** A cost model from the `costModel` argument: each finite non-negative number it names over the placeholder. @param {unknown} arg @returns {CostModel} */
export function costModelOf(arg) {
  const a = arg && typeof arg === 'object' ? /** @type {Record<string, unknown>} */ (arg) : {}
  const pick = (/** @type {keyof CostModel} */ k) => (typeof a[k] === 'number' && Number.isFinite(a[k]) && Number(a[k]) >= 0 ? Number(a[k]) : PLACEHOLDER_COST_MODEL[k])
  return { fixed: pick('fixed'), perChangedLine: pick('perChangedLine'), perCodeLine: pick('perCodeLine'), perSigLine: pick('perSigLine') }
}

/** One agent's estimate. @param {CostModel} m @param {{ changedLines: number, codeLines: number, sigLines: number }} f */
const agentCost = (m, f) => Math.round(m.fixed + m.perChangedLine * f.changedLines + m.perCodeLine * f.codeLines + m.perSigLine * f.sigLines)

/**
 * The estimate of one lens plan over crate units: each unit gets one agent per lens of `lensGroups` (a group
 * of several lenses is one sectioned agent), and each touched crate one contract agent (signatures only).
 * A unit outside every crate is left out — it is dispatched as before batching.
 * @param {{ units: Batch[], lensGroups: string[][], crates: string[], changedOf: (root: string) => number, linesOf: (file: string) => number, packages: Package[], model: CostModel }} p
 * @returns {{ agents: number, total: number, perAgent: AgentEstimate[] }}
 */
export function estimatePlan({ units, lensGroups, crates, changedOf, linesOf, packages, model }) {
  const byRoot = new Map(packages.map(p => [p.root, p]))
  /** @type {AgentEstimate[]} */
  const perAgent = []
  for (const u of units) {
    const roots = u.crates?.length ? u.crates : u.crate ? [u.crate] : []
    if (!roots.length) continue
    const f = { changedLines: u.files.filter(x => !isShared(x)).reduce((n, x) => n + linesOf(x), 0), codeLines: roots.reduce((n, r) => n + (byRoot.get(r)?.codeLines ?? 0), 0), sigLines: depSigLines(roots, packages) }
    for (const lenses of lensGroups) perAgent.push({ unit: u.key, lenses, ...f, estimate: agentCost(model, f) })
  }
  for (const c of crates) {
    const f = { changedLines: changedOf(c), codeLines: 0, sigLines: byRoot.get(c)?.sigLines ?? 0 }
    perAgent.push({ unit: `crate:${c}`, lenses: ['contract'], ...f, estimate: agentCost(model, f) })
  }
  return { agents: perAgent.length, total: perAgent.reduce((n, a) => n + a.estimate, 0), perAgent }
}
