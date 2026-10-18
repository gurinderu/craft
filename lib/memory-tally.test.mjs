import { test } from 'vitest'
import assert from 'node:assert/strict'
import { newMemoryTally, tallyMemory, renderMemorySection } from './memory-tally.mjs'
import { aggregate, renderReport } from './analyze-runs.mjs'
import { memoryRecord, readMemoryRecall, skippedMemory, initialMemory } from './memory-recall.mjs'

test('memory record: the source with its backend, without the derived titles', () => {
  const m = readMemoryRecall({ backend: 'harness', why: 'default', decisions: [{ kind: 'decision', title: 't', scope: 'src' }] }, 0).memory
  assert.deepEqual(memoryRecord({ ...m, derived: 1, derivedNamed: ['decision-x (t)'] }), { ...m, derived: 1 })
  assert.equal(m.backend, 'harness')
  assert.equal(m.count, 1)
})

test('memory tally: recalled by backend, none by reason, runs before the field apart', () => {
  const t = newMemoryTally()
  tallyMemory(t, { memory: { source: 'recalled', count: 3, questions: 1, backend: 'harness', why: 'x' } })
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
    runs: 10, carrying: 8, recalled: 1, launcher: 1, none: 6, records: 3, questions: 1,
    byBackend: { harness: 1, 'the launching audit': 1 },
    noneWhy: {
      'not recalled — nothing to review': 2, 'recall found nothing in repo': 2,
      'the recall agent died or returned no list': 1, 'budget below the floor': 1,
    },
  })
  assert.deepEqual(renderMemorySection(t), [
    '## MEMORY — what the review recalled before judging',
    '- 8 run(s) carry the field (2 without it, excluded) · 2 applied memory (1 recalled, 1 from the launching audit) · 6 none · 3 record(s) recalled, 1 of them open questions (a launcher\'s records counted once, not again in its nested runs)',
    '- 1× from harness',
    '- 1× from the launching audit',
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

test('analyze-runs report carries the MEMORY section from the records', () => {
  const report = renderReport(aggregate([{ kind: 'workflow', name: 'review', verdict: 'Approve', memory: { source: 'recalled', count: 2, backend: 'repo', why: 'repo' } }]))
  assert.match(report, /## MEMORY[\s\S]*1 run\(s\) carry the field · 1 applied memory[\s\S]*- 1× from repo/)
})
