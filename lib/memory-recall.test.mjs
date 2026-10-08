import fs from 'node:fs'
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { RECALL_PATHS_MAX, memoryRecallPrompt, readMemoryRecall, initialMemory, skippedMemory, mergeById, withPassed, mergeRecall, mergeAndRead, memoryParts, readLaunch, acceptedMemory, memoryLine, memorySection, recallDecisions } from './memory-recall.mjs'
import { parsePriorDecisions } from './prior-decisions.mjs'

const REC = { id: 'decision-0d2edebb6f', kind: 'decision', title: 't', body: 'b', scope: 'src', status: 'active', date: '2026-10-01', author: 'a', commit: 'abc1234', links: [] }

test('memory recall prompt: the skill first, the backend order by capability, read only, the record shape', () => {
  const p = memoryRecallPrompt(['src/a.rs', 'src/b.rs'], 'main')
  assert.match(p, /craft:memory skill with the Skill tool/)
  assert.match(p, /READ ONLY/)
  assert.match(p, /CRAFT_MEMORY[\s\S]*craft-memory:[\s\S]*ToolSearch[\s\S]*never by a server or tool name[\s\S]*project memory[\s\S]*\.craft\/memory\//)
  assert.match(p, /status active only: once for kind decision, once for kind question/)
  assert.match(p, /- src\/a\.rs\n- src\/b\.rs/)
  assert.match(p, /id, kind, title, body, scope, status, date, author, commit, deferred, line, lens, toolRule, links \(line, lens and toolRule only when the record carries them/)
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

test('memory source (realm #218): before the recall — not recalled, the launcher\'s records counted as an addition; the section carries one line', () => {
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

test('memory merge (realm #218): one record per id, the recalled one kept on a clash; a record without an id is kept for the reader to refuse', () => {
  const a = { id: 'a', v: 'recalled' }
  const r = mergeById([a, { id: 'b' }], [{ id: 'a', v: 'passed' }, { id: 'c' }, { title: 'no id' }])
  assert.deepEqual(r.merged, [a, { id: 'b' }, { id: 'c' }, { title: 'no id' }])
  assert.deepEqual(r.addedAt, [1, 2])
  const unread = mergeById([a, { id: 'b' }], [{ id: 'a', v: 'passed' }, { id: 'b', v: 'passed' }], x => x === a)
  assert.deepEqual(unread.addedAt, [1], 'an unreadable recalled record holds no id: the passed one with that id is kept')
  assert.deepEqual(withPassed({ source: 'none', count: 0, why: 'w' }, 0, 0), { source: 'none', count: 0, why: 'w' }, 'nothing passed: no part')
  assert.equal(memoryLine(withPassed({ source: 'recalled', count: 1, why: 'repo (w)' }, 2, 1)), 'memory: recalled 1 decision(s) from repo (w); plus 2 passed by the launcher (1 new)')
  assert.equal(memoryLine(withPassed({ source: 'recalled', count: 1, why: 'repo (w)' }, 2, 1), true), 'memory: returned 1 decision(s) from repo (w); plus 2 passed by the launcher (1 new); each nested review reports how many it applied')
})

/** @param {string} id @param {Record<string, unknown>} [over] */
const rec = (id, over = {}) => ({ ...REC, id, title: `${id}a ${id}b`, ...over })

test('mergeRecall (realm #218): merged raw by id (the recalled record kept), read once; refusals name their part, the recall\'s apart', () => {
  const r = mergeRecall(
    { decisions: [rec('x'), { id: 'bad' }], memory: { source: 'recalled', count: 2, why: 'repo (w)' } },
    [rec('x', { body: 'old' }), { id: 'p-bad' }, rec('y')], parsePriorDecisions)
  assert.deepEqual(r.prior.decisions.map(d => [d.id, d.reason]), [['x', 'b'], ['y', 'b']])
  assert.deepEqual(r.prior.refused, ['recalled decision #1 (bad) lacks a title and a reason', 'passed decision #1 (p-bad) lacks a title and a reason'])
  assert.deepEqual(r.recalledRefused, ['recalled decision #1 (bad) lacks a title and a reason'], 'a passed record\'s refusal was logged at launch')
  assert.deepEqual(r.memory, { source: 'recalled', count: 1, why: 'repo (w)', passed: 2, added: 1 }, 'new: the applied passed records the recall did not hold (y)')
  const notList = mergeRecall({ decisions: [rec('x')], memory: { source: 'recalled', count: 1, why: 'w' } }, '{nope', parsePriorDecisions)
  assert.match(String(notList.prior.refused[0]), /arrived as a string/, 'a launcher\'s argument that is no list is still named')
  assert.equal(notList.prior.decisions.length, 1)
})

test('mergeRecall (realm #218): ONE cap across both parts — 80 recalled + 80 passed → 100 applied, 60 refused by name', () => {
  const r = mergeRecall(
    { decisions: Array.from({ length: 80 }, (_, k) => rec(`r${k}`)), memory: { source: 'recalled', count: 80, why: 'w' } },
    Array.from({ length: 80 }, (_, k) => rec(`p${k}`)), parsePriorDecisions)
  assert.equal(r.prior.decisions.length, 100)
  assert.equal(r.prior.decisions.at(-1)?.id, 'p19')
  assert.equal(r.prior.refused.length, 1)
  assert.match(String(r.prior.refused[0]), /^60 decision\(s\) past the cap of 100 .*: passed decision #20 \(p20\), .*passed decision #79 \(p79\)$/)
  assert.equal(String(r.prior.refused[0]).match(/passed decision #/g)?.length, 60)
  assert.deepEqual(r.recalledRefused, r.prior.refused, 'the cap is news at recall time: logged')
})

test('mergeRecall (realm #218): "new" counts the passed records applied after the one read, not the raw list', () => {
  const junk = mergeRecall({ decisions: [rec('x')], memory: { source: 'recalled', count: 1, why: 'repo (w)' } }, [rec('x'), { id: 'junk' }, rec('y')], parsePriorDecisions)
  assert.equal(memoryLine(junk.memory), 'memory: recalled 1 decision(s) from repo (w); plus 2 passed by the launcher (1 new)')
  const capped = mergeRecall({ decisions: [rec('r0')], memory: { source: 'recalled', count: 1, why: 'repo (w)' } }, Array.from({ length: 150 }, (_, k) => rec(`p${k}`)), parsePriorDecisions)
  assert.equal(capped.prior.decisions.length, 100)
  assert.equal(memoryLine(capped.memory), 'memory: recalled 1 decision(s) from repo (w); plus 100 passed by the launcher (99 new)', 'the cap bounds the new count')
})

test('mergeRecall (realm #218): a malformed recalled record does not claim its id — the valid passed one is applied, the recalled one refused by name', () => {
  const r = mergeRecall({ decisions: [{ id: 'x' }], memory: { source: 'recalled', count: 1, why: 'repo (w)' } }, [rec('x', { body: 'passed' })], parsePriorDecisions)
  assert.deepEqual(r.prior.decisions.map(d => [d.id, d.reason]), [['x', 'passed']])
  assert.deepEqual(r.prior.refused, ['recalled decision #0 (x) lacks a title and a reason'])
  assert.deepEqual(r.recalledRefused, r.prior.refused)
  assert.deepEqual(r.memory, { source: 'recalled', count: 0, why: 'repo (w)', passed: 1, added: 1 })
  const f = mergeAndRead([{ id: 'x' }], [rec('x', { body: 'passed' })], parsePriorDecisions)
  assert.deepEqual(f.merged, [{ id: 'x' }, rec('x', { body: 'passed' })])
  assert.deepEqual(f.parts, { recalled: 1, passed: 1 }, 'the split adds up to the forwarded list')
  assert.equal(f.read.passed, 1)
})

test('mergeRecall (realm #218): a well-formed recalled record that is not active holds its id — the stale passed copy is not applied', () => {
  const stale = rec('x', { status: 'superseded' })
  const r = mergeRecall({ decisions: [stale], memory: { source: 'recalled', count: 1, why: 'repo (w)' } }, [rec('x', { body: 'passed' }), rec('y')], parsePriorDecisions)
  assert.deepEqual(r.prior.decisions.map(d => d.id), ['y'])
  assert.deepEqual(r.prior.refused, ['recalled decision #0 (x) is not active (status "superseded")'])
  assert.deepEqual(r.memory, { source: 'recalled', count: 0, why: 'repo (w)', passed: 2, added: 1 })
  const f = mergeAndRead([stale], [rec('x', { body: 'passed' }), rec('y')], parsePriorDecisions)
  assert.deepEqual(f.merged, [stale, rec('y')])
  assert.deepEqual(f.parts, { recalled: 1, passed: 1 })
})

test('mergeRecall (realm #224): a passed record an inactive entry names — by id, store id or kind+title+scope — is held back and named once; the rest applied', () => {
  const inactive = readMemoryRecall({ backend: 'mcp', why: 'w', decisions: [], inactive: [
    { id: 'x', kind: 'decision', title: 'xa xb', scope: 'src', status: 'withdrawn' },
    { id: 'n-9', storeId: 'n-9', kind: 'decision', title: 'gone', scope: 'src', status: 'superseded' },
  ] }, 0)
  const byTitle = { ...rec('z'), id: undefined, title: 'xa xb' }
  const r = mergeRecall({ ...inactive, memory: { source: 'recalled', count: 0, why: 'repo (w)' } }, [rec('x'), rec('y'), { ...rec('n-9'), title: 'other' }, byTitle], parsePriorDecisions)
  assert.deepEqual(r.prior.decisions.map(d => d.id), ['y'])
  assert.deepEqual(r.prior.refused.filter(x => /in memory/.test(x)), [
    'passed decision #0 (x) not applied: withdrawn in memory (the withdrawn record carries no ISO date to compare)',
    'passed decision #2 (n-9) not applied: superseded in memory (the superseded record carries no ISO date to compare)',
    `passed decision #3 (${String(r.prior.refused[2]).match(/\((decision-[0-9a-f]{10})\)/)?.[1]}) not applied: withdrawn in memory (the withdrawn record carries no ISO date to compare)`,
  ])
  assert.deepEqual(r.recalledRefused, r.prior.refused, 'news at recall time: logged')
  const f = mergeAndRead([], [rec('x'), rec('y')], parsePriorDecisions, inactive.inactive)
  assert.deepEqual(f.merged, [rec('y')])
  assert.deepEqual(f.parts, { recalled: 0, passed: 1 })
  assert.deepEqual(f.blocked, ['passed decision #0 (x) not applied: withdrawn in memory (the withdrawn record carries no ISO date to compare)'])
})

test('launch under an audit (realm #218): _memoryParts splits the line into both parts; off-shape → one total', () => {
  assert.deepEqual(memoryParts({ recalled: 1, passed: 2 }, [1, 2, 3]), { recalled: 1, passed: 2 })
  for (const bad of [{ recalled: 1, passed: 1 }, { recalled: 1.5, passed: 1.5 }, { recalled: -1, passed: 4 }, null, 'x']) assert.equal(memoryParts(bad, [1, 2, 3]), null, JSON.stringify(bad))
  assert.equal(memoryParts({ recalled: 0, passed: 0 }, 'x'), null)
  const list = [rec('r0'), rec('p0'), { id: 'p-bad' }]
  const split = readLaunch(list, true, '', { recalled: 1, passed: 2 }, parsePriorDecisions)
  assert.deepEqual(split.prior.refused, ['passed decision #1 (p-bad) lacks a title and a reason'])
  assert.equal(memoryLine(split.memory), 'memory: recalled by the launching audit — applied 2 decision(s) — 1 recalled, 1 of the 2 passed by its launcher')
  const whole = readLaunch(list, true, '', null, parsePriorDecisions)
  assert.deepEqual(whole.prior.refused, ['decision #2 (p-bad) lacks a title and a reason'])
  assert.equal(memoryLine(whole.memory), 'memory: recalled by the launching audit — applied 2 decision(s)')
  const own = readLaunch(list, false, '', { recalled: 1, passed: 2 }, parsePriorDecisions)
  assert.equal(memoryLine(own.memory), 'memory: none — not recalled — the run ended before its recall step; plus 2 passed by the launcher', 'no split without _recalled')
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
  const Q = { id: 'question-000000000a', title: 'q', body: 'what answers it', scope: 'a.rs', status: 'active' }
  const r = readMemoryRecall({ backend: 'repo', why: 'w', decisions: [REC], questions: [Q, { ...Q, id: 'question-000000000b', kind: 'question' }] }, 0)
  assert.deepEqual(r.decisions, [REC, { ...Q, kind: 'question' }, { ...Q, id: 'question-000000000b', kind: 'question' }])
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
