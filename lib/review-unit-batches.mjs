// unitScope's lens plan over unit batches (realm @nick/craft, #355): the batches, the lenses one sectioned
// agent runs per batch, and the cost estimate of the plan beside that of one agent per unit and lens (#353).
// The strong lenses (tests, reconciler and every other sliceable lens) keep an agent each per batch; the
// weak code-intrinsic ones (safety, errors, concurrency, maintainability, weak by the #20 measure) share one.
import { sliceableLens, isShared } from './lens-scope.mjs'
import { unitOf, unitSlices, sliceByUnit } from './unit-scope.mjs'
import { batchByUnit, changedLinesOf, PLACEHOLDER_BATCH_BUDGET } from './unit-batches.mjs'
import { costModelOf, estimatePlan } from './unit-cost.mjs'

/**
 * @typedef {import('./unit-graph.mjs').Package} Package
 * @typedef {import('./unit-batches.mjs').Batch} Batch
 * @typedef {{ key: string, units: string[], files: number, changedLines: number, volume: number }} BatchRow
 * @typedef {{ model: import('./unit-cost.mjs').CostModel, batchBudget: number, scope: string,
 *   batched: ReturnType<typeof estimatePlan>, perUnit: { agents: number, total: number } }} CostEstimate
 */

const WEAK_LENSES = ['safety', 'errors', 'concurrency', 'maintainability']

/**
 * @param {{ lenses: string[], changedFiles: string[], roots: string[], packages: Package[], numstat: Map<string, number>,
 *   owns: (f: string) => boolean, batched: boolean, batchBudget: number, costModel: unknown }} p
 * @returns {{ slices: Batch[], sectioned: string[], unitBatches: BatchRow[] | null, costEstimate: CostEstimate }}
 */
export function unitBatchPlan({ lenses, changedFiles, roots, packages, numstat, owns, batched, batchBudget, costModel }) {
  const cap = batchBudget > 0 ? batchBudget : PLACEHOLDER_BATCH_BUDGET
  const perUnit = sliceByUnit(changedFiles, roots, { owns })
  const slices = batched ? batchByUnit(changedFiles, roots, { packages, numstat, batchBudget: cap, owns }) : perUnit
  const sliced = lenses.filter(sliceableLens)
  const weak = sliced.filter(l => WEAK_LENSES.includes(l))
  const sectioned = batched && weak.length > 1 ? weak : []
  const linesOf = changedLinesOf(numstat)
  const touched = [...new Set(changedFiles.map(f => unitOf(f, roots)).filter(Boolean))].sort()
  const changedOf = (/** @type {string} */ c) => changedFiles.filter(f => unitOf(f, roots) === c && !isShared(f)).reduce((n, f) => n + linesOf(f), 0)
  const model = costModelOf(costModel)
  const estimate = (/** @type {Batch[]} */ batches, /** @type {string[][]} */ lensGroups) => estimatePlan({ batches: batches.filter(u => u.unit), lensGroups, units: touched, changedOf, linesOf, packages, model })
  const groups = [...sliced.filter(l => !sectioned.includes(l)).map(l => [l]), ...(sectioned.length ? [sectioned] : [])]
  // The comparison is one agent per unit (or module) slice and lens whatever the diff's size — not the
  // dispatch's "do not slice" of a small or one-unit diff, which would leave only the contract agents.
  const one = estimate(unitSlices(changedFiles, roots, { owns }), sliced.map(l => [l]))
  return {
    slices,
    sectioned,
    unitBatches: batched ? slices.filter(b => b.unit).map(b => ({ key: b.key, units: b.units ?? [b.unit ?? ''], files: b.files.filter(f => !isShared(f)).length, changedLines: b.changedLines ?? 0, volume: b.volume ?? 0 })) : null,
    costEstimate: { model, batchBudget: cap, scope: 'round-1 unit-lens and contract agents', batched: estimate(slices, groups), perUnit: { agents: one.agents, total: one.total } },
  }
}
