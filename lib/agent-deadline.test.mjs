import { test } from 'node:test'
import assert from 'node:assert/strict'
import { makeDeadlineBudget } from './agent-deadline.mjs'

// A driveable clock, so elapsed time is asserted rather than waited for.
function clock(start = 1000) {
  let t = start
  const now = () => t
  return { now, advance: ms => { t += ms } }
}

test('agent-deadline: the budget is spent by what elapsed, not reset per reader', () => {
  const c = clock()
  const b = makeDeadlineBudget(1000, c.now)
  assert.equal(b.remaining(), 1000)
  c.advance(400)
  assert.equal(b.remaining(), 600)
  c.advance(400)
  // The second reader gets what the first one LEFT — this is the whole change: two attempts against
  // one budget, not two budgets.
  assert.equal(b.remaining(), 200)
  assert.equal(b.exhausted(), false)
})

test('agent-deadline: a fully elapsed budget is exhausted and never negative', () => {
  const c = clock()
  const b = makeDeadlineBudget(1000, c.now)
  c.advance(5000)
  assert.equal(b.remaining(), 0)
  assert.equal(b.exhausted(), true)
})

test('agent-deadline: a backwards clock cannot hand out more than the total', () => {
  const c = clock()
  const b = makeDeadlineBudget(1000, c.now)
  c.advance(-9999)
  assert.equal(b.remaining(), 1000, 'a clock jumping backwards must not inflate the budget')
})

test('agent-deadline: a nonsense total is an empty budget, not an infinite one', () => {
  for (const bad of [0, -1, NaN, undefined, null, 'soon']) {
    const b = makeDeadlineBudget(bad, () => 0)
    assert.equal(b.total(), 0, `total ${String(bad)}`)
    assert.equal(b.exhausted(), true, `exhausted for ${String(bad)}`)
  }
})
