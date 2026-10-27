// unitBatchPlan's choice under the fitted cost model (realm @nick/craft, #355, #353): the ceiling is the
// heaviest single-lens agent a normal review sends over the whole change, over every lens of the run — the
// whole-diff lenses (intent, negative-space) included, which are the heaviest.
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { unitBatchPlan } from './review-unit-batches.mjs'

// Eight crates that depend on nothing, three changed files and 40 changed lines each.
const CRATES = Array.from({ length: 8 }, (_v, i) => `crates/c${i}`)
const FILES = CRATES.flatMap(c => [0, 1, 2].map(i => `${c}/src/f${i}.rs`))
const NUMSTAT = new Map(FILES.map(f => [f, f.endsWith('f0.rs') ? 14 : 13]))
const PACKAGES = CRATES.map(root => ({ root, name: root.slice('crates/'.length), codeLines: 500, sigLines: 20, deps: [] }))
const LENSES = ['intent', 'negative-space', 'tests', 'reconciler', 'safety', 'errors', 'concurrency', 'maintainability']

/** @param {Record<string, unknown>} [over] */
const plan = (over = {}) => unitBatchPlan({ lenses: LENSES, changedFiles: FILES, roots: CRATES, packages: PACKAGES, numstat: NUMSTAT, owns: f => f.endsWith('.rs'), batched: true, batchBudget: 0, costModel: undefined, ...over })

test('unit batch plan: under the fitted model the ceiling counts the whole-diff lenses, so a budget candidate fits', () => {
  const e = plan().costEstimate
  assert.equal(e.ceiling?.source, 'one whole-diff lens agent')
  const perUnit = e.candidates.find(c => c.name === 'per-unit')
  assert.ok(perUnit, 'per-unit is a candidate')
  // negative-space over the whole diff: 198065 + 1172551 + 1.55 × (169.2 × 320 + 4855.7 × 24).
  assert.equal(e.ceiling?.tokens, 1635171)
  // Over the sliceable lenses alone it would be reconciler's 784267, under every budget candidate's heaviest (946254).
  assert.ok(e.candidates.every(c => c.fits))
  assert.ok(e.candidates.some(c => c.name.startsWith('budget:') && c.fits), 'a budget candidate fits under the ceiling')
  assert.match(e.chosen, /^budget:/)
  assert.match(e.reason, /^lowest estimated total/)
  const chosen = e.candidates.find(c => c.name === e.chosen)
  assert.ok(chosen && chosen.total < perUnit.total, 'the chosen budget costs less than one agent per unit')
})

test('unit batch plan: a ceiling no candidate meets falls back to the lightest heaviest agent', () => {
  const e = plan({ agentCeiling: 1 }).costEstimate
  assert.deepEqual(e.ceiling, { tokens: 1, source: 'unitAgentCeiling' })
  assert.ok(e.candidates.every(c => !c.fits))
  assert.equal(e.chosen, e.candidates.reduce((m, c) => (c.heaviest < m.heaviest ? c : m)).name)
  assert.match(e.reason, /^no candidate's heaviest agent is at or under the ceiling \(1\)/)
})
