import test from 'node:test'
import assert from 'node:assert/strict'
import { wrapVerdict, tallyVerification, verificationIncomplete, unusedCratesResult, VERIFY_MIN_JUDGED } from './audit-verification.mjs'

const cand = n => ({ title: `orphan-member: c${n}`, location: `c${n}/Cargo.toml`, detail: 'nothing depends on it' })
const REFUTE = { confirmedUnused: false, evidence: 'used behind a feature gate' }
const CONFIRM = { confirmedUnused: true, evidence: 'no references anywhere', removal: 'drop the member' }

// The whole finding: agent() RESOLVES to null on a dead subagent, so the wrapper must keep it null.
test('wrapVerdict keeps a resolved-null verdict null (the common death mode)', () => {
  const c = cand(1)
  assert.equal(wrapVerdict(c, null), null)
  assert.equal(wrapVerdict(c, undefined), null)
  assert.deepEqual(wrapVerdict(c, REFUTE), { c, v: REFUTE })
})

test('a resolved-null verifier counts as a death, not a refutation', () => {
  const cs = [cand(1), cand(2)]
  // What parallel() hands back: thunk 1 refuted, thunk 2's agent resolved null.
  const verdicts = [wrapVerdict(cs[0], REFUTE), wrapVerdict(cs[1], null)]
  const t = tallyVerification(cs, verdicts)
  assert.deepEqual({ judged: t.judged, refuted: t.refuted, died: t.died, confirmed: t.confirmed }, { judged: 1, refuted: 1, died: 1, confirmed: 0 })
})

test('a throwing verifier counts as a death too (parallel turns a throw into null)', () => {
  const cs = [cand(1), cand(2)]
  const verdicts = [wrapVerdict(cs[0], CONFIRM), null]
  const t = tallyVerification(cs, verdicts)
  assert.deepEqual({ judged: t.judged, refuted: t.refuted, died: t.died, confirmed: t.confirmed }, { judged: 1, refuted: 0, died: 1, confirmed: 1 })
})

test('refuteRate is over what was judged, never over the candidates', () => {
  const cs = [cand(1), cand(2), cand(3), cand(4)]
  // 2 judged (1 refuted, 1 confirmed), 2 dead. Over candidates the old arithmetic said 0.75.
  const t = tallyVerification(cs, [wrapVerdict(cs[0], REFUTE), wrapVerdict(cs[1], CONFIRM), null, null])
  assert.equal(t.refuteRate, 0.5)
  assert.notEqual(t.refuteRate, Math.round(((cs.length - t.confirmed) / cs.length) * 100) / 100)
})

test('refuteRate is null when nothing was judged (0 would read as "refutes nothing")', () => {
  const cs = [cand(1), cand(2)]
  assert.equal(tallyVerification(cs, [null, null]).refuteRate, null)
})

// ---- where the line goes: fewer than half the candidates judged → INCOMPLETE ----
test('every verifier dying is INCOMPLETE, not a refutation of every candidate', () => {
  const cs = [cand(1), cand(2)]
  const r = unusedCratesResult(cs, [null, null])
  assert.equal(r.verdict, 'INCOMPLETE (not run)')
  assert.equal(r._verification.refuted, 0)
  assert.equal(r._verification.died, 2)
  assert.equal(r.findings.length, 2)
  assert.match(r.findings[0].title, /^unverified: /)
})

test('mostly dead (3 of 4) is INCOMPLETE, not a green Approve', () => {
  const cs = [cand(1), cand(2), cand(3), cand(4)]
  const r = unusedCratesResult(cs, [wrapVerdict(cs[0], REFUTE), null, null, null])
  assert.equal(r.verdict, 'INCOMPLETE (not run)')
  assert.deepEqual({ judged: r._verification.judged, died: r._verification.died, refuted: r._verification.refuted }, { judged: 1, died: 3, refuted: 1 })
  // The three unjudged candidates are named; the refuted one is not smuggled in as unverified.
  assert.equal(r.findings.filter(f => /^unverified: /.test(f.title)).length, 3)
})

test('one flaky verifier out of four still yields a real verdict', () => {
  const cs = [cand(1), cand(2), cand(3), cand(4)]
  const r = unusedCratesResult(cs, [wrapVerdict(cs[0], REFUTE), wrapVerdict(cs[1], REFUTE), wrapVerdict(cs[2], REFUTE), null])
  assert.equal(r.verdict, 'Approve')
  assert.equal(r._verification.died, 1)
  assert.match(r.summary, /1 verifier\(s\) died/)
})

test('exactly half judged is enough (the threshold is inclusive)', () => {
  const cs = [cand(1), cand(2)]
  const r = unusedCratesResult(cs, [wrapVerdict(cs[0], REFUTE), null])
  assert.equal(r.verdict, 'Approve')
  assert.equal(verificationIncomplete(tallyVerification(cs, [wrapVerdict(cs[0], REFUTE), null])), false)
  assert.equal(VERIFY_MIN_JUDGED, 0.5)
})

test('a single dead verifier for a single candidate is INCOMPLETE', () => {
  const cs = [cand(1)]
  assert.equal(unusedCratesResult(cs, [null]).verdict, 'INCOMPLETE (not run)')
})

// ---- the ordinary, fully-alive paths still behave ----
test('all refuted → Approve with no deaths mentioned', () => {
  const cs = [cand(1), cand(2)]
  const r = unusedCratesResult(cs, cs.map(c => wrapVerdict(c, REFUTE)))
  assert.equal(r.verdict, 'Approve')
  assert.equal(r._verification.died, 0)
  assert.equal(r._verification.refuteRate, 1)
  assert.doesNotMatch(r.summary, /died/)
  assert.equal(r.findings[0].title, 'No verified unused crates')
})

test('a confirmation → Warning carrying the verifier evidence', () => {
  const cs = [cand(1), cand(2)]
  const r = unusedCratesResult(cs, [wrapVerdict(cs[0], CONFIRM), wrapVerdict(cs[1], REFUTE)])
  assert.equal(r.verdict, 'Warning')
  assert.equal(r._verification.confirmed, 1)
  assert.equal(r._verification.refuteRate, 0.5)
  assert.equal(r.findings.length, 1)
  assert.equal(r.findings[0].severity, 'Medium')
  assert.match(r.findings[0].detail, /no references anywhere\nRemove: drop the member/)
})

test('a confirmation among mostly-dead verifiers keeps the finding and still says INCOMPLETE', () => {
  const cs = [cand(1), cand(2), cand(3)]
  const r = unusedCratesResult(cs, [wrapVerdict(cs[0], CONFIRM), null, null])
  assert.equal(r.verdict, 'INCOMPLETE (not run)')
  assert.equal(r.findings.filter(f => f.severity === 'Medium').length, 1)
  assert.equal(r.findings.filter(f => /^unverified: /.test(f.title)).length, 2)
  // The summary is the whole point of this arm: a reader who stops at it must still learn that
  // something WAS established. Assert the counts, and assert the absolute word is gone — "most"
  // was false at 9 judged of 20, and an INCOMPLETE that overstates its own hole is the same
  // defect as one that hides it.
  assert.match(r.summary, /1 judged \(1 verified unused, 0 refuted\), 2 verifier\(s\) died/)
  assert.doesNotMatch(r.summary, /\bMost\b/i)
})
