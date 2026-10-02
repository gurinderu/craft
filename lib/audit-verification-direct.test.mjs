// Direct tests of lib/audit-verification.mjs at the edges audit-verification.test.mjs leaves open:
// untrusted list shapes, a verdict with no body, more verdicts than candidates, and the exact
// findings and summaries of the unused-crates dimension on each of its paths.
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { tallyVerification, unusedCratesResult } from './audit-verification.mjs'

/** @typedef {import('./audit-verification.mjs').Candidate} Candidate */
/** @typedef {import('./audit-verification.mjs').UnusedVerdictShape} V */
const UNVERIFIED = 'Verification did not run for this candidate — it is neither confirmed unused nor cleared.'

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
  assert.equal(r.summary, '1 candidate(s) flagged; 0 verified unused after trying to refute each; 1 refuted (kept).')
  assert.deepEqual(r.findings, [{ severity: 'Info', title: 'No verified unused crates', location: '', detail: '1 candidate(s) flagged, 1 refuted by verification.' }])
})

test('an under-judged run lists every unjudged candidate as unverified and counts what is missing', () => {
  const [a, b, c] = [{ title: 'a', location: 'a/Cargo.toml', detail: 'da' }, { title: 'b' }, { title: 'c' }]
  const r = unusedCratesResult([a, b, c], [{ c, v: { confirmedUnused: false } }, null, null])
  assert.equal(r.dimension, 'unused-crates')
  assert.equal(r.summary, '3 candidate(s) flagged; 1 judged (0 verified unused, 1 refuted), 2 verifier(s) died. 2 candidate(s) are UNVERIFIED — neither confirmed nor cleared.')
  assert.deepEqual(r.findings, [
    { severity: 'Info', title: 'unverified: a', location: 'a/Cargo.toml', detail: `da\n${UNVERIFIED}` },
    { severity: 'Info', title: 'unverified: b', location: '', detail: UNVERIFIED },
  ])
})

test('a run whose every verifier died says the surface is unverified', () => {
  const r = unusedCratesResult([{ title: 'a' }], [null])
  assert.equal(r.summary, '1 candidate(s) flagged, but every verifier failed to return — none was confirmed OR refuted. The unused-crate surface is UNVERIFIED, not clean.')
})
