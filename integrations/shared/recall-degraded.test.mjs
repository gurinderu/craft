import { test } from 'vitest'
import assert from 'node:assert/strict'
import { MEMORY_RECALL_SCHEMA, readMemoryRecall, mergeRecall, memoryRecord, memoryLine, memorySection } from './memory-recall.mjs'
import { RECALL_NOTE_MAX, memoryDegradedNotes, recallNote } from './recall-degraded.mjs'
import { parsePriorDecisions } from './prior-decisions.mjs'

const Q = 'iskron_search(q: "craft_kind") answered: nodes for query «craft_kind» not found'
const REC = {
  id: 'decision-0d2edebb6f',
  kind: 'decision',
  title: 't',
  body: 'b',
  scope: 'src',
  status: 'active',
  date: '2026-10-01',
  author: 'a',
  commit: 'abc1234',
  links: [],
}
const PASSED = {
  kind: 'decision',
  title: 'passed one',
  body: 'b',
  scope: 'src',
  status: 'active',
  date: '2026-10-01',
  author: 'a',
  commit: 'abc1234',
  links: [],
}

test('the recall schema admits queryError and truncated as strings, beside every key a failed answer carries', () => {
  const s = /** @type {{ additionalProperties: boolean, properties: Record<string, { type: string }> }} */ (/** @type {unknown} */ (MEMORY_RECALL_SCHEMA))
  assert.equal(s.additionalProperties, false)
  assert.equal(s.properties['queryError']?.type, 'string')
  assert.equal(s.properties['truncated']?.type, 'string')
  for (const k of Object.keys({ backend: '', why: '', decisions: [], questions: [], rules: [], queryError: Q, truncated: '' }))
    assert.ok(Object.hasOwn(s.properties, k), k)
})

test("an empty recall naming a failed query keeps the agent's why, appends the query and reads as not read, degraded", () => {
  const failed = readMemoryRecall({ backend: 'mcp iskron', why: 'found by capability', decisions: [], queryError: Q }, 0)
  assert.equal(failed.memory.queryError, Q)
  assert.equal(
    memoryLine(failed.memory),
    `memory: not read — found by capability; recall found nothing — backend query may have failed: ${Q} (backend mcp iskron)`,
  )
  assert.deepEqual(memoryDegradedNotes(failed.memory), [
    `memory: not read — recall found nothing, backend query may have failed: ${Q}; none of the project's decisions or rules were applied`,
  ])
  assert.match(memorySection(failed.memory), /\n- ⚠️ degraded: memory: not read — recall found nothing/)
  const clean = readMemoryRecall({ backend: 'mcp iskron', why: 'no craft record in the store', decisions: [] }, 0)
  assert.equal(clean.memory.queryError, undefined)
  assert.match(memoryLine(clean.memory), /^memory: none — /)
  assert.deepEqual(memoryDegradedNotes(clean.memory), [])
  assert.doesNotMatch(memorySection(clean.memory), /degraded/)
  const found = readMemoryRecall({ backend: 'mcp iskron', why: 'w', decisions: [REC], queryError: Q }, 0)
  assert.equal(found.memory.queryError, undefined, 'a recall that found records is not degraded by one failed call')
})

test('the query error survives the merge with the launcher records and the run record, which the degraded note names', () => {
  const r = readMemoryRecall({ backend: 'mcp iskron', why: 'w', decisions: [], queryError: Q }, 0)
  const merged = mergeRecall({ ...r, inactive: [] }, [PASSED], parsePriorDecisions)
  assert.equal(merged.memory.queryError, Q)
  assert.equal(merged.memory.passed, 1)
  assert.equal(memoryRecord(merged.memory).queryError, Q)
  assert.match(memoryDegradedNotes(merged.memory)[0] ?? '', /; only the 1 record\(s\) the launcher passed were applied$/)
})

test('a truncated answer applies its records, carries the note through the merge and reads as degraded', () => {
  const r = readMemoryRecall({ backend: 'mcp iskron', why: 'w', decisions: [REC], truncated: '12 found, 10 shown' }, 0)
  assert.equal(r.memory.source, 'recalled')
  assert.match(memoryLine(r.memory), /; truncated — the backend held more than was read: 12 found, 10 shown/)
  const merged = mergeRecall({ ...r, inactive: [] }, [], parsePriorDecisions)
  assert.equal(merged.memory.truncated, '12 found, 10 shown')
  assert.equal(memoryRecord(merged.memory).truncated, '12 found, 10 shown')
  assert.deepEqual(memoryDegradedNotes(merged.memory), [
    "memory: recall read only part of the backend's answer (12 found, 10 shown): the records past it were not applied",
  ])
})

test('a recall note is one line, kept to its bound', () => {
  assert.equal(recallNote('  a\n  b '), 'a b')
  assert.equal(recallNote(7), '')
  const kept = recallNote('é'.repeat(RECALL_NOTE_MAX + 20))
  assert.equal(Array.from(kept).length, RECALL_NOTE_MAX + 1)
  assert.ok(kept.endsWith('…'))
  const r = readMemoryRecall({ backend: 'b', why: 'w', decisions: [], queryError: 'x'.repeat(RECALL_NOTE_MAX * 2) }, 0)
  assert.equal(Array.from(r.memory.queryError ?? '').length, RECALL_NOTE_MAX + 1)
})
