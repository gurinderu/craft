// A gate tool's finding matches a remembered record by its ruleId as well (realm @nick/craft, node #236):
// the sure match (same lens, line ±3) needs the same ruleId, a different ruleId is no candidate, a
// record without one goes to the judge; a finding of a review lens behaves as before. The record's
// ruleId is read, checked and carried from a PR thread's finding comment.
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { matchClass, matchFindings, sureMatchOf, MATCHED_BY_ANCHOR, MATCHED_BY_RULE } from './prior-decision-match.mjs'
import { readPriorDecision } from './prior-decision-record.mjs'
import { findingCommentBody, readFindingComment } from './finding-comment.mjs'
import { threadAnchor } from './pr-thread-rule.mjs'

/** @param {Record<string, unknown>} [over] @returns {any} */
const rec = (over = {}) => ({ id: 'decision-1', kind: 'decision', title: 'needless pass by value of Config', scope: 'src/a.rs', reason: 'by design', who: 'a', when: '2026-10-01', link: '', commit: 'abc1234', deferred: false, supersedes: [], line: 41, lens: 'clippy-pedantic', ruleId: 'clippy::needless_pass_by_value', ...over })
/** @param {Record<string, unknown>} [over] @returns {any} */
const fnd = (over = {}) => ({ title: 'cast may truncate u64 to u32', file: 'src/a.rs', line: 43, source: 'clippy-pedantic', ruleId: 'clippy::cast_possible_truncation', severity: 'Medium', why: 'truncation', ...over })

test('#232: a rejected lint A at line 41 does not set aside lint B (Medium) at line 43', async () => {
  assert.equal(matchClass(fnd(), rec()), '', 'another ruleId: not even a candidate')
  assert.equal(sureMatchOf([rec()])(fnd()), undefined)
  /** @type {string[]} */
  const prompts = []
  const f = fnd()
  const r = await matchFindings([f], [rec()], async p => { prompts.push(p); return { verdicts: [] } })
  assert.equal(r.matchOf(f), undefined)
  assert.equal(prompts.length, 0, 'no judge for a pair the ruleId already tells apart')
})

test('a tool finding with the same ruleId, lens and line ±3 matches without a judge; ruleId compared case- and space-blind', () => {
  const same = fnd({ ruleId: ' Clippy::Needless_Pass_By_Value ', title: 'Config passed by value needlessly' })
  assert.equal(matchClass(same, rec()), 'anchored')
  assert.equal(sureMatchOf([rec()])(same)?.how, MATCHED_BY_RULE)
  assert.equal(matchClass(fnd({ ruleId: rec().ruleId, line: 50 }), rec()), 'disputed', 'same rule, past the sure window: the judge')
  assert.equal(matchClass({ ...fnd({ source: 'tool' }), ruleId: 'X-1' }, rec({ lens: 'tool', ruleId: 'x-1' })), 'anchored', "lens 'tool'")
})

test('a record without ruleId against a tool finding goes to the judge, never a direct match', async () => {
  const old = rec({ ruleId: undefined })
  assert.equal(matchClass(fnd(), old), 'disputed')
  assert.equal(matchClass(fnd({ ruleId: '' }), rec()), 'disputed', 'a finding without ruleId: the judge too')
  const f = fnd()
  const no = await matchFindings([f], [old], async () => ({ verdicts: [{ pair: 0, same: false, why: 'another lint' }] }))
  assert.equal(no.matchOf(f), undefined)
  const yes = await matchFindings([f], [old], async () => ({ verdicts: [{ pair: 0, same: true, why: 'same lint' }] }))
  assert.equal(yes.matchOf(f)?.how, 'matched by judge: same lint')
})

test('a finding of a review lens ignores ruleId: same lens and line ±3 matches as before', () => {
  const lensRec = rec({ lens: 'safety', ruleId: 'SAF-001' })
  const lensFnd = fnd({ source: 'safety', ruleId: 'SAF-002' })
  assert.equal(matchClass(lensFnd, lensRec), 'anchored')
  assert.equal(sureMatchOf([lensRec])(lensFnd)?.how, MATCHED_BY_ANCHOR)
  assert.equal(matchClass(fnd({ source: 'safety' }), rec({ lens: 'safety', ruleId: undefined })), 'anchored')
})

test('the record reader keeps ruleId and refuses a malformed one by name', () => {
  /** @param {unknown} ruleId @returns {any} */
  const read = ruleId => readPriorDecision({ ...rec(), ruleId }, 'decision #0')
  assert.equal(read(' DEP-001 ').ruleId, 'DEP-001')
  assert.equal(read(undefined).ruleId, undefined)
  assert.match(read(7), /ruleId 7 is not a string/)
  assert.match(read('x'.repeat(121)), /ruleId is 121 chars/)
  assert.match(read('a\u0007b'), /ruleId contains a control character/)
})

test('the finding comment carries ruleId on a hidden line, and a thread hands it to the record', () => {
  const body = findingCommentBody({ severity: 'Medium', title: 't', why: 'w', fix: 'f', source: 'clippy-pedantic', ruleId: 'clippy::cast_possible_truncation' })
  assert.match(body, /^<!-- craft-rule: clippy::cast_possible_truncation -->$/m)
  const read = readFindingComment(body)
  assert.deepEqual(read, { severity: 'Medium', title: 't', lens: 'clippy-pedantic', ruleId: 'clippy::cast_possible_truncation' })
  assert.doesNotMatch(findingCommentBody({ severity: 'Low', title: 't', ruleId: 'bad rule -->' }), /craft-rule/, 'an unfit ruleId is left out')
  assert.equal(readFindingComment(findingCommentBody({ severity: 'Low', title: 't', ruleId: '' }))?.ruleId, undefined)
  assert.deepEqual(threadAnchor(/** @type {any} */ ({ originalLine: 43 }), read ?? {}), { line: 43, lens: 'clippy-pedantic', ruleId: 'clippy::cast_possible_truncation' })
})
