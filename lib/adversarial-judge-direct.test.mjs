// Direct tests of lib/adversarial-judge.mjs at the edges adversarial-judge.test.mjs leaves open: a
// vote missing one of its fields, the exact majority boundaries on the refute and premise axes, the
// severity median over only the confirming votes, a severity table not written in rank order, and
// what an empty panel reports.
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { judgeVotes, usableVote } from './adversarial-judge.mjs'

const SEV_RANK = { critical: 0, high: 1, medium: 2, low: 3 }
/** @param {string} severity */
const finding = (severity = 'high') => ({ title: 'x', severity })
/** @param {boolean} refuted @param {string} [severity] @param {boolean} [premiseSupported] */
const vote = (refuted, severity = 'high', premiseSupported = true) => ({ refuted, premiseSupported, severity })
const MISSING = { missing: true }
/** @param {unknown[]} sink @param {string} [severity] */
const judge = (sink, severity) => judgeVotes([finding(severity)], [sink], SEV_RANK)

test('usableVote needs both booleans and a known severity, and reads null as unusable', () => {
  assert.equal(usableVote(null, SEV_RANK), false)
  assert.equal(usableVote({ premiseSupported: true, severity: 'high' }, SEV_RANK), false)
  assert.equal(usableVote({ refuted: false, severity: 'high' }, SEV_RANK), false)
  assert.equal(usableVote({ refuted: true, premiseSupported: 'yes', severity: 'high' }, SEV_RANK), false)
  assert.equal(usableVote({ refuted: true, premiseSupported: false, severity: 'not-an-issue' }, SEV_RANK), true)
})

test('a null vote in the sink is an absence, not a crash', () => {
  const g = judge([vote(false), vote(false), null])
  assert.equal(g.confirmed.length, 1)
})

test('refute axis: a 1-1 split is refuted, and a deciding absence at exactly half is undecided', () => {
  assert.equal(judge([vote(true), vote(false)]).refuted.length, 1)
  const g = judge([vote(true), vote(false), vote(false), MISSING])
  assert.deepEqual([g.confirmed.length, g.refuted.length, g.suspected.length], [0, 0, 1])
  // Two of four refute: the finding falls whatever the absent vote says, so the absence decides nothing.
  const h = judge([vote(true), vote(true), vote(false), MISSING])
  assert.deepEqual([h.refuted.length, h.suspected.length], [1, 0])
})

test('premise axis: support from exactly half the panel is not support', () => {
  const g = judge([vote(false, 'high', true), vote(false, 'high', false)])
  assert.equal(g.suspected.length, 1)
  assert.equal(g.suspected[0]?.premiseUnsupported, true)
})

test('a refuted finding stays refuted even when its premise is unsupported too', () => {
  const g = judge([vote(true, 'high', false), vote(true, 'high', false), vote(false, 'high', false)])
  assert.deepEqual([g.refuted.length, g.suspected.length], [1, 0])
})

test('the calibrated severity is the median of the CONFIRMING votes only', () => {
  const g = judge([vote(true, 'critical'), vote(true, 'critical'), vote(false, 'medium'), vote(false, 'low'), vote(false, 'low')], 'medium')
  assert.equal(g.confirmed[0]?.severity, 'low')
})

test('a confirming "not-an-issue" vote carries no severity into the median', () => {
  const g = judge([vote(false, 'low'), vote(false, 'not-an-issue'), vote(false, 'high')], 'medium')
  assert.equal(g.confirmed[0]?.severity, 'low')
})

test('a decided finding never reads as one that could have blocked', () => {
  assert.equal(judge([vote(false), vote(false), vote(false)]).confirmed[0]?.couldHaveBlocked, false)
})

test('an undecided finding could have blocked only when its worst reachable severity blocks', () => {
  // refute axis undecided; the one confirming vote says low, so even a critical stand-in medians to low.
  const g = judge([vote(false, 'low'), vote(true, 'low'), MISSING], 'low')
  assert.equal(g.suspected[0]?.undecidedByAbsence, true)
  assert.equal(g.suspected[0]?.couldHaveBlocked, false)
})

test('the severity table may come in any key order: the worst rank is still what an absence could reach', () => {
  const scrambled = { low: 3, critical: 0, medium: 2, high: 1 }
  const g = judgeVotes([finding('low')], [[vote(false, 'low'), MISSING, MISSING]], scrambled)
  assert.equal(g.suspected[0]?.couldHaveBlocked, true)
})

test('a finding with no panel at all is suspected, undecided by nothing, and refuted by nobody', () => {
  for (const sink of [[], [[]]]) {
    const g = judgeVotes([finding()], sink, SEV_RANK)
    assert.deepEqual([g.refuted.length, g.suspected.length], [0, 1])
    assert.deepEqual([g.suspected[0]?.undecidedByAbsence, g.suspected[0]?.couldHaveBlocked], [false, false])
  }
})
