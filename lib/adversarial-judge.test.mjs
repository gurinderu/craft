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
import { judgeVotes, usableVote } from './adversarial-judge.mjs'

const SEV_RANK = { critical: 0, high: 1, medium: 2, low: 3 }
const F = { title: 'x', file: 'a.js', line: 1, severity: 'high' }
const vote = (lens, refuted, premiseSupported = true, severity = 'high') => ({ lens, refuted, premiseSupported, severity })
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

// The premise axis needs the same question asked of it, and for a while it did not get it. Counting
// an absent vote as unsupporting looks conservative and is not: it drops the finding out of
// `confirmed`, the verdict is built from `confirmed` alone, and the run prints a bare Approve. That
// is a missing vote deciding a critical finding, in the permissive direction.
test('an absent vote that would have settled the PREMISE decides nothing either', () => {
  const g = judge([vote('code', false, true), vote('exploit', false, false), missing('severity')])
  assert.equal(g.confirmed.length, 0)
  assert.equal(g.suspected.length, 1)
  assert.equal(g.suspected[0].undecidedByAbsence, true, 'the run must be able to say nobody decided this')

  // With that third lens present and supporting, the same finding confirms — which is what makes
  // the absent vote the deciding one.
  const present = judge([vote('code', false, true), vote('exploit', false, false), vote('severity', false, true)])
  assert.equal(present.confirmed.length, 1)
})

test('a premise the absent vote could not have rescued stays unsupported, and one it could not have sunk still confirms', () => {
  // Both extremes agree here, so the absence changes nothing and the answer stands — the marker
  // must not fire. A flag that goes up whenever a vote is missing is a flag people stop reading.
  const weak = judge([vote('code', false, false), vote('exploit', false, false), missing('severity')])
  assert.equal(weak.suspected.length, 1)
  assert.equal(weak.suspected[0].undecidedByAbsence, false)
  assert.equal(weak.suspected[0].premiseUnsupported, true)

  const strong = judge([vote('code', false, true), vote('exploit', false, true), missing('severity')])
  assert.equal(strong.confirmed.length, 1)
})

// The third axis, and the one that produces the verdict: `baseVerdict` reads Block from a confirmed
// critical/high, Warning from a medium, Approve otherwise. Every test above votes 'high' on every
// lens, which is exactly why an absent vote could quietly move the severity median for so long.
const at = (lens, severity) => vote(lens, false, true, severity)
const judgeAs = (severity, sink) => judgeVotes([{ ...F, severity }], [sink], SEV_RANK)

test('an absent vote that would have settled the SEVERITY decides nothing either', () => {
  // Received [high, low]: the median of two is the milder one, so absence alone turned Block into
  // Approve — both other axes agreeing, nothing flagged, a bare Approve on a run that could not say.
  const g = judgeAs('high', [at('code', 'high'), at('exploit', 'low'), missing('severity')])
  assert.equal(g.confirmed.length, 0)
  assert.equal(g.suspected[0].undecidedByAbsence, true)

  // With the third lens present the same finding confirms as high — which is what makes the absent
  // vote the deciding one.
  const present = judgeAs('high', [at('code', 'high'), at('exploit', 'low'), at('severity', 'high')])
  assert.equal(present.confirmed.length, 1)
  assert.equal(present.confirmed[0].severity, 'high')
})

test('absence that cannot cross the verdict boundary still decides, and does not lower the severity', () => {
  // critical vs high are both Block, so the absent vote could not have changed the outcome: flagging
  // it would fire the marker on a run where nothing was lost.
  const g = judgeAs('critical', [at('code', 'critical'), at('exploit', 'high'), missing('severity')])
  assert.equal(g.confirmed.length, 1)
  assert.equal(g.confirmed[0].severity, 'critical', 'silence must not pull the severity down')

  // And a panel that agrees keeps its severity with a member missing.
  const same = judgeAs('high', [at('code', 'high'), at('exploit', 'high'), missing('severity')])
  assert.equal(same.confirmed[0].severity, 'high')
})

test('the Warning/Approve boundary is guarded like the Block one', () => {
  const g = judgeAs('medium', [at('code', 'medium'), at('exploit', 'low'), missing('severity')])
  assert.equal(g.confirmed.length, 0)
  assert.equal(g.suspected[0].undecidedByAbsence, true)
})

test('a full panel calibrates exactly as before — the change touches only short panels', () => {
  assert.equal(judgeAs('high', [at('a', 'high'), at('b', 'low'), at('c', 'medium')]).confirmed[0].severity, 'medium')
  assert.equal(judgeAs('high', [at('a', 'critical'), at('b', 'high'), at('c', 'high')]).confirmed[0].severity, 'high')
})

// The gate that turns "nobody decided this" into a verdict must key on what the absent vote could
// have DECIDED, never on the label the finder attached. Both clauses of the finder-label test leaked:
// a complexity finding is excluded by lens although that lens emits `high` and gets a single verifier
// rather than a panel, and a `medium` finding is excluded by severity although one verifier is asked
// for a calibrated severity from the full enum and can return `critical`.
test('a dead sole verifier is blocking whatever label the finder attached', () => {
  for (const [severity, lens] of [['high', 'complexity'], ['medium', 'correctness'], ['low', 'correctness']]) {
    const g = judgeVotes([{ ...F, severity, lens }], [[missing('only')]], SEV_RANK)
    const f = g.suspected[0]
    assert.equal(f.undecidedByAbsence, true, `${severity}/${lens}: nobody decided it`)
    assert.equal(f.couldHaveBlocked, true, `${severity}/${lens}: the absent verdict could have blocked the run`)
  }
})

test('a decided finding never claims it could have blocked', () => {
  const healthy = judgeVotes([{ ...F, severity: 'medium' }], [[vote('combined', false, true, 'medium')]], SEV_RANK)
  assert.equal(healthy.confirmed[0].couldHaveBlocked, false)
  const short = judgeVotes([{ ...F, severity: 'high' }], [[at('code', 'high'), at('exploit', 'high'), missing('severity')]], SEV_RANK)
  assert.equal(short.confirmed[0].couldHaveBlocked, false)
})

// A verdict object we cannot read is not a verdict. `onResult` spreads whatever the agent returned,
// and this engine has already seen a live agent omit a schema-`required` field.
test('a malformed verdict is treated as an absence, not as a confirmation', () => {
  assert.equal(usableVote({}, SEV_RANK), false)
  assert.equal(usableVote(true, SEV_RANK), false)
  assert.equal(usableVote({ refuted: false, premiseSupported: true, severity: 'nonsense' }, SEV_RANK), false)
  assert.equal(usableVote({ refuted: false, premiseSupported: true, severity: 'high' }, SEV_RANK), true)
  assert.equal(usableVote({ refuted: false, premiseSupported: true, severity: 'not-an-issue' }, SEV_RANK), true)

  // Unread, it would have counted as non-refuting and non-supporting with severity `undefined`,
  // which survives into the median and comes back out as a confirmed finding with no severity —
  // and `baseVerdict` reads that as neither critical nor high, i.e. Approve.
  const g = judgeVotes([{ ...F, severity: 'critical' }], [[{ lens: 'code' }]], SEV_RANK)
  assert.equal(g.confirmed.length, 0)
  assert.equal(g.suspected[0].undecidedByAbsence, true)
  assert.equal(g.suspected[0].couldHaveBlocked, true)
})
