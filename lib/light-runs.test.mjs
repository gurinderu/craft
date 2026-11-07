// craft:review's light runs in analyze-runs (realm @nick/craft, node #295): their own population, kept out of
// the cost and surface-gate figures; a record without `depth` counts as full.
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { aggregate, renderReport } from './analyze-runs.mjs'
import { isLightRun, newDepthTally, tallyDepth, renderDepthSection } from './light-runs.mjs'

const base = { schemaVersion: 1, kind: 'workflow', name: 'review', verdict: 'Approve', round: 1 }
const FULL = { ...base, outputTokens: 100, surfaceGate: { dropped: ['compat'], dispatched: ['negative-space'], lensesRan: true }, runtimeStats: { agents: 20, wallClockMinutes: 30 }, verification: { confirmed: 4, candidates: 6 } }
const LIGHT = { ...base, depth: 'light', outputTokens: 7, surfaceGate: { dropped: ['invariants', 'compat'], dispatched: [], lensesRan: true }, runtimeStats: { agents: 6, wallClockMinutes: 8 }, verification: { confirmed: 1, candidates: 2 } }

test('isLightRun reads only depth light; an absent depth is full', () => {
  assert.equal(isLightRun(LIGHT), true)
  assert.equal(isLightRun(FULL), false)
  assert.equal(isLightRun({ depth: 'full' }), false)
  assert.equal(isLightRun(null), false)
})

test('tallyDepth splits craft:review records by depth and counts only what a record carries', () => {
  const t = newDepthTally()
  for (const r of [FULL, { ...FULL, runtimeStats: null }, LIGHT, { ...LIGHT, name: 'rust-audit' }]) tallyDepth(t, r)
  assert.deepEqual(t.full, { runs: 2, agents: 20, agentRuns: 1, minutes: 30, minuteRuns: 1, confirmed: 8, confirmedRuns: 2 })
  assert.deepEqual(t.light, { runs: 1, agents: 6, agentRuns: 1, minutes: 8, minuteRuns: 1, confirmed: 1, confirmedRuns: 1 })
  assert.match(renderDepthSection(t).join('\n'), /full: 2 run\(s\), agents\/run 20, wall min\/run 30, confirmed\/run 4\n- light: 1 run\(s\), agents\/run 6/)
  assert.match(renderDepthSection(newDepthTally()).join('\n'), /light: NOT MEASURED/)
})

test('aggregate keeps a light run out of the pool and surface-gate figures and reports it under DEPTH', () => {
  const a = aggregate([FULL, LIGHT])
  const w = a.workflows.find(x => x.name === 'review')
  assert.ok(w)
  assert.equal(w.runs, 2, 'the light run still counts as a review run')
  assert.equal(w.sgGateRuns, 1, 'only the full run enters the surface-gate population')
  assert.equal(w.sgSavedPasses, 1)
  assert.equal(w.sgDispatchedPasses, 1)
  assert.equal(a.depth.light.runs, 1)
  assert.equal(a.depth.full.runs, 1)
  assert.match(renderReport(a), /## DEPTH -- craft:review light runs[^\n]*\n- full: 1 run\(s\)[^\n]*\n- light: 1 run\(s\)/)
})
