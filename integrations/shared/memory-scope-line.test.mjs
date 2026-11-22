// A memory record whose scope carries a line, as earlier runs wrote it (realm @nick/craft, node #598):
// read as the path and its start line for matching, its id the hash of the scope as written, refused by a writer.
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { memoryRecordId, scopeLine, scopeLineProblem } from './memory-record-id.mjs'
import { readFileSync } from 'node:fs'
import { readPriorDecision } from './prior-decision-record.mjs'
import { parsePriorDecisions } from './prior-decisions.mjs'
import { findingPlan, sureMatchOf, triedOrder } from './prior-decision-match.mjs'
import { recordProblem } from './pr-thread-rule.mjs'

// The cases the CLI's split_scope_line is held to as well (cli/crates/craft-review/src/memory/id.rs).
const CASES = new URL('../../content/parity/scope-line-cases.json', import.meta.url)
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

test('a scope that carries a line or a range splits as the CLI splits it', () => {
  const cases = /** @type {[string, string, number][]} */ (JSON.parse(readFileSync(CASES, 'utf8')))
  for (const [given, scope, line] of cases) assert.deepEqual(scopeLine(given), { scope, line }, JSON.stringify(given))
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

test('two legacy records of one title at two ranges both apply, each at its own line and its id as written', () => {
  /** @param {string} scope */
  const at = scope => ({
    kind: 'decision',
    title: 'unwrap may panic',
    scope,
    body: 'ok here',
    date: '2026-01-01',
    author: 'a',
    status: 'active',
    lens: 'correctness',
  })
  const { decisions, refused } = parsePriorDecisions([at('src/a.rs:10-12'), at('src/a.rs:500-505')])
  assert.deepEqual(refused, [])
  assert.deepEqual(
    decisions.map(d => [d.scope, d.line, d.id]),
    [
      ['src/a.rs', 10, memoryRecordId('decision', 'unwrap may panic', 'src/a.rs:10-12')],
      ['src/a.rs', 500, memoryRecordId('decision', 'unwrap may panic', 'src/a.rs:500-505')],
    ],
  )
  // The record at the finding's own line is the sure match; the other range is at most a candidate the judge is asked about.
  const ordered = triedOrder(decisions)
  for (const [line, d] of /** @type {const} */ ([
    [11, 0],
    [501, 1],
  ]))
    assert.equal(
      findingPlan({ file: 'src/a.rs', line, title: 'unwrap may panic', lens: 'correctness', severity: 'Medium' }, ordered).sure?.d,
      decisions[d],
      `finding at ${line}`,
    )
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
