// One record per craft:develop cycle (integrations/shared/develop-cycle.mjs, integrations/shared/develop-tally.mjs; realm @nick/craft,
// nodes #263, #278, #281): the payload read strictly, written by `craft runs develop-cycle`, tallied apart
// from the review runs and printed as the DEVELOP section.
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { aggregate, renderReport } from './analyze-runs.mjs'
import { readDevelopCycle } from './develop-cycle.mjs'
import { newDevelopTally, renderDevelopSection, tallyDevelop } from './develop-tally.mjs'

/** @param {Record<string, unknown>} [over] */
const cycle = (over = {}) => ({
  outcome: 'converged',
  rounds: [
    { engine: 'craft:adversarial-review', scope: 'full', verdict: 'Warning', mediumPlus: 2 },
    { engine: 'craft:adversarial-review', scope: 'delta', verdict: 'Approve', mediumPlus: 0 },
  ],
  fullReviews: [{ afterRound: 2, engine: 'craft:adversarial-review', verdict: 'Approve', mediumPlus: 0 }],
  ...over,
})

/** A cycle's record as `craft runs develop-cycle` files it (cli/crates/craft-store/src/develop.rs). @param {unknown} payload */
const developCycleRecord = payload => {
  const c = readDevelopCycle(payload)
  return { schemaVersion: 1, runtime: 'claude-code', kind: 'develop', name: 'develop', verdict: c.outcome, round: c.rounds.length, develop: c }
}

test('readDevelopCycle: a light cycle by default, its rounds numbered', () => {
  const c = readDevelopCycle(cycle())
  assert.equal(c.mode, 'light')
  assert.deepEqual(
    c.rounds.map(r => [r.n, r.scope, r.mediumPlus]),
    [
      [1, 'full', 2],
      [2, 'delta', 0],
    ],
  )
})

test('readDevelopCycle: refuses by name what does not fit', () => {
  /** @type {Array<[unknown, RegExp]>} */
  const bad = [
    [null, /the cycle must be an object/],
    [cycle({ outcome: 'done' }), /outcome must be one of/],
    [cycle({ mode: 'fast' }), /mode must be one of/],
    [cycle({ rounds: [] }), /rounds must hold 1 to 12/],
    [cycle({ rounds: [{ engine: 'x', scope: 'half', verdict: 'v', mediumPlus: 0 }] }), /rounds\[0\]\.scope/],
    [cycle({ rounds: [{ engine: '', scope: 'full', verdict: 'v', mediumPlus: 0 }] }), /rounds\[0\]\.engine/],
    [cycle({ rounds: [{ engine: 'x', scope: 'full', verdict: 'v', mediumPlus: -1 }] }), /rounds\[0\]\.mediumPlus/],
    [cycle({ fullReviews: [{ afterRound: 3, engine: 'x', verdict: 'v', mediumPlus: 0 }] }), /fullReviews\[0\]\.afterRound/],
    [cycle({ fullReviews: 'x' }), /fullReviews must be an array/],
    [cycle({ rounds: [{ engine: 'x', scope: 'full', verdict: 'Warning', mediumPlus: 1 }], fullReviews: [] }), /"converged" needs/],
    [cycle({ fullReviews: [{ afterRound: 2, engine: 'x', verdict: 'Warning', mediumPlus: 1 }] }), /"converged" needs/],
    [
      cycle({
        fullReviews: [
          { afterRound: 2, engine: 'x', verdict: 'Warning', mediumPlus: 1 },
          { afterRound: 2, engine: 'y', verdict: 'Approve', mediumPlus: 0 },
        ],
      }),
      /"converged" needs/,
    ],
  ]
  for (const [payload, why] of bad) assert.throws(() => readDevelopCycle(payload), why)
  assert.equal(
    readDevelopCycle(cycle({ outcome: 'no-verdict', rounds: [{ engine: 'x', scope: 'full', verdict: 'INCOMPLETE', mediumPlus: null }], fullReviews: [] }))
      .rounds[0]?.mediumPlus,
    null,
  )
})

test('the tally: outcomes, rounds, Medium+ by round, the full review; an unreadable record apart', () => {
  const t = newDevelopTally()
  tallyDevelop(t, developCycleRecord(cycle()))
  const capped = [1, 2, 3, 4].map(n => ({ engine: 'craft:review', scope: n === 1 ? 'full' : 'delta', verdict: 'Warning', mediumPlus: 1 }))
  tallyDevelop(t, developCycleRecord(cycle({ outcome: 'capped', rounds: capped, fullReviews: [] })))
  tallyDevelop(
    t,
    developCycleRecord(
      cycle({
        mode: 'full',
        rounds: [...capped.slice(0, 2), { engine: 'craft:review', scope: 'delta', verdict: 'Approve', mediumPlus: 0 }],
        fullReviews: [
          { afterRound: 2, engine: 'craft:rust-audit', verdict: 'Warning', mediumPlus: 1 },
          { afterRound: 3, engine: 'craft:rust-audit', verdict: 'Approve', mediumPlus: 0 },
        ],
      }),
    ),
  )
  tallyDevelop(t, { develop: { outcome: 'x' } })
  const lines = renderDevelopSection(t)
  assert.deepEqual(lines.slice(1), [
    '- 3 cycle(s) · 2 converged · 1 capped at the round limit · 0 stopped without a verdict · light 2 / full 1',
    '- rounds per cycle: 3 on average · 2.5 to converge',
    '- open Medium+ after each round (summed over the cycles that reached it): r1 4 in 3 · r2 2 in 3 · r3 1 in 2 · r4 1 in 1',
    '- full review: 3 run(s) · 1 reopened the loop with open Medium+ · 0 without a verdict · 2 clean',
    '- ⚠️ 1 develop record(s) unreadable — not counted',
  ])
  assert.match(renderDevelopSection(newDevelopTally())[1] ?? '', /NOT MEASURED/)
})

test('analyze-runs: a develop record stays out of the review rates and prints under DEVELOP', () => {
  const review = { schemaVersion: 1, kind: 'workflow', name: 'review', verdict: 'Approve', findings: { total: 0 }, dimensions: [] }
  const a = aggregate([review, { ...developCycleRecord(cycle()), schemaVersion: 1 }])
  assert.equal(a.totalRuns, 1)
  assert.deepEqual(
    a.workflows.map(w => w.name),
    ['review'],
  )
  assert.equal(a.develop.cycles, 1)
  assert.match(renderReport(a), /## DEVELOP — craft:develop cycles[^\n]*\n- 1 cycle\(s\) · 1 converged/)
})
