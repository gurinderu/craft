// What a dead verifier must NOT be able to do to a finding.
//
// Measured on the shipped formula on 2026-09-02: a 3-lens panel voting [refute, confirm, confirm]
// confirms the finding; drop one confirming lens and `refutes * 2 < votes.length` turns false, so
// the SAME finding is filed as refuted — and refuted findings never reach the report, they are fed
// forward to the coverage critic as "adversarially disproven, do not re-report". The mirror case is
// as bad: with two lenses dead the lone survivor confirms unconditionally, so one flaky lens can
// manufacture a Block. Silence must not vote in either direction.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { judgeVotes } from './adversarial-judge.mjs'

const SEV_RANK = { critical: 0, high: 1, medium: 2, low: 3 }
const F = { title: 'x', file: 'a.js', line: 1, severity: 'high' }
const vote = (lens, refuted) => ({ lens, refuted, premiseSupported: true, severity: 'high' })
const missing = lens => ({ lens, missing: true })
const judge = sink => judgeVotes([F], [sink], SEV_RANK)

test('a whole panel that splits 2-1 in favour confirms the finding', () => {
  const g = judge([vote('code', true), vote('exploit', false), vote('severity', false)])
  assert.equal(g.confirmed.length, 1)
  assert.equal(g.refuted.length, 0)
})

test('a panel one member short decides NOTHING — it does not refute', () => {
  // Before the fix this exact input produced refuted:1, deleting a real high finding from the run.
  const g = judge([vote('code', true), vote('exploit', false), missing('severity')])
  assert.equal(g.refuted.length, 0, 'a check that never ran must not count as a refutation')
  assert.equal(g.confirmed.length, 0, 'nor may it confirm — an unfinished panel decides neither way')
  assert.equal(g.suspected.length, 1, 'it falls to Suspected, which is what the not-run note claims')
})

test('a lone surviving vote cannot confirm on its own', () => {
  // The mirror: 0 refutes of 1 vote satisfies `refutes * 2 < votes.length`, so before the fix one
  // flaky lens could carry a finding to Confirmed — and a Confirmed high is a Block.
  const g = judge([vote('code', false), missing('exploit'), missing('severity')])
  assert.equal(g.confirmed.length, 0)
  assert.equal(g.suspected.length, 1)
})

test('a single-verifier finding is unaffected — the common path keeps working', () => {
  assert.equal(judge([vote('combined', false)]).confirmed.length, 1)
  assert.equal(judge([vote('combined', true)]).refuted.length, 1)
  assert.equal(judge([]).suspected.length, 1)
})

test('an unsupported premise still lands in Suspected, never in refuted', () => {
  const weak = { lens: 'code', refuted: false, premiseSupported: false, severity: 'high' }
  const g = judge([weak, { ...weak, lens: 'exploit' }, { ...weak, lens: 'severity' }])
  assert.equal(g.suspected.length, 1)
  assert.equal(g.refuted.length, 0)
})
