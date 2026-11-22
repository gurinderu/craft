// A memory record whose scope carries a line, as earlier runs wrote it (realm @nick/craft, node #598):
// read as the path and its start line, one id with the path alone, refused by a writer.
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { memoryRecordId, scopeLine, scopeLineProblem } from './memory-record-id.mjs'
import { readPriorDecision, skillRecordId } from './prior-decision-record.mjs'
import { sureMatchOf } from './prior-decision-match.mjs'
import { recordProblem } from './pr-thread-rule.mjs'

const SCOPE = 'src/api/src/users.rs:1230-1245'
/** An old record: its id the store kept, hashed when its scope still held the range. */
const old = () => ({
  id: 'decision-0123456789',
  kind: 'decision',
  title: 'unchecked index',
  scope: SCOPE,
  body: 'bounded upstream',
  lens: 'correctness',
})

test('a scope that carries a line or a range splits into the path and its start line, any other as it is', () => {
  assert.deepEqual(scopeLine(` ${SCOPE} `), { scope: 'src/api/src/users.rs', line: 1230 })
  assert.deepEqual(scopeLine('src/users.rs:42'), { scope: 'src/users.rs', line: 42 })
  for (const kept of ['src/users.rs', '.', 'src:', ':12', 'src/a.rs:x', 'src/a.rs:1-x', 'src/a.rs::3', 'a:1234567890'])
    assert.deepEqual(scopeLine(kept), { scope: kept, line: 0 }, kept)
})

test('an old range record is recalled as its path and start line and matches a finding there', () => {
  const d = readPriorDecision(old(), 0)
  if (typeof d === 'string') assert.fail(d)
  assert.deepEqual([d.scope, d.line, d.id], ['src/api/src/users.rs', 1230, old().id])
  const f = { file: 'src/api/src/users.rs', line: 1231, title: 'index may panic', lens: 'correctness', severity: 'Medium' }
  assert.equal(sureMatchOf([d])(f)?.how, 'matched by file:line+lens')
})

test("the record's own line wins over the one its scope carries", () => {
  const d = readPriorDecision({ ...old(), line: 1240 }, 0)
  assert.ok(typeof d !== 'string' && d.line === 1240)
})

test('the same fact written with and without a range has one id', () => {
  assert.equal(memoryRecordId('decision', 't', SCOPE), memoryRecordId('decision', 't', 'src/api/src/users.rs'))
  assert.equal(skillRecordId(old()), skillRecordId({ ...old(), scope: 'src/api/src/users.rs' }))
  const { id: _, ...bare } = old()
  const d = readPriorDecision(bare, 0)
  assert.ok(typeof d !== 'string' && d.id === memoryRecordId('decision', 'unchecked index', 'src/api/src/users.rs'))
})

test('a scope with any other colon is still refused', () => {
  const why = readPriorDecision({ ...old(), scope: 'src/users.rs:12a' }, 0)
  assert.ok(typeof why === 'string' && why.includes('has a character outside'), JSON.stringify(why))
})

test('a writer refuses a scope that carries a line and names the corrected form', () => {
  assert.equal(scopeLineProblem(SCOPE), `scope "${SCOPE}" carries a line: write scope=src/api/src/users.rs, line=1230`)
  assert.equal(scopeLineProblem('src/users.rs'), '')
  assert.equal(recordProblem('t', SCOPE, 'abcdef1', 'r'), scopeLineProblem(SCOPE))
  assert.equal(recordProblem('t', 'src/users.rs', 'abcdef1', 'r'), '')
})
