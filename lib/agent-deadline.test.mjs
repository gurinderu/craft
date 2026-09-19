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

test('agent-deadline: a remainder too small to answer in refuses the next attempt', () => {
  const c = clock()
  const b = makeDeadlineBudget(1800000, c.now)
  // The measured slow death: the first attempt comes back empty near the end of the budget, leaving
  // a sliver. Without a floor this reads as "plenty left" and buys a harness slot to time out in.
  c.advance(1799800)
  assert.equal(b.remaining(), 200)
  assert.equal(b.exhausted(), false, 'the bare call still means literally-nothing-left')
  assert.equal(b.exhausted(60000), true, 'against a floor, 200ms is refused')
})

test('agent-deadline: the floor refuses only below itself, never a usable remainder', () => {
  const c = clock()
  const b = makeDeadlineBudget(1800000, c.now)
  c.advance(1700000)
  // 100s left against a 60s floor: a live verifier answers in tens of seconds, so this attempt is
  // worth dispatching and the floor must not eat it.
  assert.equal(b.remaining(), 100000)
  assert.equal(b.exhausted(60000), false)
})

test('agent-deadline: a nonsense floor degrades to the zero test, it does not refuse everything', () => {
  const c = clock()
  const b = makeDeadlineBudget(1000, c.now)
  c.advance(400)
  for (const junk of [undefined, null, NaN, -5, 'x']) {
    assert.equal(b.exhausted(junk), false, `floor ${String(junk)} must not refuse a live budget`)
  }
})

test('agent-deadline: a floor larger than the whole budget would refuse the FIRST attempt', () => {
  // The reason the engine scales its floor instead of passing a flat minute. `deadlineMs=30000` is a
  // documented diagnostic setting; a flat 60s floor is true before anything has run, so every agent
  // in such a run silently loses its re-dispatch and the transcript blames an exhausted budget.
  const c = clock()
  const b = makeDeadlineBudget(30000, c.now)
  assert.equal(b.remaining(), 30000, 'nothing has elapsed yet')
  assert.equal(b.exhausted(60000), true, 'a flat floor refuses a budget that is entirely untouched')
  // Scaled to the budget, the same untouched budget is usable — and still refused once mostly spent.
  const scaled = Math.min(60000, Math.floor(b.total() / 2))
  assert.equal(b.exhausted(scaled), false)
  c.advance(20000)
  assert.equal(b.exhausted(scaled), true, '10s left against a 15s floor is refused')
})
