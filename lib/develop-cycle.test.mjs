// One record per craft:develop cycle (lib/develop-cycle.mjs, lib/develop-tally.mjs; realm @nick/craft,
// nodes #263, #278, #281): the payload read strictly, written by `craft-log-run develop-cycle`, tallied apart
// from the review runs and printed as the DEVELOP section.
import { test } from 'vitest'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { run } from './craft-log-run.mjs'
import { aggregate, renderReport } from './analyze-runs.mjs'
import { developCycleRecord, readDevelopCycle } from './develop-cycle.mjs'
import { newDevelopTally, renderDevelopSection, tallyDevelop } from './develop-tally.mjs'

/** @param {Record<string, unknown>} [over] */
const cycle = (over = {}) => ({
  outcome: 'converged',
  rounds: [{ engine: 'craft:adversarial-review', scope: 'full', verdict: 'Warning', mediumPlus: 2 }, { engine: 'craft:adversarial-review', scope: 'delta', verdict: 'Approve', mediumPlus: 0 }],
  fullReviews: [{ afterRound: 2, engine: 'craft:adversarial-review', verdict: 'Approve', mediumPlus: 0 }],
  ...over,
})

test('readDevelopCycle: a light cycle by default, its rounds numbered', () => {
  const c = readDevelopCycle(cycle())
  assert.equal(c.mode, 'light')
  assert.deepEqual(c.rounds.map(r => [r.n, r.scope, r.mediumPlus]), [[1, 'full', 2], [2, 'delta', 0]])
  assert.deepEqual(developCycleRecord(cycle()), { schemaVersion: 1, runtime: 'claude-code', kind: 'develop', name: 'develop', verdict: 'converged', round: 2, develop: c })
})

test('readDevelopCycle: refuses by name what does not fit', () => {
  /** @type {Array<[unknown, RegExp]>} */
  const bad = [
    [null, /the cycle must be an object/], [cycle({ outcome: 'done' }), /outcome must be one of/], [cycle({ mode: 'fast' }), /mode must be one of/],
    [cycle({ rounds: [] }), /rounds must hold 1 to 12/], [cycle({ rounds: [{ engine: 'x', scope: 'half', verdict: 'v', mediumPlus: 0 }] }), /rounds\[0\]\.scope/],
    [cycle({ rounds: [{ engine: '', scope: 'full', verdict: 'v', mediumPlus: 0 }] }), /rounds\[0\]\.engine/],
    [cycle({ rounds: [{ engine: 'x', scope: 'full', verdict: 'v', mediumPlus: -1 }] }), /rounds\[0\]\.mediumPlus/],
    [cycle({ fullReviews: [{ afterRound: 3, engine: 'x', verdict: 'v', mediumPlus: 0 }] }), /fullReviews\[0\]\.afterRound/],
    [cycle({ fullReviews: 'x' }), /fullReviews must be an array/],
    [cycle({ rounds: [{ engine: 'x', scope: 'full', verdict: 'Warning', mediumPlus: 1 }], fullReviews: [] }), /"converged" needs/],
    [cycle({ fullReviews: [{ afterRound: 2, engine: 'x', verdict: 'Warning', mediumPlus: 1 }] }), /"converged" needs/],
  ]
  for (const [payload, why] of bad) assert.throws(() => readDevelopCycle(payload), why)
  assert.equal(readDevelopCycle(cycle({ outcome: 'no-verdict', rounds: [{ engine: 'x', scope: 'full', verdict: 'INCOMPLETE', mediumPlus: null }], fullReviews: [] })).rounds[0]?.mediumPlus, null)
})

test('the tally: outcomes, rounds, Medium+ by round, the full review; an unreadable record apart', () => {
  const t = newDevelopTally()
  tallyDevelop(t, developCycleRecord(cycle()))
  const capped = [1, 2, 3, 4].map(n => ({ engine: 'craft:review', scope: n === 1 ? 'full' : 'delta', verdict: 'Warning', mediumPlus: 1 }))
  tallyDevelop(t, developCycleRecord(cycle({ outcome: 'capped', rounds: capped, fullReviews: [] })))
  tallyDevelop(t, developCycleRecord(cycle({ mode: 'full', rounds: [...capped.slice(0, 2), { engine: 'craft:review', scope: 'delta', verdict: 'Approve', mediumPlus: 0 }], fullReviews: [{ afterRound: 2, engine: 'craft:rust-audit', verdict: 'Warning', mediumPlus: 1 }, { afterRound: 3, engine: 'craft:rust-audit', verdict: 'Approve', mediumPlus: 0 }] })))
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

test('craft-log-run develop-cycle files one develop record; a bad cycle fails with 1 and files nothing', async () => {
  const store = fs.mkdtempSync(path.join(os.tmpdir(), 'craft-dev-store-'))
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'craft-dev-dir-'))
  try {
    const bad = await run(['develop-cycle', '--store', store, '--project', dir], process.env, dir, () => JSON.stringify(cycle({ outcome: 'done' })))
    assert.equal(bad.exitCode, 1)
    assert.match(bad.stderr.join('\n'), /craft-log-run FAILED: outcome must be one of/)
    assert.equal(fs.existsSync(path.join(store, 'index.jsonl')), false)
    const r = await run(['develop-cycle', '--store', store, '--project', dir], process.env, dir, () => JSON.stringify(cycle()))
    assert.equal(r.exitCode, 0, r.stderr.join('\n'))
    const files = fs.readdirSync(store).filter(f => f.endsWith('.json'))
    assert.equal(files.length, 1)
    assert.match(String(files[0]), /-develop-develop\.json$/)
    const rec = JSON.parse(fs.readFileSync(path.join(store, String(files[0])), 'utf8'))
    assert.deepEqual([rec.kind, rec.verdict, rec.round, rec.develop.outcome], ['develop', 'converged', 2, 'converged'])
    const row = JSON.parse(fs.readFileSync(path.join(store, 'index.jsonl'), 'utf8'))
    assert.deepEqual([row.kind, row.verdict], ['develop', 'converged'])
  } finally {
    for (const d of [store, dir]) fs.rmSync(d, { recursive: true, force: true })
  }
})

test('analyze-runs: a develop record stays out of the review rates and prints under DEVELOP', () => {
  const review = { schemaVersion: 1, kind: 'workflow', name: 'review', verdict: 'Approve', findings: { total: 0 }, dimensions: [] }
  const a = aggregate([review, { ...developCycleRecord(cycle()), schemaVersion: 1 }])
  assert.equal(a.totalRuns, 1)
  assert.deepEqual(a.workflows.map(w => w.name), ['review'])
  assert.equal(a.develop.cycles, 1)
  assert.match(renderReport(a), /## DEVELOP — craft:develop cycles[^\n]*\n- 1 cycle\(s\) · 1 converged/)
})
