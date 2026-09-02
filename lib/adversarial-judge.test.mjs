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

test('a panel short the DECIDING vote decides nothing', () => {
  // 1-1 with one lens dead: the absent vote is the one that settles it. Before the fix this exact
  // input was filed as refuted, deleting a real high finding from the run.
  const g = judge([vote('code', true), vote('exploit', false), missing('severity')])
  assert.equal(g.refuted.length, 0, 'a check that never ran must not count as a refutation')
  assert.equal(g.confirmed.length, 0, 'nor may it confirm — here the absent vote was the deciding one')
  assert.equal(g.suspected.length, 1)
  assert.equal(g.suspected[0].undecidedByAbsence, true, 'and the run must be able to say so in the verdict')
})

test('a panel short a vote that could NOT have changed the answer still decides', () => {
  // The inverse trap, and the more dangerous one: demoting on any absence drops a critical finding
  // out of `confirmed`, and the verdict is built from `confirmed` alone — a silent Approve in place
  // of the Block two independent lenses had earned. Here even a refuting third vote leaves 1*2 < 3.
  const g = judge([vote('code', false), vote('exploit', false), missing('severity')])
  assert.equal(g.confirmed.length, 1, 'two unrefuted votes of three confirm whatever the third said')
  assert.equal(g.suspected.length, 0)

  // Symmetrically, a finding already refuted 2-1 stays refuted: the absent vote cannot save it.
  const r = judge([vote('code', true), vote('exploit', true), missing('severity')])
  assert.equal(r.refuted.length, 1)
})

test('a lone surviving vote cannot confirm on its own', () => {
  // 0 refutes of 1 RECEIVED vote satisfies the old formula, so before the fix one flaky lens could
  // carry a finding to Confirmed — and a Confirmed high is a Block. Against the full panel the two
  // absent votes could have refuted it 2-1, so nobody decided this.
  const g = judge([vote('code', false), missing('exploit'), missing('severity')])
  assert.equal(g.confirmed.length, 0)
  assert.equal(g.suspected.length, 1)
  assert.equal(g.suspected[0].undecidedByAbsence, true)
})

test('a whole panel that never returned is undecided, not clean', () => {
  const g = judge([missing('code'), missing('exploit'), missing('severity')])
  assert.equal(g.confirmed.length + g.refuted.length, 0)
  assert.equal(g.suspected[0].undecidedByAbsence, true)
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
