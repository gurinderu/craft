// A verdict line now carries the consumer's CI check names, so a verdict is read from the token that
// opens the line, never from a word further on: a check named "Block size" or "Blockers" must not
// turn a Warning into a Block.
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { reviewResult } from './rust-audit-verdict.mjs'
import { gateResult } from './rust-audit-nested.mjs'

const report = (/** @type {string} */ verdict) => `## Verdict\n\n${verdict}\n`
const ci = 'CI for abc1234: Block size green, Blockers green (checks Block size, Blockers) — informs only, not a pass'

test('a check named Block on a Warning line leaves the nested review a Warning', () => {
  const line = `⚠️ Warning — the gate was not established locally (rust: unknown); ${ci}`
  assert.equal(reviewResult('review:x', report(line)).verdict, 'Warning')
  assert.equal(reviewResult('review:x', report(`Warning — the gate was not established locally (rust: unknown); ${ci}`)).verdict, 'Warning')
})

test('a check named Block on an Approve line does not block', () => {
  assert.equal(reviewResult('review:x', report('✅ Approve — CI saw Block size green')).verdict, 'Approve')
})

test('the token at the start still decides: a Block, bare or marked, is a Block', () => {
  for (const line of ['⛔ Block — 2 High', 'Block (INCOMPLETE)', '**⛔ Block** — 1 High', '⛔ — mechanical gate is red (rust)']) {
    assert.equal(reviewResult('review:x', report(line)).verdict, 'Block', line)
  }
})

test('the gate alone reads its verdict token, not a check name on its line', () => {
  assert.equal(gateResult(report(`⚠️ Warning — the gate was not established locally (rust: unknown); ${ci}: its signal is unknown`)).verdict, 'Warning')
  assert.equal(gateResult(report('⛔ Block — mechanical gate is red (rust).')).verdict, 'Block')
  assert.equal(gateResult(report('⚠️ INCOMPLETE — review\'s gate did not run: Block size timed out')).verdict, 'INCOMPLETE (gate not established)')
})
