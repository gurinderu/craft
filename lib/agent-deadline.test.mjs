import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
import { makeDeadlineBudget, DEADLINE_HIT } from './agent-deadline.mjs'

// A driveable scheduler. Nothing here sleeps and nothing reads a clock — which is not merely a
// speed choice: the sandbox this code runs in has NO clock (observed 2026-09-19 by probe: `Date`,
// `performance` and `process` are all unavailable there), so a test that measured elapsed time
// would be testing an environment the engine never sees. Time here is an ordering of fires.
function scheduler() {
  const pending = new Map()
  let next = 1
  const schedule = (fn, delay) => { const id = next++; pending.set(id, { fn, delay }); return id }
  const cancel = id => pending.delete(id)
  // Fire every timer armed for <= `upTo`, soonest first, as a real event loop would.
  const advanceTo = async upTo => {
    for (const [id, t] of [...pending.entries()].sort((a, b) => a[1].delay - b[1].delay)) {
      if (t.delay <= upTo) { pending.delete(id); t.fn() }
    }
    await Promise.resolve()
  }
  return { schedule, cancel, advanceTo, armed: () => pending.size }
}

test('agent-deadline: the budget is armed once and every attempt races the SAME promise', async () => {
  const c = scheduler()
  const b = makeDeadlineBudget(1000, { schedule: c.schedule, cancel: c.cancel })
  assert.equal(b.expired(), false)
  // Two reads, one promise — this identity IS "one budget shared by the attempts". The previous
  // version reconstructed it by subtracting elapsed time, which needs a clock the sandbox refuses.
  assert.equal(b.hit, b.hit)
  await c.advanceTo(1000)
  assert.equal(b.expired(), true)
  assert.equal(await b.hit, DEADLINE_HIT, 'the shared promise resolves to the deadline sentinel')
})

test('agent-deadline: the floor closes before the budget does', async () => {
  const c = scheduler()
  const b = makeDeadlineBudget(1000, { floorMs: 200, schedule: c.schedule, cancel: c.cancel })
  assert.equal(b.belowFloor(), false, 'a fresh budget is worth dispatching into')
  await c.advanceTo(700)
  assert.equal(b.belowFloor(), false, 'still 300 left against a floor of 200')
  await c.advanceTo(800)
  // The measured slow death lands exactly here: the attempt comes back empty near the end, and a
  // re-dispatch would fire the deadline before the agent could answer — a harness slot for nothing.
  assert.equal(b.belowFloor(), true)
  assert.equal(b.expired(), false, 'and the budget itself has NOT fired — these are different events')
})

test('agent-deadline: a floor at or above the whole budget refuses from the start', () => {
  const c = scheduler()
  const b = makeDeadlineBudget(30000, { floorMs: 60000, schedule: c.schedule, cancel: c.cancel })
  // Why the engine scales its floor rather than passing a flat minute: against a budget shorter
  // than the floor a re-dispatch is refused before anything has run, and the whole retry ladder the
  // death breaker is calibrated against disappears silently. `deadlineMs=30000` is a documented
  // diagnostic value, so this is reachable, not hypothetical.
  assert.equal(b.belowFloor(), true)
  assert.equal(b.expired(), false)
})

test('agent-deadline: a firing budget also closes the floor, so one question is enough', async () => {
  const c = scheduler()
  const b = makeDeadlineBudget(1000, { floorMs: 0, schedule: c.schedule, cancel: c.cancel })
  assert.equal(b.belowFloor(), false)
  await c.advanceTo(1000)
  assert.equal(b.belowFloor(), true, 'a caller that asks only belowFloor() is still correct')
})

test('agent-deadline: a nonsense budget is spent from the start and arms nothing', () => {
  const c = scheduler()
  for (const junk of [0, -1, NaN, undefined, null, 'x']) {
    const b = makeDeadlineBudget(junk, { schedule: c.schedule, cancel: c.cancel })
    assert.equal(b.total(), 0, `total for ${String(junk)}`)
    assert.equal(b.expired(), true)
    assert.equal(b.belowFloor(), true)
  }
  assert.equal(c.armed(), 0, 'a zero budget must not arm a timer that never usefully fires')
})

test('agent-deadline: a nonsense floor degrades to no floor rather than refusing everything', () => {
  const c = scheduler()
  for (const junk of [undefined, null, NaN, -5, 'x']) {
    const b = makeDeadlineBudget(1000, { floorMs: junk, schedule: c.schedule, cancel: c.cancel })
    assert.equal(b.belowFloor(), false, `floor ${String(junk)} must not refuse a live budget`)
  }
})

test('agent-deadline: dispose clears the armed timers', async () => {
  const c = scheduler()
  const b = makeDeadlineBudget(1000, { floorMs: 200, schedule: c.schedule, cancel: c.cancel })
  assert.equal(c.armed(), 2, 'the budget and the floor are two timers')
  b.dispose()
  assert.equal(c.armed(), 0)
  // The leak this prevents is invisible: a pending timer holds the run open for the whole deadline
  // after the agent has already answered, and nothing reports it.
  await c.advanceTo(1000)
  assert.equal(b.expired(), false, 'a disposed budget does not fire afterwards')
})

test('agent-deadline: NOTHING IN THE ENGINE reaches for a clock', async () => {
  // THE GUARD THAT WOULD HAVE CAUGHT THE OUTAGE. An earlier version defaulted to `Date.now`, passed
  // every gate — the checkers compile the engine, they do not run it — and died on the first agent
  // dispatch of a real run while 849 tests stayed green. Reading the source is crude, but this is a
  // property of an environment the test process cannot reproduce: node HAS a clock, so no amount of
  // executing this module here can notice that the sandbox does not.
  // WIDER THAN THIS MODULE ON PURPOSE. The outage happened in `workflows/review.js`, and a guard
  // that watches only the module the fix landed in would have let the NEXT `Date.now` through
  // exactly as the last one went: the inlined region is byte-compared, but the other ~4000 lines of
  // the engine — `ragent`, the phases, the report — are where a clock reads just as naturally and
  // nothing would have looked. All four engines run in the same sandbox, so all four are read.
  const { readFile } = await import('node:fs/promises')
  const FORBIDDEN = ['Date.now', 'new Date(', 'performance.now', 'process.hrtime', 'process.uptime']
  const targets = [
    new URL('./agent-deadline.mjs', import.meta.url),
    new URL('../workflows/review.js', import.meta.url),
    new URL('../workflows/adversarial-review.js', import.meta.url),
    new URL('../workflows/rust-audit.js', import.meta.url),
    new URL('../workflows/triage-findings.js', import.meta.url),
  ]
  let checked = 0
  for (const url of targets) {
    const src = await readFile(url, 'utf8')
    checked++
    const code = src.split('\n').filter(l => !l.trim().startsWith('//')).join('\n')
    for (const forbidden of FORBIDDEN) {
      assert.ok(!code.includes(forbidden), `${forbidden} in ${url.pathname.split('/').pop()} — unavailable in the workflow sandbox`)
    }
  }
  // A guard that reads no file is a guard that passes for the wrong reason.
  assert.equal(checked, targets.length)
})

test('agent-deadline: the deadline sentinel does not drift between the module and the engine', () => {
  // `DEADLINE_HIT` is declared OUTSIDE the craft-inline fence in both copies while the fenced
  // function compares against it, so the byte-comparison gate is blind to it — the same blind spot
  // `shq` has, and `shq` at least has a tripwire. Identity comparison is the contract: a falsy or
  // re-shaped sentinel would be indistinguishable from an agent that answered with nothing, and
  // those two outcomes must never merge.
  const shape = 'const DEADLINE_HIT = { craftDeadline: true }'
  const fs = require('node:fs')
  for (const f of ['lib/agent-deadline.mjs', 'workflows/review.js']) {
    const src = fs.readFileSync(new URL(`../${f}`, import.meta.url), 'utf8')
    assert.ok(src.includes(shape) || src.includes(`export ${shape}`), `${f} must declare the sentinel in the shared shape`)
  }
})
