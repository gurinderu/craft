// unitScope's lens plan over unit batches (realm @nick/craft, #355): the candidate partitions, each estimated
// by the cost model (#353), the one chosen by #355's rule under a ceiling of the heaviest sliced lens agent a
// normal review would send, and the estimate beside that of one agent per unit and lens. Every sliceable lens
// keeps an agent of its own per batch, as normal review gives each lens its own agent per slice (#355, #402).
import { sliceableLens, isShared, sliceDiff, partitionOwned } from './lens-scope.mjs'
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
 *   ceiling: Ceiling | null, candidates: CandidateRow[], chosen: string, reason: string }} CostEstimate
 * @typedef {{ tokens: number, source: string, lens?: string, slice?: string }} Ceiling
 */

/** @param {Batch} b @returns {BatchRow} */
const batchRow = b => ({ key: b.key, units: b.units ?? [b.unit ?? ''], files: b.files.filter(f => !isShared(f)).length, changedLines: b.changedLines ?? 0, volume: b.volume ?? 0 })

/**
 * The ceiling of #355: the estimate of the heaviest sliced lens agent a normal review sends — each sliceable
 * lens of the run over each slice of the directory slicing (lib/lens-scope.mjs sliceDiff), or over the whole
 * change when that slicing says "do not slice" — or `agentCeiling` when the run names one. The whole-diff
 * lenses (intent, negative-space…) set no ceiling: they are not batched, and a ceiling from them admitted the
 * whole diff as one batch (#402). A unit-mode lens agent gets no more diff than a normal-review slice.
 * @param {{ model: import('./unit-cost.mjs').CostModel, sliced: string[], changedFiles: string[], roots: string[], owns: (f: string) => boolean, linesOf: (f: string) => number, packages: Package[], agentCeiling: number }} p
 * @returns {Ceiling}
 */
export function ceilingOf({ model, sliced, changedFiles, roots, owns, linesOf, packages, agentCeiling }) {
  if (agentCeiling > 0) return { tokens: agentCeiling, source: 'unitAgentCeiling' }
  const slices = sliceDiff(changedFiles, { owns })
  const parts = slices.length ? slices : [{ key: 'whole diff', files: partitionOwned(changedFiles, owns).owned }]
  /** @type {Ceiling} */
  let top = { tokens: 0, source: 'normal-review slice lens agent' }
  for (const s of parts) {
    const units = [...new Set(s.files.filter(x => !isShared(x)).map(x => unitOf(x, roots)).filter(Boolean))].sort()
    const features = batchFeatures(s, units, linesOf, packages)
    for (const lens of sliced) {
      const tokens = agentCost(model, [lens], features)
      if (tokens > top.tokens) top = { tokens, source: 'normal-review slice lens agent', lens, slice: s.key }
    }
  }
  return top
}

/**
 * #355: every candidate partition estimated, the cheapest whose heaviest agent stays under the ceiling chosen;
 * a positive `batchBudget` pins the partition to its one budget.
 * @param {{ changedFiles: string[], roots: string[], packages: Package[], numstat: Map<string, number>, owns: (f: string) => boolean,
 *   batchBudget: number, estimate: (slices: Batch[]) => ReturnType<typeof estimatePlan>, ceilingFor: () => Ceiling }} p
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
 * @returns {{ slices: Batch[], unitBatches: BatchRow[] | null, costEstimate: CostEstimate }}
 */
export function unitBatchPlan({ lenses, changedFiles, roots, packages, numstat, owns, batched, batchBudget, agentCeiling = 0, costModel }) {
  const sliced = lenses.filter(sliceableLens)
  const linesOf = changedLinesOf(numstat)
  const touched = [...new Set(changedFiles.map(f => unitOf(f, roots)).filter(Boolean))].sort()
  const changedOf = (/** @type {string} */ c) => {
    const fs = changedFiles.filter(f => unitOf(f, roots) === c && !isShared(f))
    return { lines: fs.reduce((n, f) => n + linesOf(f), 0), files: fs.length }
  }
  const model = costModelOf(costModel)
  // One agent per lens per batch, as normal review sends one per lens per slice (#355).
  const estimate = (/** @type {Batch[]} */ batches) => estimatePlan({ batches: batches.filter(u => u.unit), lensGroups: sliced.map(l => [l]), units: touched, changedOf, linesOf, packages, model })
  // The comparison is one agent per unit (or module) slice and lens whatever the diff's size — not the
  // dispatch's "do not slice" of a small or one-unit diff, which would leave only the contract agents.
  const one = estimate(unitSlices(changedFiles, roots, { owns }))
  const base = { model, scope: 'round-1 unit-lens and contract agents', perUnit: { agents: one.agents, total: one.total } }
  if (!batched) {
    const perUnitSlices = sliceByUnit(changedFiles, roots, { owns })
    return { slices: perUnitSlices, unitBatches: null, costEstimate: { ...base, batchBudget: null, batched: estimate(perUnitSlices), ceiling: null, candidates: [], chosen: 'per-unit', reason: 'unitBatches=false' } }
  }
  const { slices, estimate: chosen } = chooseCandidate({ changedFiles, roots, packages, numstat, owns, batchBudget, estimate, ceilingFor: () => ceilingOf({ model, sliced, changedFiles, roots, owns, linesOf, packages, agentCeiling }) })
  return { slices, unitBatches: slices.filter(b => b.unit).map(batchRow), costEstimate: { ...base, ...chosen } }
}
