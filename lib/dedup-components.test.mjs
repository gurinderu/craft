// The cross-lens dedup merges each connected component of same-spot and model groups into one
// finding (realm @nick/craft, node #405): unit, and through dedupPool on a pool shaped like the
// measured run whose nine-lens groups first-wins dropped.
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { mergeComponents, firstWins, noteComponents, withinTwoSteps, COMPONENT_MAX } from './dedup-components.mjs'
import { makeDedup } from './review-dedup.mjs'
import { lensAgreed } from './lens-agreement.mjs'

const never = () => false

test('mergeComponents: a pair and a model group sharing members are one component', () => {
  const { groups, fellBack } = mergeComponents(6, [[0, 1]], [[0, 1, 2, 3]], never)
  assert.deepEqual(groups, [[0, 1, 2, 3]])
  assert.deepEqual(fellBack, [])
})

test('mergeComponents: chained model groups join, disjoint ones stay apart, singletons are left out', () => {
  const { groups } = mergeComponents(8, [[6, 7]], [[0, 1], [1, 2], [4, 5]], never)
  assert.deepEqual(groups.map(g => g.slice().sort()), [[0, 1, 2], [4, 5], [6, 7]])
})

test('mergeComponents: an oversized or tool-distinct component falls back to first-wins, never splitting a pair', () => {
  const n = COMPONENT_MAX + 2
  const chain = Array.from({ length: n - 1 }, (_u, i) => [i, i + 1])
  const big = mergeComponents(n, [[0, 1]], chain, never)
  assert.equal(big.fellBack.length, 1)
  assert.deepEqual(big.groups[0], [0, 1], 'the pair goes first and stays whole')
  const distinct = mergeComponents(4, [[0, 1]], [[1, 2, 3]], m => m.includes(3))
  assert.deepEqual(distinct.groups, [[0, 1]])
  assert.deepEqual(distinct.fellBack, [[0, 1, 2, 3]])
})

test('mergeComponents: a 20-member cluster of one model group and the pairs inside it merges to one', () => {
  const pairs = [[0, 1], [5, 6], [10, 11]]
  const model = [Array.from({ length: 20 }, (_u, i) => i), [3, 4]]
  const { groups, fellBack, sizes } = mergeComponents(20, pairs, model, never)
  assert.equal(groups.length, 1)
  assert.equal(/** @type {number[]} */ (groups[0]).length, 20)
  assert.deepEqual(fellBack, [])
  assert.deepEqual(sizes, [20])
})

test('mergeComponents: a three-step chain of unrelated findings is not merged whole', () => {
  const { groups, fellBack } = mergeComponents(4, [], [[0, 1], [1, 2], [2, 3]], never)
  assert.deepEqual(groups, [[0, 1], [2, 3]])
  assert.deepEqual(fellBack, [[0, 1, 2, 3]])
  assert.equal(withinTwoSteps([0, 1, 2], [[0, 1], [1, 2]]), true)
  assert.equal(withinTwoSteps([0, 1, 2, 3], [[0, 1], [1, 2], [2, 3]]), false)
})

test('noteComponents: the run tally keeps the largest component, those over twelve and the fallbacks', () => {
  const tally = { largest: 0, overTwelve: 0, fellBack: 0 }
  noteComponents(tally, [3, 20, 13], 0)
  noteComponents(tally, [], 1)
  assert.deepEqual(tally, { largest: 20, overTwelve: 2, fellBack: 1 })
})

test('firstWins: the earlier group keeps an index both name', () => {
  assert.deepEqual(firstWins([[0, 1], [1, 2], [3, 4]]), [[0, 1], [3, 4]])
})

const SEV_RANK = { Critical: 0, High: 1, Medium: 2, Low: 3, Info: 4 }
/** @param {number[][]} modelGroups @param {string[]} log */
function dedupWith(modelGroups, log) {
  const run = { SEV_RANK, ragent: async () => ({ groups: modelGroups }), sb: { log: (/** @type {string} */ l) => log.push(l) } }
  return makeDedup(/** @type {any} */ (run)).dedupPool
}

// Two clusters of nine lens copies each, worded apart, with same-spot pairs inside them — the shape
// of the measured pool (titles synthetic). Before, each pair won and the model's nine-group was dropped.
const LENSES = ['reconciler', 'compat', 'failure-windows', 'invariants', 'intent', 'errors', 'tests', 'api-boundary', 'concurrency']
/** @param {string} what @param {string} file @param {number} i */
const copy = (what, file, i) => ({ severity: i % 2 ? 'Low' : 'Info', title: `${what} variant ${i} ${'xyzw'[i % 4]}`, file, line: i < 2 ? 50 : 50 + i, why: 'w', fix: 'f', source: /** @type {string} */ (LENSES[i]), ruleId: '', whereChecked: '' })
const POOL = [
  ...LENSES.map((_l, i) => copy('the recheck baseline counts the grant twice so the fast restore never fires', 'src/grant.rs', i)),
  ...LENSES.map((_l, i) => copy('rows at or over a lowered attempt limit are never claimed woken or deleted', 'src/queue.rs', i)),
]

test('dedupPool: each nine-lens cluster is one finding carrying all nine lenses', async () => {
  const log = /** @type {string[]} */ ([])
  const groups = [LENSES.map((_l, i) => i), LENSES.map((_l, i) => i + 9)]
  const out = await dedupWith(groups, log)(POOL, /** @type {any} */ ({ id: 'rust' }))
  assert.equal(out.length, 2, JSON.stringify(out.map((/** @type {any} */ f) => f.title)))
  for (const f of out) {
    assert.deepEqual(/** @type {string[]} */ (f['sources']).slice().sort(), LENSES.slice().sort())
    assert.ok(lensAgreed(f))
  }
  assert.ok(log.some(l => /Dedup before verify: 18 → 2/.test(l)), log.join('\n'))
})
