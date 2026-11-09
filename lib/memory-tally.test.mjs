import { test } from 'vitest'
import assert from 'node:assert/strict'
import { newMemoryTally, tallyMemory, renderMemorySection } from './memory-tally.mjs'
import { aggregate, renderReport } from './analyze-runs.mjs'
import { memoryRecord, readMemoryRecall } from './memory-recall.mjs'

test('memory record: the source with its backend, without the derived titles', () => {
  const m = readMemoryRecall({ backend: 'harness', why: 'default', decisions: [{ kind: 'decision', title: 't', scope: 'src' }] }, 0).memory
  assert.deepEqual(memoryRecord({ ...m, derived: 1, derivedNamed: ['decision-x (t)'] }), { ...m, derived: 1 })
  assert.equal(m.backend, 'harness')
  assert.equal(m.count, 1)
})

test('memory section: a store with no run carrying the field says NOT MEASURED, never "none"', () => {
  const t = newMemoryTally()
  tallyMemory(t, {})
  assert.match(renderMemorySection(t).join('\n'), /NOT MEASURED — none of the 1 run\(s\) carried `memory`/)
})

test('memory tally: a pinned backend or store that is unavailable is its own none class, not an empty recall', () => {
  const t = newMemoryTally()
  tallyMemory(t, { memory: readMemoryRecall({ backend: 'none', why: 'pinned backend unavailable: store x/y refused by server kg', decisions: [] }, 0).memory })
  tallyMemory(t, { memory: readMemoryRecall({ backend: 'repo', why: 'no file matched', decisions: [] }, 0).memory })
  assert.deepEqual(t.noneWhy, { 'pinned backend unavailable': 1, 'recall found nothing in repo': 1 })
})

test('analyze-runs report carries the MEMORY section from the records', () => {
  const report = renderReport(aggregate([{ kind: 'workflow', name: 'review', verdict: 'Approve', memory: { source: 'recalled', count: 2, backend: 'repo', why: 'repo' } }]))
  assert.match(report, /## MEMORY[\s\S]*1 run\(s\) carry the field · 1 recalled[\s\S]*- 1× from repo/)
})

test('memory tally: a recall of external systems alone is a recall, its systems counted apart from the records (realm @nick/craft, node #431)', () => {
  const t = newMemoryTally()
  const ext = { system: 'kube-ovn', repo: 'https://github.com/kubeovn/kube-ovn', versionFrom: 'go.mod', versionMatch: '(v\\S+)', scope: 'src' }
  tallyMemory(t, { memory: memoryRecord(readMemoryRecall({ backend: 'repo', why: 'w', decisions: [], externals: [ext] }, 0).memory) })
  assert.deepEqual([t.recalled, t.none, t.records, t.externals], [1, 0, 0, 1])
  assert.ok(renderMemorySection(t).includes('- external systems: 1 recalled beside the records, their source read by the lenses'))
  assert.ok(!renderMemorySection(newMemoryTally()).some(l => l.includes('external systems')))
})
