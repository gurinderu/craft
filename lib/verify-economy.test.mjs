import { test } from 'node:test'
import assert from 'node:assert/strict'
import { BLOCKING_SEVERITIES, securesBlock, makeVerdictFloor, verdictNeutralNow, floorSkipReason } from './verify-economy.mjs'
import { reviewVerdict } from './run-record.mjs'

const f = (severity, tier) => ({ severity, tier, title: 't', file: 'src/lib.rs', line: 7 })

test('verify-economy: the blocking severities are exactly the ones reviewVerdict blocks on', () => {
  // The premise of the whole skip, checked against the rule itself rather than against a memory of
  // it: if reviewVerdict ever stopped blocking on one of these, the skip would be unjustified.
  for (const s of BLOCKING_SEVERITIES) {
    assert.equal(reviewVerdict([{ severity: s }]), 'Block', s)
  }
  assert.equal(reviewVerdict([{ severity: 'Medium' }]), 'Warning')
  // And the other direction: once Block is on the table, no number of Mediums changes it.
  assert.equal(
    reviewVerdict([{ severity: 'Critical' }, ...Array.from({ length: 50 }, () => ({ severity: 'Medium' }))]),
    'Block',
    'this equality IS the licence to skip Medium verification',
  )
})

test('verify-economy: only a CONFIRMED blocking finding secures Block', () => {
  assert.equal(securesBlock(f('Critical', 'confirmed')), true)
  assert.equal(securesBlock(f('High', 'confirmed')), true)
  assert.equal(securesBlock(f('Medium', 'confirmed')), false)
  for (const tier of ['suspected', 'refuted', 'unverified']) {
    assert.equal(securesBlock(f('Critical', tier)), false, `a ${tier} Critical is not evidence of Block`)
  }
  assert.equal(securesBlock(null), false)
})

test('verify-economy: a severity DEMOTED by verification does not raise the floor', () => {
  // tierFromVotes demotes a confirmed-but-unreachable High to Medium, and reviewVerdict counts the
  // demoted severity. Reading the judged finding is what makes that automatic.
  assert.equal(securesBlock({ severity: 'Medium', tier: 'confirmed' }), false)
})

test('verify-economy: the floor answers about the past, never about the future', () => {
  const floor = makeVerdictFloor()
  assert.equal(floor.secured(), false)
  assert.equal(verdictNeutralNow(f('Medium', undefined), floor), false, 'before any confirmation a Medium still decides Warning vs Approve')
  assert.equal(floor.record(f('Critical', 'suspected')), false)
  assert.equal(floor.secured(), false, 'a suspected Critical is not a fixed verdict')
  assert.equal(floor.record(f('Critical', 'confirmed')), true)
  assert.equal(floor.secured(), true)
  assert.equal(verdictNeutralNow(f('Medium', undefined), floor), true)
})

test('verify-economy: the floor is monotonic and reports only the first riser', () => {
  const floor = makeVerdictFloor()
  const first = { ...f('Critical', 'confirmed'), title: 'first' }
  assert.equal(floor.record(first), true)
  assert.equal(floor.record({ ...f('High', 'confirmed'), title: 'second' }), false, 'only the riser reports, so the log is not repeated per verdict')
  assert.equal(floor.securedBy().title, 'first')
  assert.equal(floor.secured(), true)
})

test('verify-economy: Critical/High are never skipped, whatever the floor says', () => {
  const floor = makeVerdictFloor()
  floor.record(f('Critical', 'confirmed'))
  for (const s of ['Critical', 'High', 'Low', 'Info']) {
    assert.equal(verdictNeutralNow(f(s, undefined), floor), false, s)
  }
})

test('verify-economy: the skip names the evidence that made the check pointless', () => {
  const floor = makeVerdictFloor()
  floor.record({ severity: 'Critical', tier: 'confirmed', title: 'unchecked unwrap', file: 'src/a.rs', line: 42 })
  const why = floorSkipReason(floor)
  assert.match(why, /Critical/)
  assert.match(why, /unchecked unwrap/)
  assert.match(why, /src\/a\.rs:42/)
  assert.match(why, /nothing here has been checked against the code/, 'the honesty half: a skip must say nothing was checked')
})
