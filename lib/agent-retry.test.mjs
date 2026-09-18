// The re-dispatch breaker as a unit: what it counts, what it refuses to count, and what closes it.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { makeDeathBreaker, DEATH_STREAK_TO_OPEN } from './agent-retry.mjs'

test('agent-retry: the first two deaths still buy their re-dispatch, the third does not', () => {
  const b = makeDeathBreaker()
  assert.equal(DEATH_STREAK_TO_OPEN, 3, 'the threshold is the documented one')
  assert.equal(b.deathAllowsRedispatch(), true, 'a single stray death is a one-off — the retry exists for exactly this')
  assert.equal(b.deathAllowsRedispatch(), true, 'two in a row are still plausible on a healthy day')
  assert.equal(b.deathAllowsRedispatch(), false, 'the third consecutive death is not a one-off, so the second ladder is not bought')
  assert.equal(b.deathAllowsRedispatch(), false, 'and it stays open for the rest of the outage')
  assert.equal(b.streak(), 4, 'the streak keeps counting so the log can say which death this is')
})

test('agent-retry: one live answer closes the breaker', () => {
  const b = makeDeathBreaker()
  b.deathAllowsRedispatch()
  b.deathAllowsRedispatch()
  b.deathAllowsRedispatch()
  assert.equal(b.deathAllowsRedispatch(), false, 'open, as above')
  b.recordLive()
  assert.equal(b.streak(), 0, 'a live answer means the API is reachable again')
  assert.equal(b.deathAllowsRedispatch(), true, 'so the next isolated failure gets its re-dispatch back')
})

test('agent-retry: no number of live answers can open it — it reads deaths, never durations', () => {
  const b = makeDeathBreaker()
  for (let i = 0; i < 100; i++) b.recordLive()
  assert.equal(b.deathAllowsRedispatch(), true, 'a busy, slow, entirely healthy phase must never suppress a retry')
})

test('agent-retry: deaths separated by a live answer never accumulate', () => {
  const b = makeDeathBreaker()
  for (let i = 0; i < 20; i++) {
    assert.equal(b.deathAllowsRedispatch(), true, `isolated death #${i + 1} must still be retried`)
    b.recordLive()
  }
})

test('agent-retry: the threshold is injectable and never degenerates below one', () => {
  assert.equal(makeDeathBreaker(1).deathAllowsRedispatch(), false, 'k=1 suppresses from the first death')
  assert.equal(makeDeathBreaker(0).streakToOpen, DEATH_STREAK_TO_OPEN, 'a nonsense threshold falls back to the default rather than to zero')
  assert.equal(makeDeathBreaker('x').streakToOpen, DEATH_STREAK_TO_OPEN)
  assert.equal(makeDeathBreaker(-5).streakToOpen, 1, 'a negative one clamps to the smallest meaningful threshold')
})
