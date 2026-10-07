import fs from 'node:fs'
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { RECALL_PATHS_MAX, memoryRecallPrompt, readMemoryRecall, initialMemory, skippedMemory, mergeById, withPassed, mergeRecall, acceptedMemory, memoryLine, memorySection, recallDecisions } from './memory-recall.mjs'

const REC = { id: 'decision-1', kind: 'decision', title: 't', body: 'b', scope: 'src', status: 'active', date: '2026-10-01', author: 'a', commit: 'abc1234', links: [] }

test('memory recall prompt: the skill first, the backend order by capability, read only, the record shape', () => {
  const p = memoryRecallPrompt(['src/a.rs', 'src/b.rs'], 'main')
  assert.match(p, /craft:memory skill with the Skill tool/)
  assert.match(p, /READ ONLY/)
  assert.match(p, /CRAFT_MEMORY[\s\S]*craft-memory:[\s\S]*ToolSearch[\s\S]*never by a server or tool name[\s\S]*project memory[\s\S]*\.craft\/memory\//)
  assert.match(p, /status active only: once for kind decision, once for kind question/)
  assert.match(p, /- src\/a\.rs\n- src\/b\.rs/)
  assert.match(p, /id, kind, title, body, scope, status, date, author, commit, deferred, links/)
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

test('memory source (realm #217): before the recall — not recalled, the launcher\'s records counted as an addition; the section carries one line', () => {
  assert.equal(memoryLine(initialMemory(0)), 'memory: none — not recalled — the run ended before its recall step')
  assert.equal(memoryLine(initialMemory(2)), 'memory: none — not recalled — the run ended before its recall step; plus 2 passed by the launcher')
  assert.equal(memorySection(initialMemory(0)), '\n\n## Memory\n- memory: none — not recalled — the run ended before its recall step\n')
})

test('memory source: an exit before the recall names why it skipped, the launcher\'s part kept', () => {
  assert.equal(memoryLine(skippedMemory(initialMemory(0), 'nothing to review')), 'memory: none — not recalled — nothing to review')
  assert.equal(memoryLine(skippedMemory(initialMemory(1), 'nothing to review')), 'memory: none — not recalled — nothing to review; plus 1 passed by the launcher')
  const launcher = initialMemory(1, true)
  assert.deepEqual(skippedMemory(launcher, 'nothing to review'), launcher, 'a launcher\'s recall is left as it is')
})

test('memory source: recalled by the launching audit — what it applied, or why it found none', () => {
  assert.equal(memoryLine(initialMemory(0, true, 'the recall agent died')), 'memory: recalled by the launching audit — none (the recall agent died)')
  assert.equal(memoryLine(acceptedMemory(initialMemory(2, true), [{ kind: 'decision' }, { kind: 'question' }])), 'memory: recalled by the launching audit — applied 1 decision(s) and 1 open question(s)')
  assert.equal(memoryLine(initialMemory(0, true)), 'memory: recalled by the launching audit — none')
  assert.equal(memoryLine(initialMemory(1, true, 'none found')), 'memory: recalled by the launching audit — none (none found); applied 1 passed by its launcher')
})

test('memory merge (realm #217): one record per id, the recalled one kept on a clash; a record without an id is kept for the reader to refuse', () => {
  const a = { id: 'a', v: 'recalled' }
  const r = mergeById([a, { id: 'b' }], [{ id: 'a', v: 'passed' }, { id: 'c' }, { title: 'no id' }])
  assert.deepEqual(r.merged, [a, { id: 'b' }, { id: 'c' }, { title: 'no id' }])
  assert.equal(r.added, 2)
  assert.deepEqual(withPassed({ source: 'none', count: 0, why: 'w' }, 0, 0), { source: 'none', count: 0, why: 'w' }, 'nothing passed: no part')
  assert.equal(memoryLine(withPassed({ source: 'recalled', count: 1, why: 'repo (w)' }, 2, 1)), 'memory: recalled 1 decision(s) from repo (w); plus 2 passed by the launcher (1 new)')
  assert.equal(memoryLine(withPassed({ source: 'recalled', count: 1, why: 'repo (w)' }, 2, 1), true), 'memory: returned 1 decision(s) from repo (w); plus 2 passed by the launcher (1 new); each nested review reports how many it applied')
})

test('mergeRecall: the recall read and merged with the passed records; refusals of both kept, the recall\'s apart', () => {
  const parse = (/** @type {unknown} */ raw) => {
    const list = /** @type {Array<{ id: string, kind?: string }>} */ (raw)
    return { decisions: list.filter(d => d.id !== 'bad'), refused: list.filter(d => d.id === 'bad').map(() => 'bad refused') }
  }
  const r = mergeRecall(
    { decisions: [{ id: 'x', kind: 'decision' }, { id: 'bad' }], memory: { source: 'recalled', count: 2, why: 'repo (w)' } },
    { decisions: [{ id: 'x' }, { id: 'y' }], refused: ['passed refused'] }, parse)
  assert.deepEqual(r.prior.decisions, [{ id: 'x', kind: 'decision' }, { id: 'y' }])
  assert.deepEqual(r.prior.refused, ['passed refused', 'bad refused'])
  assert.deepEqual(r.recalledRefused, ['bad refused'])
  assert.deepEqual(r.memory, { source: 'recalled', count: 1, why: 'repo (w)', passed: 2, added: 1 })
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

test('memory recall prompt: harness memory by an explicit path rule from the main checkout root, never a worktree or subdirectory', () => {
  const p = memoryRecallPrompt(['a.rs'], 'main')
  assert.match(p, /~\/\.claude\/projects\/<slug>\/memory\/[\s\S]*MEMORY\.md/)
  assert.match(p, /dirname "\$\(git rev-parse --path-format=absolute --git-common-dir\)"/)
  assert.match(p, /`pwd` only outside a git repo/)
  assert.match(p, /\/home\/alice\/src\/app` → `-home-alice-src-app`/)
  assert.doesNotMatch(p, /--claude-/)
  assert.match(p, /every character that is not an ASCII letter or digit replaced by `-`/)
  assert.match(p, /none — harness memory directory <path>\/memory not found/)
  assert.match(p, /never guess a near match/)
  assert.doesNotMatch(p, /every `\/` replaced by `-`/)
  assert.doesNotMatch(p, /names in this session's instructions/)
})

test('memory recall prompt and the memory skill: shipped text carries no realm reference and no author path', () => {
  const shipped = [memoryRecallPrompt(['a.rs'], 'main'), memoryRecallPrompt([], ''), fs.readFileSync(new URL('../skills/memory/backends.md', import.meta.url), 'utf8'), fs.readFileSync(new URL('../skills/memory/SKILL.md', import.meta.url), 'utf8')]
  for (const text of shipped) {
    assert.doesNotMatch(text, /@nick\/craft/)
    assert.doesNotMatch(text, /\/home\/ubuntu/)
  }
})

test('memory recall: read only — a decision that no longer holds is returned as stale, never superseded here, and named in one line', () => {
  const p = memoryRecallPrompt(['a.rs'], 'main')
  assert.match(p, /stale[\s\S]*supersede nothing[\s\S]*addressing-findings/)
  const r = readMemoryRecall({ backend: 'repo', why: 'w', decisions: [REC], stale: [{ id: 'decision-2', why: 'the validation is gone' }] }, 0)
  assert.deepEqual(r.decisions, [REC])
  assert.equal(memoryLine(r.memory), 'memory: recalled 1 decision(s) from repo (w); stale, left out: decision-2 (the validation is gone)')
  const only = readMemoryRecall({ backend: 'repo', why: 'w', decisions: [], stale: [{ id: 'd', why: 'gone\nnow' }, 'junk'] }, 0)
  assert.equal(memoryLine(only.memory), 'memory: none — w (backend repo); stale, left out: d (gone now)')
})

test('memory source: the count is what parsePriorDecisions accepted, not what the agent returned', () => {
  const r = readMemoryRecall({ backend: 'repo', why: 'w', decisions: [REC, { id: 'x' }] }, 0)
  assert.equal(memoryLine(acceptedMemory(r.memory, [{ kind: 'decision' }])), 'memory: recalled 1 decision(s) from repo (w)')
  assert.equal(acceptedMemory(r.memory, []).count, 0)
  const none = initialMemory(1)
  assert.deepEqual(acceptedMemory(none, []), none, 'nothing recalled: nothing to count')
})

test('memory recall (realm #204): the prompt asks for active questions too; they join the decisions tagged as questions and are counted apart', () => {
  const p = memoryRecallPrompt(['a.rs'], 'main')
  assert.match(p, /once for kind decision, once for kind question/)
  assert.match(p, /questions are the matching active question records/)
  const Q = { id: 'question-1', title: 'q', body: 'what answers it', scope: 'a.rs', status: 'active' }
  const r = readMemoryRecall({ backend: 'repo', why: 'w', decisions: [REC], questions: [Q, { ...Q, id: 'question-2', kind: 'question' }] }, 0)
  assert.deepEqual(r.decisions, [REC, { ...Q, kind: 'question' }, { ...Q, id: 'question-2', kind: 'question' }])
  assert.equal(memoryLine(r.memory, true), 'memory: returned 1 decision(s) and 2 open question(s) from repo (w); each nested review reports how many it applied')
  assert.equal(memoryLine(acceptedMemory(r.memory, [{ kind: 'decision' }, { kind: 'question' }])), 'memory: recalled 1 decision(s) and 1 open question(s) from repo (w)')
  assert.equal(memoryLine(acceptedMemory(r.memory, [{ kind: 'decision' }])), 'memory: recalled 1 decision(s) from repo (w)')
  const only = readMemoryRecall({ backend: 'repo', why: 'w', decisions: [], questions: [Q] }, 0)
  assert.equal(only.memory.source, 'recalled')
})

test('recallDecisions: a refused dispatch (the budget wall) is named, applies nothing, and does not throw', async () => {
  const r = await recallDecisions(async () => { throw new Error('agent budget exhausted (spent 1 of 1)') }, ['a.rs'], 'main')
  assert.deepEqual(r.decisions, [])
  assert.equal(r.memory.source, 'none')
  assert.match(memoryLine(r.memory), /^memory: none — the recall agent did not run \(agent budget exhausted \(spent 1 of 1\)\)/)
})
