// Direct tests of lib/agent-deadline.mjs at the edges agent-deadline.test.mjs leaves open: which
// timers are armed for a floor at either end of the budget, whether the shared promise is pending
// until the budget fires, and the host-timer fallback when no scheduler pair is injected.
import { test, vi } from 'vitest'
import assert from 'node:assert/strict'
import { makeDeadlineBudget, DEADLINE_HIT } from './agent-deadline.mjs'

function counting() {
  /** @type {number[]} */
  const delays = []
  return {
    delays,
    /** @param {() => void} _fn @param {number} ms */
    schedule: (_fn, ms) => { delays.push(ms); return delays.length },
    cancel: () => {},
  }
}

test('a floor timer is armed only for a floor strictly inside the budget', () => {
  for (const [floorMs, expected] of /** @type {[number, number[]][]} */ ([[0, [1000]], [200, [1000, 800]], [1000, [1000]]])) {
    const c = counting()
    makeDeadlineBudget(1000, { floorMs, schedule: c.schedule, cancel: c.cancel })
    assert.deepEqual(c.delays, expected, `floor ${floorMs}`)
  }
})

test('the shared promise is pending until the budget fires, and already settled for a spent budget', async () => {
  const c = counting()
  const b = makeDeadlineBudget(1000, { schedule: c.schedule, cancel: c.cancel })
  let settled = false
  void b.hit.then(() => { settled = true })
  await Promise.resolve()
  await Promise.resolve()
  assert.equal(settled, false)
  assert.equal(await makeDeadlineBudget(0).hit, DEADLINE_HIT)
})

test('with no scheduler pair the host timers are used, and dispose clears them', () => {
  vi.useFakeTimers()
  try {
    const fired = makeDeadlineBudget(100)
    vi.advanceTimersByTime(100)
    assert.equal(fired.expired(), true)
    const disposed = makeDeadlineBudget(100)
    disposed.dispose()
    vi.advanceTimersByTime(200)
    assert.equal(disposed.expired(), false, 'a disposed budget never fires')
  } finally {
    vi.useRealTimers()
  }
})

test('a schedule without its cancel is not a pair: the host timers are used', () => {
  vi.useFakeTimers()
  try {
    let called = 0
    const half = /** @type {{ schedule: () => number, cancel: () => void }} */ (/** @type {unknown} */ ({ schedule: () => ++called }))
    const b = makeDeadlineBudget(100, half)
    assert.equal(called, 0, 'the half-pair is never called')
    assert.equal(vi.getTimerCount(), 1, 'a host timer is armed in its place')
    b.dispose()
    assert.equal(vi.getTimerCount(), 0, 'and the host timer is what dispose clears')
  } finally {
    vi.useRealTimers()
  }
})
