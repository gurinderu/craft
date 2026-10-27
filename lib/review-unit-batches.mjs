// unitScope's lens plan over unit batches (realm @nick/craft, #355): the candidate partitions, each estimated
// by the cost model (#353), the one chosen by #355's rule under a ceiling of one whole-diff lens agent's
// estimate, the lenses one sectioned agent runs per batch, and the estimate beside that of one agent per
// unit and lens. The strong lenses (tests, reconciler and every other sliceable lens) keep an agent each per
// batch; the weak code-intrinsic ones (safety, errors, concurrency, maintainability, weak by the #20 measure)
// share one.
import { sliceableLens, isShared, partitionOwned } from './lens-scope.mjs'
import { unitOf, unitSlices, sliceByUnit } from './unit-scope.mjs'
import { changedLinesOf } from './unit-batches.mjs'
import { costModelOf, estimatePlan, agentCost, batchFeatures } from './unit-cost.mjs'
import { candidatePartitions, choosePartition, CANDIDATE_BUDGETS } from './unit-candidates.mjs'

/**
 * @typedef {import('./unit-graph.mjs').Package} Package
 * @typedef {import('./unit-batches.mjs').Batch} Batch
 * @typedef {{ key: string, units: string[], files: number, changedLines: number, volume: number }} BatchRow
 * @typedef {{ name: string, budget: number | null, batches: string[], agents: number, total: number, heaviest: number, fits: boolean }} CandidateRow
 * @typedef {{ model: import('./unit-cost.mjs').CostModel, batchBudget: number | null, scope: string,
 *   batched: ReturnType<typeof estimatePlan>, perUnit: { agents: number, total: number },
 *   ceiling: { tokens: number, source: string } | null, candidates: CandidateRow[], chosen: string, reason: string }} CostEstimate
 */

const WEAK_LENSES = ['safety', 'errors', 'concurrency', 'maintainability']

/** @param {Batch} b @returns {BatchRow} */
const batchRow = b => ({ key: b.key, units: b.units ?? [b.unit ?? ''], files: b.files.filter(f => !isShared(f)).length, changedLines: b.changedLines ?? 0, volume: b.volume ?? 0 })

/**
 * The ceiling of #355: the estimate of the heaviest single-lens agent a normal review sends over the whole
 * change — every owned changed file, every touched unit — or `agentCeiling` when the run names one.
 * @param {{ model: import('./unit-cost.mjs').CostModel, lenses: string[], changedFiles: string[], touched: string[], owns: (f: string) => boolean, linesOf: (f: string) => number, packages: Package[], agentCeiling: number }} p
 */
function ceilingOf({ model, lenses, changedFiles, touched, owns, linesOf, packages, agentCeiling }) {
  if (agentCeiling > 0) return { tokens: agentCeiling, source: 'unitAgentCeiling' }
  const whole = { key: 'whole diff', files: partitionOwned(changedFiles, owns).owned }
  const f = batchFeatures(whole, touched, linesOf, packages)
  return { tokens: lenses.reduce((n, l) => Math.max(n, agentCost(model, [l], f)), 0), source: 'one whole-diff lens agent' }
}

/**
 * #355: every candidate partition estimated, the cheapest whose heaviest agent stays under the ceiling chosen;
 * a positive `batchBudget` pins the partition to its one budget.
 * @param {{ changedFiles: string[], roots: string[], packages: Package[], numstat: Map<string, number>, owns: (f: string) => boolean,
 *   batchBudget: number, estimate: (slices: Batch[]) => ReturnType<typeof estimatePlan>, ceilingFor: () => { tokens: number, source: string } }} p
 */
function chooseCandidate({ changedFiles, roots, packages, numstat, owns, batchBudget, estimate, ceilingFor }) {
  const cands = candidatePartitions(changedFiles, roots, { packages, numstat, owns, budgets: batchBudget > 0 ? [batchBudget] : CANDIDATE_BUDGETS })
  const scored = cands.map(c => ({ c, e: estimate(c.slices) }))
  const ceiling = ceilingFor()
  const pinned = batchBudget > 0 ? { name: `budget:${batchBudget}`, why: `unitBatchBudget=${batchBudget} pins the partition` } : null
  const { chosen, reason } = choosePartition(scored.map(({ c, e }) => ({ name: c.name, total: e.total, heaviest: e.heaviest })), ceiling.tokens, pinned)
  const pick = scored.find(x => x.c.name === chosen)
  return {
    slices: pick?.c.slices ?? [],
    estimate: {
      batchBudget: pick?.c.budget ?? null, batched: pick?.e ?? estimate([]), ceiling, chosen, reason,
      candidates: scored.map(({ c, e }) => ({ name: c.name, budget: c.budget, batches: c.slices.filter(b => b.unit).map(b => b.key), agents: e.agents, total: e.total, heaviest: e.heaviest, fits: e.heaviest <= ceiling.tokens })),
    },
  }
}

/**
 * @param {{ lenses: string[], changedFiles: string[], roots: string[], packages: Package[], numstat: Map<string, number>,
 *   owns: (f: string) => boolean, batched: boolean, batchBudget: number, agentCeiling?: number, costModel: unknown }} p
 * @returns {{ slices: Batch[], sectioned: string[], unitBatches: BatchRow[] | null, costEstimate: CostEstimate }}
 */
export function unitBatchPlan({ lenses, changedFiles, roots, packages, numstat, owns, batched, batchBudget, agentCeiling = 0, costModel }) {
  const sliced = lenses.filter(sliceableLens)
  const weak = sliced.filter(l => WEAK_LENSES.includes(l))
  const sectioned = batched && weak.length > 1 ? weak : []
  const linesOf = changedLinesOf(numstat)
  const touched = [...new Set(changedFiles.map(f => unitOf(f, roots)).filter(Boolean))].sort()
  const changedOf = (/** @type {string} */ c) => {
    const fs = changedFiles.filter(f => unitOf(f, roots) === c && !isShared(f))
    return { lines: fs.reduce((n, f) => n + linesOf(f), 0), files: fs.length }
  }
  const model = costModelOf(costModel)
  const estimate = (/** @type {Batch[]} */ batches, /** @type {string[][]} */ lensGroups) => estimatePlan({ batches: batches.filter(u => u.unit), lensGroups, units: touched, changedOf, linesOf, packages, model })
  const groups = [...sliced.filter(l => !sectioned.includes(l)).map(l => [l]), ...(sectioned.length ? [sectioned] : [])]
  // The comparison is one agent per unit (or module) slice and lens whatever the diff's size — not the
  // dispatch's "do not slice" of a small or one-unit diff, which would leave only the contract agents.
  const one = estimate(unitSlices(changedFiles, roots, { owns }), sliced.map(l => [l]))
  const base = { model, scope: 'round-1 unit-lens and contract agents', perUnit: { agents: one.agents, total: one.total } }
  if (!batched) {
    const perUnitSlices = sliceByUnit(changedFiles, roots, { owns })
    return { slices: perUnitSlices, sectioned, unitBatches: null, costEstimate: { ...base, batchBudget: null, batched: estimate(perUnitSlices, groups), ceiling: null, candidates: [], chosen: 'per-unit', reason: 'unitBatches=false' } }
  }
  const { slices, estimate: chosen } = chooseCandidate({ changedFiles, roots, packages, numstat, owns, batchBudget, estimate: c => estimate(c, groups), ceilingFor: () => ceilingOf({ model, lenses: sliced, changedFiles, touched, owns, linesOf, packages, agentCeiling }) })
  return { slices, sectioned, unitBatches: slices.filter(b => b.unit).map(batchRow), costEstimate: { ...base, ...chosen } }
}
