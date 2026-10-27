// The candidate partitions of a unitScope review into batches, and the choice among them by cost estimate
// (realm @nick/craft, #355): one agent per unit; the dependency-connected components split along their edges
// at several volume budgets (lib/unit-batches.mjs). No unbounded candidate (whole components, one batch): the
// linear cost model has no term for focus, so the largest batches always win — the volume budget keeps focus.
// A component is split along its edges, and small unconnected units are packed together by volume: the volume
// budget, not connectivity, keeps a batch focused (realm @nick/craft, #355). Files in no unit keep the directory
// slicing in every candidate. Deterministic: no model takes part in the choice.
import { partitionOwned } from './lens-scope.mjs'
import { looseGroups, UNIT_MIN_FILES } from './unit-scope.mjs'
import { batchByUnit, bucketByUnit, changedLinesOf, PLACEHOLDER_BATCH_BUDGET } from './unit-batches.mjs'
import { depSigLines } from './unit-graph.mjs'

/**
 * @typedef {import('./unit-graph.mjs').Package} Package
 * @typedef {import('./unit-batches.mjs').Batch} Batch
 * @typedef {{ name: string, budget: number | null, slices: Batch[] }} Candidate
 * @typedef {{ name: string, total: number, heaviest: number }} Scored
 */

// The volume budgets the split candidates are cut at: the placeholder budget, a third of it and three times.
export const CANDIDATE_BUDGETS = [PLACEHOLDER_BATCH_BUDGET / 3, PLACEHOLDER_BATCH_BUDGET, PLACEHOLDER_BATCH_BUDGET * 3]

/**
 * The candidates in a fixed order — per-unit, then budget:<B> ascending — each with its slices as
 * batchByUnit shapes them, none unbounded by a budget (#355); [] — "do not slice" — with fewer owned files
 * than `minFiles` or no unit.
 * @param {unknown} files @param {string[]} roots
 * @param {{ packages: Package[], numstat: Map<string, number>, budgets: number[], owns?: ((f: string) => boolean) | null, minFiles?: number, maxSlices?: number }} o
 * @returns {Candidate[]}
 */
export function candidatePartitions(files, roots, { packages, numstat, budgets, owns = null, minFiles = UNIT_MIN_FILES, maxSlices = 6 }) {
  const { shared, owned } = partitionOwned((Array.isArray(files) ? files : []).map(String).filter(Boolean), owns)
  if (owned.length < minFiles) return []
  const { byUnit, loose } = bucketByUnit(owned, roots)
  const units = [...byUnit.keys()].sort()
  if (!units.length) return []
  const lines = changedLinesOf(numstat)
  const rest = looseGroups(loose, shared, maxSlices, owns)
  /** @param {string[]} members @returns {Batch} */
  const batch = members => {
    const fs = members.flatMap(r => byUnit.get(r) || [])
    const changedLines = fs.reduce((n, f) => n + lines(f), 0)
    return { key: members.map(r => `unit:${r}`).join(' '), files: [...fs, ...shared], unit: String(members[0]), units: members, changedLines, volume: changedLines + depSigLines(members, packages) }
  }
  /** @param {string[][]} groups */
  const of = groups => [...groups.map(g => batch([...g].sort())).sort((a, b) => a.key.localeCompare(b.key)), ...rest]
  return [
    { name: 'per-unit', budget: null, slices: of(units.map(r => [r])) },
    ...[...budgets].sort((a, b) => a - b).map(b => ({ name: `budget:${b}`, budget: b, slices: batchByUnit(files, roots, { packages, numstat, batchBudget: b, owns, minFiles, maxSlices }) })),
  ]
}

/**
 * The choice by #355: the candidate with the lowest estimated total whose heaviest agent is at or under
 * `ceiling`; none fits — the one whose heaviest agent is lightest. A tie keeps the earlier candidate.
 * `pinned` (a candidate's name) is taken as it is, its reason given by the caller.
 * @param {Scored[]} rows @param {number} ceiling @param {{ name: string, why: string } | null} [pinned]
 * @returns {{ chosen: string, reason: string }}
 */
export function choosePartition(rows, ceiling, pinned = null) {
  if (pinned && rows.some(r => r.name === pinned.name)) return { chosen: pinned.name, reason: pinned.why }
  const fits = rows.filter(r => r.heaviest <= ceiling)
  /** @param {Scored[]} rs @param {(r: Scored) => number} by */
  const least = (rs, by) => rs.reduce((m, r) => (by(r) < by(m) ? r : m))
  if (fits.length) {
    const best = least(fits, x => x.total)
    return { chosen: best.name, reason: `lowest estimated total (${best.total} tokens) of the ${fits.length} of ${rows.length} candidates whose heaviest agent is at or under the ceiling (${ceiling})` }
  }
  if (!rows.length) return { chosen: '', reason: 'no candidate' }
  const lightest = least(rows, x => x.heaviest)
  return { chosen: lightest.name, reason: `no candidate's heaviest agent is at or under the ceiling (${ceiling}); the one whose heaviest agent is lightest (${lightest.heaviest} tokens)` }
}
