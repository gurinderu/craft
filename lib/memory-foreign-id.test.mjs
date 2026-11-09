// A memory backend that keeps its own ids (an MCP server with its own write skill): its recalled record
// carries a foreign id, a launcher's hand-built copy of the same record carries none and gets the skill's
// id. The two are one record — keyed by the id derived from kind, title and scope — and the ENGINE sets
// the recalled record's id to the skill's, keeping the store's own in links as `store: <id>`. A record the
// store withdrew or superseded comes back only in the recall's `inactive` list and blocks any passed copy
// (realm @nick/craft, nodes #222, #224). A record without an id and without a scope is refused by name.
import crypto from 'node:crypto'
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { memoryRecallPrompt, mergeById, readMemoryRecall } from './memory-recall.mjs'
/** @param {string} kind @param {string} title @param {string} scope */
const skillId = (kind, title, scope) => `${kind}-${crypto.createHash('sha256').update(`${kind}\n${title}\n${scope}`).digest('hex').slice(0, 10)}`

const TITLE = 'unwrap in parser may panic'
const STORED = { id: 'node-1849', kind: 'decision', title: TITLE, body: 'the store says so', scope: 'src/parse.rs', status: 'active', date: '2026-10-01', author: 'alice', commit: 'abc1234', links: ['https://x/pr/1#c1'] }
const PASSED = { kind: 'decision', title: TITLE, body: 'an old reason from a thread', scope: 'src/parse.rs', date: '2026-09-01', author: 'bob', commit: 'abc1234', links: ['https://x/pr/1#c0'] }
const SKILL_ID = skillId('decision', TITLE, 'src/parse.rs')

test('foreign id: mergeById keys on the derived id when the ids differ, both records carrying kind, title and scope', () => {
  const passedWithId = { ...PASSED, id: SKILL_ID }
  assert.deepEqual(mergeById([STORED], [PASSED, passedWithId]).addedAt, [])
  const other = { ...PASSED, title: 'another title entirely' }
  assert.deepEqual(mergeById([STORED], [other]).addedAt, [0], 'a different title is a different record')
})

test('foreign id: the engine sets the id — a store id, or a wrong hash beside a store: link, becomes the skill id; the store id kept in links', () => {
  const [stored] = readMemoryRecall({ backend: 'mcp', why: 'w', decisions: [STORED] }, 0).decisions
  assert.deepEqual(stored, { ...STORED, id: SKILL_ID, links: [...STORED.links, 'store: node-1849'] })
  const wrong = { ...STORED, id: 'decision-0123456789', links: ['store: node-1849'] }
  assert.deepEqual(readMemoryRecall({ backend: 'mcp', why: 'w', decisions: [wrong] }, 0).decisions, [{ ...wrong, id: SKILL_ID }])
  const right = { ...STORED, id: SKILL_ID, links: [] }
  assert.deepEqual(readMemoryRecall({ backend: 'repo', why: 'w', decisions: [right] }, 0).decisions, [right], 'a skill id is left as it is')
})

test('foreign id: the recall prompt asks for kind, title, scope and the store id in links, and for the inactive ids — never a hash', () => {
  const p = memoryRecallPrompt(['src/a.rs'], 'main')
  assert.match(p, /`store: <id>`/)
  assert.doesNotMatch(p, /sha256/)
  assert.match(p, /inactive[\s\S]*superseded[\s\S]*withdrawn/)
  assert.match(p, /\{id, storeId, kind, title, scope, status, date\}[\s\S]*last-write date[\s\S]*unless the handed record is dated later/)
})
