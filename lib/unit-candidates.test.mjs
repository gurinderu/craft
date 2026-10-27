// lib/unit-candidates.mjs: the candidate partitions of a unitScope review and the choice among them by
// cost estimate (realm @nick/craft, #355).
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { candidatePartitions, choosePartition } from './unit-candidates.mjs'
import { parsePackageLines } from './unit-graph.mjs'

/** @param {string} dir @param {number} n */
const rs = (dir, n) => Array.from({ length: n }, (_v, i) => `${dir}/src/f${i}.rs`)
const owns = (/** @type {string} */ f) => f.endsWith('.rs')
// a—b—c a chain, d alone, plus a file in no unit.
const FILES = [...rs('crates/a', 3), ...rs('crates/b', 3), ...rs('crates/c', 3), ...rs('crates/d', 3), 'tools/x.rs', 'Cargo.lock']
const PACKAGES = parsePackageLines(['@@ crates/a 10 0 a', '@@ crates/b 10 0 b a', '@@ crates/c 10 0 c b', '@@ crates/d 10 0 d'])
const ROOTS = PACKAGES.map(p => p.root)
const NUMSTAT = new Map(FILES.map(f => [f, 10]))

test('candidatePartitions: per-unit, components, one per budget along the edges, one batch — loose files in each', () => {
  const cs = candidatePartitions(FILES, ROOTS, { packages: PACKAGES, numstat: NUMSTAT, owns, budgets: [60, 30] })
  const keys = (/** @type {string} */ name) => cs.find(c => c.name === name)?.slices.map(s => s.key)
  assert.deepEqual(cs.map(c => [c.name, c.budget]), [['per-unit', null], ['components', null], ['budget:30', 30], ['budget:60', 60], ['one-batch', null]])
  assert.deepEqual(keys('per-unit'), ['unit:crates/a', 'unit:crates/b', 'unit:crates/c', 'unit:crates/d', 'outside units'])
  assert.deepEqual(keys('components'), ['unit:crates/a unit:crates/b unit:crates/c', 'unit:crates/d', 'outside units'])
  // At 60 lines the chain is cut along an edge: a with b; c, left alone, is packed by volume with d.
  assert.deepEqual(cs.find(c => c.name === 'budget:60')?.slices.filter(s => s.unit).map(s => s.units), [['crates/a', 'crates/b'], ['crates/c', 'crates/d']])
  assert.deepEqual(keys('one-batch'), ['unit:crates/a unit:crates/b unit:crates/c unit:crates/d', 'outside units'])
  for (const c of cs) for (const s of c.slices) assert.ok(s.files.includes('Cargo.lock'), `${c.name}: shared files ride on every slice`)
  const one = cs.at(-1)?.slices[0]
  assert.deepEqual([one?.changedLines, one?.volume, one?.unit], [120, 120, 'crates/a'])
})

test('candidatePartitions: [] with too few owned files or no unit', () => {
  assert.deepEqual(candidatePartitions(rs('crates/a', 3), ROOTS, { packages: PACKAGES, numstat: NUMSTAT, owns, budgets: [60] }), [])
  assert.deepEqual(candidatePartitions(rs('tools', 12), ROOTS, { packages: PACKAGES, numstat: NUMSTAT, owns, budgets: [60] }), [])
})

const ROWS = [
  { name: 'per-unit', total: 900, heaviest: 100 },
  { name: 'components', total: 700, heaviest: 300 },
  { name: 'budget:60', total: 700, heaviest: 200 },
  { name: 'one-batch', total: 500, heaviest: 600 },
]

test('choosePartition: the lowest total among the candidates at or under the ceiling, the earlier on a tie', () => {
  assert.deepEqual(choosePartition(ROWS, 300), { chosen: 'components', reason: 'lowest estimated total (700 tokens) of the 3 of 4 candidates whose heaviest agent is at or under the ceiling (300)' })
  assert.equal(choosePartition(ROWS, 600).chosen, 'one-batch')
  assert.equal(choosePartition(ROWS, 250).chosen, 'budget:60')
})

test('choosePartition: none under the ceiling — the lightest heaviest agent; a pin wins when it names a candidate', () => {
  assert.deepEqual(choosePartition(ROWS, 50), { chosen: 'per-unit', reason: 'no candidate\'s heaviest agent is at or under the ceiling (50); the one whose heaviest agent is lightest (100 tokens)' })
  assert.deepEqual(choosePartition(ROWS, 50, { name: 'budget:60', why: 'pinned' }), { chosen: 'budget:60', reason: 'pinned' })
  assert.equal(choosePartition(ROWS, 300, { name: 'budget:99', why: 'pinned' }).chosen, 'components', 'a pin naming no candidate is ignored')
  assert.deepEqual(choosePartition([], 10), { chosen: '', reason: 'no candidate' })
})
