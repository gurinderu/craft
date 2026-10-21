import { test } from 'vitest'
import assert from 'node:assert/strict'
import { newMemoryTally, tallyMemory, renderMemorySection } from './memory-tally.mjs'
import { aggregate, renderReport } from './analyze-runs.mjs'
import { memoryRecord, readMemoryRecall, skippedMemory, initialMemory } from './memory-recall.mjs'

const REC = { kind: 'decision', title: 't', scope: 'src' }

test('memory record: the source with its backend, without the derived titles', () => {
  const m = readMemoryRecall({ backend: 'harness', why: 'default', decisions: [{ kind: 'decision', title: 't', scope: 'src' }] }, 0).memory
  assert.deepEqual(memoryRecord({ ...m, derived: 1, derivedNamed: ['decision-x (t)'] }), { ...m, derived: 1 })
  assert.equal(m.backend, 'harness')
  assert.equal(m.count, 1)
})

test('memory tally: recalled by backend, none by reason, runs before the field apart', () => {
  const t = newMemoryTally()
  tallyMemory(t, { memory: readMemoryRecall({ backend: 'harness', why: 'x', decisions: [REC] }, 0).memory })
  tallyMemory(t, { memory: { source: 'launcher', count: 2, why: '' } })
  tallyMemory(t, { memory: { source: 'launcher', count: 2, why: '' } })
  tallyMemory(t, { memory: skippedMemory(initialMemory(0), 'nothing to review') })
  tallyMemory(t, { memory: skippedMemory(initialMemory(1), 'nothing to review') })
  tallyMemory(t, { memory: readMemoryRecall({ backend: 'repo', why: 'no file matched src/a.rs', decisions: [] }, 0).memory })
  tallyMemory(t, { memory: readMemoryRecall({ backend: 'repo', why: 'nothing for src/b.rs', decisions: [] }, 0).memory })
  tallyMemory(t, { memory: readMemoryRecall(null, 3).memory })
  tallyMemory(t, { memory: { source: 'none', count: 0, why: 'recall did not run — budget below the floor (~42k left)' } })
  tallyMemory(t, {})
  tallyMemory(t, { memory: 'garbage' })
  assert.deepEqual(t, {
    runs: 11, carrying: 9, recalled: 1, passedOnly: 1, nested: 2, none: 6, records: 1, questions: 0, rules: 0, covered: 0,
    byBackend: { harness: 1 },
    noneWhy: {
      'not recalled — nothing to review': 2, 'recall found nothing in repo': 2,
      'the recall agent died or returned no list': 1, 'budget below the floor': 1,
    },
  })
  assert.deepEqual(renderMemorySection(t), [
    '## MEMORY — what the review recalled before judging',
    '- 9 run(s) carry the field (2 without it, excluded) · 1 recalled · 6 none (1 of them applied the launcher\'s records) · 2 nested under an audit, its one recall counted at the audit · 1 record(s) recalled, 0 of them open questions',
    '- 1× from harness',
    '- 2× none — not recalled — nothing to review',
    '- 2× none — recall found nothing in repo',
    '- 1× none — budget below the floor',
    '- 1× none — the recall agent died or returned no list',
  ])
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
