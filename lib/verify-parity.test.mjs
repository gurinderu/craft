// The verification rules the Rust CLI copies (cli/crates/craft-review/src/settle.rs, harm.rs, verify.rs) held to the
// engines' own by one shared file, content/parity/verify-cases.json, which cli/crates/craft-review/src/parity.rs reads too:
// the constants, and for one finding and one verdict the tier, the final severity and the route.
import { test } from 'vitest'
import assert from 'node:assert/strict'
import cases from '../content/parity/verify-cases.json' with { type: 'json' }
import { BATCH_SIZE, CRITICAL_TIER_RULES, DEMOTE, decideTier, isVerdictShaped, verifyTier } from './review-verify.mjs'
import { harmRaise } from './harm-verify.mjs'
import { capByHarm } from './harm-cap.mjs'
import { HARM_CEILING, HARM_LEVELS } from './harm-levels.mjs'

test('the constants the CLI copies are the engines\' own', () => {
  assert.equal(cases.batchSize, BATCH_SIZE)
  assert.deepEqual(cases.criticalTierRules, [...CRITICAL_TIER_RULES])
  assert.deepEqual(cases.demote, DEMOTE)
  assert.deepEqual(cases.harmCeiling, HARM_LEVELS.map(l => [l, HARM_CEILING[l]]))
})

for (const c of cases.cases) {
  test(`parity: ${c.name}`, () => {
    /** @type {import('./review-schemas.mjs').Finding} */
    const finding = structuredClone(c.finding)
    const live = c.vote ? [c.vote] : []
    // The pool's order for a panel of one: the tier and its demotions, the verified-harm raise, then the cap.
    const settled = capByHarm(harmRaise(decideTier(finding, live, live.filter(isVerdictShaped))))
    assert.deepEqual({ tier: settled.tier, severity: settled.severity }, { tier: c.expected.tier, severity: c.expected.severity })
    assert.equal(verifyTier(finding), c.expected.route)
  })
}
