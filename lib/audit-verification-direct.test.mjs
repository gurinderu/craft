// Direct tests of lib/audit-verification.mjs at the edges audit-verification.test.mjs leaves open:
// untrusted list shapes, a verdict with no body, more verdicts than candidates, and the exact
// findings and summaries of the unused-crates dimension on each of its paths.
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { tallyVerification, unusedCratesResult } from './audit-verification.mjs'

/** @typedef {import('./audit-verification.mjs').Candidate} Candidate */
/** @typedef {import('./audit-verification.mjs').UnusedVerdictShape} V */

test('tallyVerification reads non-array inputs as empty, a bodiless verdict as not confirmed, and never a negative death count', () => {
  const none = /** @type {Candidate[]} */ (/** @type {unknown} */ (null))
  const noVerdicts = /** @type {{ c: Candidate, v: V }[]} */ (/** @type {unknown} */ (null))
  assert.equal(tallyVerification(none, []).candidates, 0)
  assert.equal(tallyVerification([], noVerdicts).judged, 0)
  const c = { title: 'x' }
  const bodiless = /** @type {{ c: Candidate, v: V }[]} */ (/** @type {unknown} */ ([{ c, v: null }]))
  assert.equal(tallyVerification([c], bodiless).confirmed, 0)
  assert.equal(tallyVerification([c], [{ c, v: {} }, { c, v: {} }]).died, 0)
})

test('a confirmed crate carries the verifier\'s evidence and removal, else the detector\'s detail, else nothing', () => {
  const a = { title: 'a', location: 'a/Cargo.toml', detail: 'da' }
  const b = { title: 'b', detail: 'db' }
  const c = { title: 'c' }
  const r = unusedCratesResult([a, b, c], [
    { c: a, v: { confirmedUnused: true, evidence: '  no refs ', removal: 'drop a' } },
    { c: b, v: { confirmedUnused: true } },
    { c, v: { confirmedUnused: true } },
  ])
  assert.equal(r.dimension, 'unused-crates')
  assert.deepEqual(r.findings, [
    { severity: 'Medium', title: 'a', location: 'a/Cargo.toml', detail: 'no refs \nRemove: drop a' },
    { severity: 'Medium', title: 'b', location: '', detail: 'db' },
    { severity: 'Medium', title: 'c', location: '', detail: '' },
  ])
})

test('an all-refuted run says so without a death note, in one Info finding', () => {
  const a = { title: 'a' }
  const r = unusedCratesResult([a], [{ c: a, v: { confirmedUnused: false } }])
  assert.equal(r.verdict, 'Approve')
  assert.doesNotMatch(r.summary, /died/)
  assert.equal(r.findings.length, 1)
  assert.deepEqual([r.findings[0]?.severity, r.findings[0]?.location], ['Info', ''])
  assert.doesNotMatch(r.findings[0]?.detail ?? '', /died/)
})

test('an under-judged run lists every unjudged candidate as unverified and counts what is missing', () => {
  const [a, b, c] = [{ title: 'a', location: 'a/Cargo.toml', detail: 'da' }, { title: 'b' }, { title: 'c' }]
  const r = unusedCratesResult([a, b, c], [{ c, v: { confirmedUnused: false } }, null, null])
  assert.equal(r.dimension, 'unused-crates')
  assert.match(r.summary, /\b2 candidate\(s\) are UNVERIFIED/, 'three flagged less one judged')
  assert.deepEqual(r.findings.map(f => [f.severity, f.location]), [['Info', 'a/Cargo.toml'], ['Info', '']])
  assert.ok(r.findings[0]?.title.endsWith(' a') && r.findings[1]?.title.endsWith(' b'))
  assert.ok(r.findings[0]?.detail.startsWith('da\n'), 'the detector\'s detail leads')
  assert.ok(r.findings[1]?.detail.length && !r.findings[1].detail.startsWith('\n'), 'and nothing dangles where there was none')
})

test('a run whose every verifier died says the surface is unverified, without claiming a judgement', () => {
  const r = unusedCratesResult([{ title: 'a' }], [null])
  assert.match(r.summary, /UNVERIFIED/)
  assert.doesNotMatch(r.summary, /judged/)
})
