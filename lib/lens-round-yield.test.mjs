// The round a finding was first found in, carried through merges and counted per round (realm @nick/craft, node #248).
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { earliestRound, withEarliestRound, roundYield, lensRoundYield } from './lens-round-yield.mjs'

const NONE = { Critical: 0, High: 0, Medium: 0, Low: 0, Info: 0 }

test('earliestRound is the smallest numeric round among the members, 0 included; none without one', () => {
  assert.equal(earliestRound([{ foundInRound: 2 }, { foundInRound: 0 }, {}]), 0)
  assert.equal(earliestRound([{ foundInRound: 3 }, { foundInRound: '1' }]), 3, 'a non-number is no round')
  assert.equal(earliestRound([{}, {}]), undefined)
  assert.equal(earliestRound([]), undefined)
})

test('withEarliestRound overrides the base round with the earliest member round, and leaves an untagged merge untouched', () => {
  const base = { title: 't', foundInRound: 2 }
  assert.deepEqual(withEarliestRound(base, [base, { foundInRound: 1 }]), { title: 't', foundInRound: 1 })
  const bare = { title: 'u' }
  assert.equal(withEarliestRound(bare, [bare, {}]), bare)
  assert.equal(Object.hasOwn(withEarliestRound(bare, [{}]), 'foundInRound'), false)
})

test('roundYield counts only the findings first found in that round, by severity, and tolerates missing tiers', () => {
  const confirmed = [{ severity: 'High', foundInRound: 1 }, { severity: 'Medium', foundInRound: 1 }, { severity: 'High', foundInRound: 2 }, { severity: 'Low' }, null]
  const suspected = [{ severity: 'Medium', foundInRound: 1 }, { severity: 'Low', foundInRound: 0 }]
  assert.deepEqual(roundYield(1, confirmed, suspected), { confirmedCount: 2, confirmedBySeverity: { ...NONE, High: 1, Medium: 1 }, suspectedCount: 1 })
  assert.deepEqual(roundYield(0, confirmed, suspected), { confirmedCount: 0, confirmedBySeverity: NONE, suspectedCount: 1 })
  assert.deepEqual(roundYield(3, /** @type {any} */ (undefined), /** @type {any} */ (undefined)), { confirmedCount: 0, confirmedBySeverity: NONE, suspectedCount: 0 })
})

test('lensRoundYield keeps every existing field of a round entry and adds its yield', () => {
  const rounds = [{ round: 1, agents: 4, returned: 4, newFindings: 2 }, { round: 2, agents: 4, returned: 3, newFindings: 0 }]
  const out = lensRoundYield(rounds, [{ severity: 'Critical', foundInRound: 2 }], [])
  assert.deepEqual(out, [
    { round: 1, agents: 4, returned: 4, newFindings: 2, confirmedCount: 0, confirmedBySeverity: NONE, suspectedCount: 0 },
    { round: 2, agents: 4, returned: 3, newFindings: 0, confirmedCount: 1, confirmedBySeverity: { ...NONE, Critical: 1 }, suspectedCount: 0 },
  ])
  assert.deepEqual(lensRoundYield(/** @type {any} */ (undefined), [], []), [])
})
