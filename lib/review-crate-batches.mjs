// crateScope's lens plan over crate batches (realm @nick/craft, #355): the batches, the lenses one sectioned
// agent runs per batch, and the cost estimate of the plan beside that of one agent per crate and lens (#353).
// The strong lenses (tests, reconciler and every other sliceable lens) keep an agent each per batch; the
// weak code-intrinsic ones (safety, errors, concurrency, maintainability, weak by the #20 measure) share one.
import { sliceableLens, isShared } from './lens-scope.mjs'
import { crateOf, crateSlices, sliceByCrate } from './crate-scope.mjs'
import { batchByCrate, changedLinesOf, PLACEHOLDER_BATCH_BUDGET } from './crate-batches.mjs'
import { costModelOf, estimatePlan } from './crate-cost.mjs'

/**
 * @typedef {import('./crate-manifests.mjs').Package} Package
 * @typedef {import('./crate-batches.mjs').Batch} Batch
 * @typedef {{ key: string, crates: string[], files: number, changedLines: number, volume: number }} BatchRow
 * @typedef {{ model: import('./crate-cost.mjs').CostModel, batchBudget: number, scope: string,
 *   batched: ReturnType<typeof estimatePlan>, perCrate: { agents: number, total: number } }} CostEstimate
 */

const WEAK_LENSES = ['safety', 'errors', 'concurrency', 'maintainability']

/**
 * @param {{ lenses: string[], changedFiles: string[], roots: string[], packages: Package[], numstat: Map<string, number>,
 *   owns: (f: string) => boolean, batched: boolean, batchBudget: number, costModel: unknown }} p
 * @returns {{ slices: Batch[], sectioned: string[], crateBatches: BatchRow[] | null, costEstimate: CostEstimate }}
 */
export function crateBatchPlan({ lenses, changedFiles, roots, packages, numstat, owns, batched, batchBudget, costModel }) {
  const cap = batchBudget > 0 ? batchBudget : PLACEHOLDER_BATCH_BUDGET
  const perCrate = sliceByCrate(changedFiles, roots, { owns })
  const slices = batched ? batchByCrate(changedFiles, roots, { packages, numstat, batchBudget: cap, owns }) : perCrate
  const sliced = lenses.filter(sliceableLens)
  const weak = sliced.filter(l => WEAK_LENSES.includes(l))
  const sectioned = batched && weak.length > 1 ? weak : []
  const linesOf = changedLinesOf(numstat)
  const touched = [...new Set(changedFiles.map(f => crateOf(f, roots)).filter(Boolean))].sort()
  const changedOf = (/** @type {string} */ c) => changedFiles.filter(f => crateOf(f, roots) === c && !isShared(f)).reduce((n, f) => n + linesOf(f), 0)
  const model = costModelOf(costModel)
  const estimate = (/** @type {Batch[]} */ units, /** @type {string[][]} */ lensGroups) => estimatePlan({ units: units.filter(u => u.crate), lensGroups, crates: touched, changedOf, linesOf, packages, model })
  const groups = [...sliced.filter(l => !sectioned.includes(l)).map(l => [l]), ...(sectioned.length ? [sectioned] : [])]
  // The comparison is one agent per crate (or module) slice and lens whatever the diff's size — not the
  // dispatch's "do not slice" of a small or one-crate diff, which would leave only the contract agents.
  const one = estimate(crateSlices(changedFiles, roots, { owns }), sliced.map(l => [l]))
  return {
    slices,
    sectioned,
    crateBatches: batched ? slices.filter(b => b.crate).map(b => ({ key: b.key, crates: b.crates ?? [b.crate ?? ''], files: b.files.filter(f => !isShared(f)).length, changedLines: b.changedLines ?? 0, volume: b.volume ?? 0 })) : null,
    costEstimate: { model, batchBudget: cap, scope: 'round-1 crate-lens and contract agents', batched: estimate(slices, groups), perCrate: { agents: one.agents, total: one.total } },
  }
}
