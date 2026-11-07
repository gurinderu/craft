// unitBatchPlan's choice under the fitted cost model (realm @nick/craft, #355, #353, #402): the ceiling is the
// heaviest sliced lens agent a normal review sends — each sliceable lens over each slice of the directory
// slicing, or over the whole change when that slicing does not slice — never a whole-diff lens; and every
// sliceable lens has an agent of its own per batch.
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { unitBatchPlan, ceilingOf } from './review-unit-batches.mjs'
import { sliceDiff, sliceableLens } from './lens-scope.mjs'
import { costModelOf, agentCost, batchFeatures } from './unit-cost.mjs'
import { changedLinesOf } from './unit-batches.mjs'

// Eight crates that depend on nothing, three changed files and 40 changed lines each.
const CRATES = Array.from({ length: 8 }, (_v, i) => `crates/c${i}`)
const FILES = CRATES.flatMap(c => [0, 1, 2].map(i => `${c}/src/f${i}.rs`))
const NUMSTAT = new Map(FILES.map(f => [f, f.endsWith('f0.rs') ? 14 : 13]))
const PACKAGES = CRATES.map(root => ({ root, name: root.slice('crates/'.length), codeLines: 500, sigLines: 20, deps: [] }))
const LENSES = ['intent', 'negative-space', 'tests', 'reconciler', 'safety', 'errors', 'concurrency', 'maintainability']
const SLICED = LENSES.filter(sliceableLens)
const owns = (/** @type {string} */ f) => f.endsWith('.rs')

/** @param {Record<string, unknown>} [over] */
const plan = (over = {}) => unitBatchPlan({ lenses: LENSES, changedFiles: FILES, roots: CRATES, packages: PACKAGES, numstat: NUMSTAT, owns, batched: true, batchBudget: 0, costModel: undefined, ...over })

test('unit batch plan: the ceiling is the heaviest sliced lens agent over a normal-review slice, not a whole-diff lens', () => {
  const e = plan().costEstimate
  const model = costModelOf(undefined)
  const slices = sliceDiff(FILES, { owns })
  assert.ok(slices.length > 1, 'normal review slices this change')
  const heaviest = Math.max(...slices.flatMap(s => {
    const f = batchFeatures(s, [...new Set(s.files.map(x => x.split('/src/')[0] ?? ''))], changedLinesOf(NUMSTAT), PACKAGES)
    return SLICED.map(l => agentCost(model, [l], f))
  }))
  assert.equal(e.ceiling?.tokens, heaviest)
  assert.equal(e.ceiling?.source, 'normal-review slice lens agent')
  assert.ok(SLICED.includes(String(e.ceiling?.lens)), 'a sliced lens sets it')
  assert.ok(slices.some(s => s.key === e.ceiling?.slice), 'over one of normal review\'s slices')
  // negative-space over the whole diff would have been the old ceiling: far above any slice's agent.
  const whole = batchFeatures({ key: 'whole', files: FILES }, CRATES, changedLinesOf(NUMSTAT), PACKAGES)
  assert.ok(Number(e.ceiling?.tokens) < agentCost(model, ['negative-space'], whole))
  assert.ok(e.batched.heaviest <= Number(e.ceiling?.tokens), 'no batch agent is heavier than a normal-review slice agent')
  assert.ok(Number(e.candidates.find(c => c.name === e.chosen)?.batches.length) > 1)
})

test('unit batch plan: every sliced lens has an agent of its own on every batch', () => {
  const { costEstimate: e, unitBatches } = plan()
  const lensAgents = e.batched.perAgent.filter(a => a.lenses[0] !== 'contract')
  assert.ok(lensAgents.every(a => a.lenses.length === 1), 'no agent carries several lenses')
  for (const b of unitBatches ?? []) assert.deepEqual(lensAgents.filter(a => a.batch === b.key).map(a => a.lenses[0]).sort(), [...SLICED].sort(), b.key)
  assert.equal(e.batched.agents, (unitBatches ?? []).length * SLICED.length + CRATES.length)
})

test('unit batch plan: a change normal review does not slice sets the ceiling over the whole change, and may be one batch', () => {
  // Two units under one directory: the directory slicing sees one group and does not slice.
  const roots = ['crates/a/x', 'crates/a/y']
  const files = roots.flatMap(r => [0, 1, 2, 3, 4, 5].map(i => `${r}/src/f${i}.rs`))
  const packages = [{ root: 'crates/a/x', name: 'x', codeLines: 300, sigLines: 10, deps: ['y'] }, { root: 'crates/a/y', name: 'y', codeLines: 300, sigLines: 10, deps: [] }]
  const numstat = new Map(files.map(f => [f, 10]))
  assert.deepEqual(sliceDiff(files, { owns }), [])
  const c = ceilingOf({ model: costModelOf(undefined), sliced: SLICED, changedFiles: files, roots, owns, linesOf: changedLinesOf(numstat), packages, agentCeiling: 0 })
  assert.equal(c.slice, 'whole diff')
  const e = unitBatchPlan({ lenses: LENSES, changedFiles: files, roots, packages, numstat, owns, batched: true, batchBudget: 0, costModel: undefined }).costEstimate
  assert.deepEqual(e.ceiling, c)
  assert.deepEqual(e.candidates.find(x => x.name === e.chosen)?.batches, ['unit:crates/a/x unit:crates/a/y'], 'the two units fit under one normal agent: one batch')
})

test('unit batch plan: a ceiling no candidate meets falls back to the lightest heaviest agent', () => {
  const e = plan({ agentCeiling: 1 }).costEstimate
  assert.deepEqual(e.ceiling, { tokens: 1, source: 'unitAgentCeiling' })
  assert.ok(e.candidates.every(c => !c.fits))
  assert.equal(e.chosen, e.candidates.reduce((m, c) => (c.heaviest < m.heaviest ? c : m)).name)
  assert.match(e.reason, /^no candidate's heaviest agent is at or under the ceiling \(1\)/)
})
