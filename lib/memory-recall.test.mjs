import { test } from 'vitest'
import assert from 'node:assert/strict'
import { RECALL_PATHS_MAX, memoryRecallPrompt, readMemoryRecall, initialMemory, memoryLine, memorySection, recallDecisions } from './memory-recall.mjs'

const REC = { id: 'decision-1', kind: 'decision', title: 't', body: 'b', scope: 'src', status: 'active', date: '2026-10-01', author: 'a', commit: 'abc1234', links: [] }

test('memory recall prompt: the skill first, the backend order by capability, read only, the record shape', () => {
  const p = memoryRecallPrompt(['src/a.rs', 'src/b.rs'], 'main')
  assert.match(p, /craft:memory skill with the Skill tool/)
  assert.match(p, /READ ONLY/)
  assert.match(p, /CRAFT_MEMORY[\s\S]*craft-memory:[\s\S]*ToolSearch[\s\S]*never by a server or tool name[\s\S]*project memory[\s\S]*\.craft\/memory\//)
  assert.match(p, /kind decision, status active only/)
  assert.match(p, /- src\/a\.rs\n- src\/b\.rs/)
  assert.match(p, /id, kind, title, body, scope, status, date, author, commit, links/)
})

test('memory recall prompt: the path list is bounded and the cut is named; no list → the diff against the base', () => {
  const many = Array.from({ length: RECALL_PATHS_MAX + 7 }, (_, i) => `f${i}.rs`)
  const p = memoryRecallPrompt(many, 'main')
  assert.ok(p.includes(`- f${RECALL_PATHS_MAX - 1}.rs`))
  assert.ok(!p.includes(`- f${RECALL_PATHS_MAX}.rs`))
  assert.match(p, new RegExp(`7 more path\\(s\\) cut at the bound of ${RECALL_PATHS_MAX}`))
  assert.match(memoryRecallPrompt([], 'origin/main'), /git diff --name-only origin\/main\.\.\.HEAD/)
  assert.match(memoryRecallPrompt([], ''), /git merge-base/)
})

test('memory recall result: decisions → recalled with backend and why; [] → none with why; dead or off-shape → none, named', () => {
  const r = readMemoryRecall({ backend: 'mcp kg', why: 'a connected server with search and create', decisions: [REC] }, 0)
  assert.deepEqual(r.decisions, [REC])
  assert.equal(memoryLine(r.memory), 'memory: recalled 1 decision(s) from mcp kg (a connected server with search and create)')
  const none = readMemoryRecall({ backend: 'none', why: 'no backend applies', decisions: [] }, 0)
  assert.deepEqual(none.decisions, [])
  assert.match(memoryLine(none.memory), /^memory: none — no backend applies/)
  for (const dead of [null, undefined, 'text', { backend: 'x', why: 'y' }, [REC]]) {
    const d = readMemoryRecall(dead, 0)
    assert.deepEqual(d.decisions, [])
    assert.equal(d.memory.source, 'none')
    assert.match(memoryLine(d.memory), /^memory: none — the recall agent died or returned no decision list.*findings are raised normally/)
  }
  assert.match(memoryLine(readMemoryRecall({ backend: 'repo', why: 'w', decisions: [REC] }, 3).memory), /3 changed path\(s\) past the bound of \d+ were not recalled for/)
})

test('memory source: passed (any value, an empty list included) vs absent; the section carries one line', () => {
  assert.equal(memoryLine(initialMemory([REC, REC], 2)), 'memory: passed by the launcher (2)')
  assert.equal(memoryLine(initialMemory('{nope', 0)), 'memory: passed by the launcher (0)')
  for (const absent of [undefined, null, '']) assert.match(memoryLine(initialMemory(absent, 0)), /^memory: none — not recalled/)
  assert.equal(memorySection(initialMemory([], 0)), '\n\n## Memory\n- memory: passed by the launcher (0)\n')
})

test('recallDecisions: one call, the bounded prompt, the read answer', async () => {
  /** @type {string[]} */
  const asked = []
  const r = await recallDecisions(async p => { asked.push(p); return { backend: 'harness', why: 'default', decisions: [REC] } }, ['a.rs'], 'main')
  assert.equal(asked.length, 1)
  assert.match(String(asked[0]), /- a\.rs/)
  assert.equal(r.memory.source, 'recalled')
  assert.equal(r.memory.count, 1)
})
