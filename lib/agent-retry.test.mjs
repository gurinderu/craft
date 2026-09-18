// The re-dispatch breaker as a unit: what it counts, what it refuses to count, and what reopens it.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { makeDeathBreaker, DEATH_WINDOW_DISPATCHES, DEATHS_IN_WINDOW_TO_OPEN } from './agent-retry.mjs'

test('agent-retry: the first two deaths still buy their re-dispatch, the third does not', () => {
  const b = makeDeathBreaker()
  assert.equal(DEATHS_IN_WINDOW_TO_OPEN, 3, 'the threshold is the documented one')
  assert.equal(DEATH_WINDOW_DISPATCHES, 6, 'and so is the window it is counted over')
  assert.equal(b.deathAllowsRedispatch(), true, 'a single stray death is a one-off — the retry exists for exactly this')
  assert.equal(b.deathAllowsRedispatch(), true, 'two are still plausible on a healthy day')
  assert.equal(b.deathAllowsRedispatch(), false, 'three out of the last three is not a day on which a second ladder pays')
  assert.equal(b.deathAllowsRedispatch(), false, 'and it stays open while the deaths keep coming')
  assert.equal(b.deaths(), 4, 'the count is what the log reports')
  assert.equal(b.observed(), 4, 'out of the outcomes actually observed — never a claim about harness dispatches')
})

test('agent-retry: interleaved deaths are seen — this is the signal a consecutive streak could not carry', () => {
  // The measured outage was PARTIAL (46 deaths among 179 agents) and a dead dispatch takes 500-660s
  // against a live verifier's tens of seconds, so live answers land between the deaths by
  // construction. A streak reset by that interleaving saves nothing in the very run it was built for.
  const b = makeDeathBreaker()
  assert.equal(b.deathAllowsRedispatch(), true, 'death 1 of the alternation is still a one-off')
  b.recordLive()
  assert.equal(b.deathAllowsRedispatch(), true, 'death 2, still within the allowance')
  b.recordLive()
  assert.equal(b.deathAllowsRedispatch(), false, 'three of the last five returned nothing — the second ladder is not bought')
  assert.equal(b.deaths(), 3)
  assert.equal(b.observed(), 5)
})

test('agent-retry: one live answer does not erase the outage behind it, and four slide it out', () => {
  const b = makeDeathBreaker()
  b.deathAllowsRedispatch()
  b.deathAllowsRedispatch()
  assert.equal(b.deathAllowsRedispatch(), false, 'open, as above')
  b.recordLive()
  assert.equal(b.deathAllowsRedispatch(), false, 'a single live answer is one observation, not proof the outage ended')
  // Recovery is the window sliding, which is also the only decay this counter has: a breaker with no
  // decay at all stays open until someone answers, and stayed open across a whole phase boundary.
  for (let i = 0; i < DEATH_WINDOW_DISPATCHES; i++) b.recordLive()
  assert.equal(b.deaths(), 0, 'a recovered phase has no deaths left in its window')
  assert.equal(b.deathAllowsRedispatch(), true, 'so the next isolated failure gets its re-dispatch back')
})

test('agent-retry: no number of live answers can open it — it reads deaths, never durations', () => {
  const b = makeDeathBreaker()
  for (let i = 0; i < 100; i++) b.recordLive()
  assert.equal(b.deathAllowsRedispatch(), true, 'a busy, slow, entirely healthy phase must never suppress a retry')
})

test('agent-retry: deaths spread thin across the window never accumulate', () => {
  const b = makeDeathBreaker()
  for (let i = 0; i < 20; i++) {
    assert.equal(b.deathAllowsRedispatch(), true, `isolated death #${i + 1} must still be retried`)
    for (let j = 0; j < DEATH_WINDOW_DISPATCHES; j++) b.recordLive()
  }
})

test('agent-retry: a fresh breaker starts closed — a pass never inherits another pass\'s window', () => {
  const spent = makeDeathBreaker()
  spent.deathAllowsRedispatch()
  spent.deathAllowsRedispatch()
  spent.deathAllowsRedispatch()
  assert.equal(spent.deaths(), 3, 'this one is open')
  const fresh = makeDeathBreaker()
  assert.equal(fresh.observed(), 0, 'and it shares nothing with the next instance')
  assert.equal(fresh.deathAllowsRedispatch(), true)
})

test('agent-retry: the window and the threshold are injectable and never degenerate', () => {
  assert.equal(makeDeathBreaker({ toOpen: 1 }).deathAllowsRedispatch(), false, 'toOpen=1 suppresses from the first death')
  assert.equal(makeDeathBreaker({ toOpen: 0 }).toOpen, DEATHS_IN_WINDOW_TO_OPEN, 'a nonsense threshold falls back to the default rather than to zero')
  assert.equal(makeDeathBreaker({ toOpen: 'x' }).toOpen, DEATHS_IN_WINDOW_TO_OPEN)
  assert.equal(makeDeathBreaker({ toOpen: -5 }).toOpen, DEATHS_IN_WINDOW_TO_OPEN, 'and so does a negative one')
  assert.equal(makeDeathBreaker({ window: 0 }).windowLen, DEATH_WINDOW_DISPATCHES, 'so does a nonsense window')
  // A threshold larger than the window would be unreachable — the breaker could never open at all.
  const narrow = makeDeathBreaker({ window: 2, toOpen: 9 })
  assert.equal(narrow.toOpen, 2, 'a threshold above the window clamps to the window')
  narrow.deathAllowsRedispatch()
  assert.equal(narrow.deathAllowsRedispatch(), false, 'so it remains reachable')
  const short = makeDeathBreaker({ window: 2 })
  assert.equal(short.toOpen, 2, 'and the default threshold clamps the same way')
})
