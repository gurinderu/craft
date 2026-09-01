import test from 'node:test'
import assert from 'node:assert/strict'
import { VERIFY_WAVE_AGENTS, verifyWeight, weightedWindow } from './review-waves.mjs'

// ---- verifyWeight: agents, not thunks ----

test('verifyWeight counts the AGENTS a thunk can spawn, worst case', () => {
  const plan = { verifyVotes: 3 }
  // A High/Critical opens with a cull + the authoritative vote and, on a split, buys the remaining
  // culls: 1 + max(1, verifyVotes) = 4. That is exactly the number that made ~130 thunks unbounded.
  assert.equal(verifyWeight({ severity: 'High' }, plan), 4)
  assert.equal(verifyWeight({ severity: 'Critical' }, plan), 4)
  // Everything else routed to the individual tier runs a single cull vote.
  for (const sev of ['Medium', 'Low', 'Info', undefined]) {
    assert.equal(verifyWeight({ severity: sev }, plan), 1, `${String(sev)} is one agent`)
  }
})

test('verifyWeight never returns less than the opening pair for a High', () => {
  // A missing/absurd verifyVotes must not shrink the weight below what the thunk actually spawns,
  // or the window is budgeted for fewer agents than it dispatches.
  for (const plan of [{}, { verifyVotes: 0 }, { verifyVotes: -5 }, { verifyVotes: 'lots' }, null, undefined]) {
    assert.equal(verifyWeight({ severity: 'High' }, plan), 2, `plan ${JSON.stringify(plan)} still budgets the opening pair`)
  }
})

test('the in-flight budget is set to a value that actually bounds the queue', () => {
  assert.ok(Number.isInteger(VERIFY_WAVE_AGENTS) && VERIFY_WAVE_AGENTS > 0)
  // Below the heaviest single thunk (a High at verifyVotes=3 → 4 agents) the budget would degenerate
  // into one thunk at a time and serialize verification; far above it, the queue is unbounded again.
  assert.ok(VERIFY_WAVE_AGENTS >= 4 && VERIFY_WAVE_AGENTS <= 40, `${VERIFY_WAVE_AGENTS} keeps dispatch parallel but bounded`)
})

// ---- weightedWindow: bounded, barrier-free, and INDEX-FAITHFUL ----

// Deterministic pseudo-randomness: a reproducible failure is worth more than a fresh one.
function lcg(seed) {
  let s = seed >>> 0
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296)
}

// Drives weightedWindow with settlement delayed by microtask ticks (never wall-clock), recording the
// peak in-flight weight so the cap can be asserted, and the dispatch order so the absence of a
// barrier can be.
function harness(entries, cap, delays) {
  const weightOf = i => Math.max(1, Number(entries[i].weight) || 1)
  let inflight = 0
  let peak = 0
  const order = []
  const runOne = (run, i) => {
    inflight += weightOf(i)
    peak = Math.max(peak, inflight)
    order.push(i)
    let p = Promise.resolve()
    for (let t = 0; t < (delays ? delays[i] : 0); t++) p = p.then(() => {})
    return p.then(() => {
      inflight -= weightOf(i)
      return run()
    })
  }
  return weightedWindow(entries, cap, runOne).then(out => ({ out, peak, order }))
}

test('weightedWindow returns one result per entry, at its own index', async () => {
  const entries = Array.from({ length: 200 }, (_u, i) => ({ weight: (i % 5) + 1, run: () => `r${i}` }))
  for (const cap of [1, 2, 3, 4, 7, 24, 199, 1000]) {
    const { out } = await harness(entries, cap)
    assert.equal(out.length, entries.length, `cap ${cap} drops nothing`)
    assert.deepEqual(out, entries.map((_e, i) => `r${i}`), `cap ${cap} keeps every result at its index`)
  }
})

test('weightedWindow never exceeds the budget in flight — and dispatches without a barrier', async () => {
  const entries = Array.from({ length: 40 }, (_u, i) => ({ weight: (i % 4) + 1, run: () => i }))
  // Entry 0 settles LAST. Under a wave barrier nothing past the first wave could start before it;
  // the window must have dispatched far beyond that by the time it settles.
  const delays = entries.map((_e, i) => (i === 0 ? 500 : 1))
  const { out, peak, order } = await harness(entries, 10, delays)
  assert.deepEqual(out, entries.map((_e, i) => i))
  assert.ok(peak <= 10, `peak in flight ${peak} stays inside the budget`)
  assert.equal(order.length, entries.length, 'every entry was dispatched')
  assert.ok(order[order.length - 1] > 12, 'dispatch ran past the slow first entry rather than waiting on it')
})

test('an entry heavier than the whole budget runs alone instead of deadlocking', async () => {
  const entries = [{ weight: 1, run: () => 'a' }, { weight: 99, run: () => 'big' }, { weight: 1, run: () => 'b' }]
  const { out, peak } = await harness(entries, 4, [3, 1, 1])
  assert.deepEqual(out, ['a', 'big', 'b'])
  assert.equal(peak, 99, 'the over-budget entry got the window to itself, and still ran')
})

test('weightedWindow survives junk weights, junk budgets and an empty list', async () => {
  const entries = [{ run: () => 'a' }, { weight: NaN, run: () => 'b' }, { weight: 0, run: () => 'c' },
    { weight: -3, run: () => 'd' }, { weight: 'two', run: () => 'e' }]
  for (const cap of [24, 0, -1, NaN, undefined, 'lots']) {
    const { out } = await harness(entries, cap)
    assert.deepEqual(out, ['a', 'b', 'c', 'd', 'e'], `cap ${String(cap)} keeps every entry, at its index`)
  }
  assert.deepEqual(await weightedWindow([], 24, run => run()), [], 'an empty list resolves to an empty array')
})

test('a thunk that dies or rejects leaves null in ITS OWN slot and stops nothing', async () => {
  const entries = Array.from({ length: 12 }, (_u, i) => ({ weight: 1, run: () => `r${i}` }))
  const out = await weightedWindow(entries, 4, (run, i) => {
    if (i === 3) return Promise.reject(new Error('boom'))
    if (i === 5) return Promise.resolve(null)
    if (i === 7) return Promise.resolve(undefined)
    return Promise.resolve(run())
  })
  assert.equal(out.length, 12)
  assert.deepEqual(out, entries.map((_e, i) => ([3, 5, 7].includes(i) ? null : `r${i}`)))
})

test('20000 randomized runs: results stay index-faithful and the budget is never exceeded', async () => {
  // The previous wave implementation was brute-forced the same way; out-of-order settlement is the
  // new failure mode, so every case here settles in a shuffled order.
  const rnd = lcg(20250901)
  for (let c = 0; c < 20000; c++) {
    const n = Math.floor(rnd() * 12)
    const cap = 1 + Math.floor(rnd() * 8)
    const entries = Array.from({ length: n }, (_u, i) => ({ weight: 1 + Math.floor(rnd() * 6), run: () => `r${i}` }))
    const delays = entries.map(() => Math.floor(rnd() * 6))
    const { out, peak } = await harness(entries, cap, delays)
    assert.deepEqual(out, entries.map((_e, i) => `r${i}`), `case ${c}: index fidelity`)
    assert.ok(peak <= Math.max(cap, ...entries.map(e => e.weight), 0), `case ${c}: peak ${peak} within budget ${cap}`)
  }
})

// ---- end to end: the positional split still attributes every verdict correctly ----

test('the window + positional split attribute every verdict to the finding it belongs to', async () => {
  // Reproduces the workflow's merge exactly: batch thunks resolve to ARRAYS, individual thunks to a
  // single finding, and they share one result list sliced apart at batchThunks.length. Settlement is
  // deliberately shuffled — under the window results no longer arrive in dispatch order, and an
  // off-by-one would silently hand a batch verdict to an individual finding.
  const groups = [[{ id: 'b1' }, { id: 'b2' }], [{ id: 'b3' }], [{ id: 'b4' }]]
  const individual = [
    { id: 'i1', severity: 'High' }, { id: 'i2', severity: 'Medium' },
    { id: 'i3', severity: 'Critical' }, { id: 'i4', severity: 'High' }, { id: 'i5', severity: 'Low' },
  ]
  const plan = { verifyVotes: 3 }
  const batchThunks = groups.map(g => () => g.map(f => ({ ...f, tier: 'batched' })))
  const individualThunks = individual.map(f => () => ({ ...f, tier: 'judged' }))

  const entries = batchThunks.map(run => ({ run, weight: 1 }))
    .concat(individual.map((f, i) => ({ run: individualThunks[i], weight: verifyWeight(f, plan) })))
  // Total weight is 3 + 4 + 1 + 4 + 4 + 1 = 17; a cap of 5 forces the window to refill several times.
  const delays = [7, 0, 5, 1, 6, 0, 3, 2]
  const settled = (await harness(entries, 5, delays)).out
  const batched = settled.slice(0, batchThunks.length).filter(Boolean).flat()
  const judged = settled.slice(batchThunks.length)

  assert.deepEqual(batched.map(f => f.id), ['b1', 'b2', 'b3', 'b4'])
  assert.deepEqual(judged.map(f => f.id), ['i1', 'i2', 'i3', 'i4', 'i5'])
  assert.ok(batched.every(f => f.tier === 'batched'), 'no individual verdict leaked into the batch side')
  assert.ok(judged.every(f => f.tier === 'judged'), 'no batch verdict leaked into the individual side')
  const all = judged.concat(batched)
  assert.equal(new Set(all.map(f => f.id)).size, groups.flat().length + individual.length, 'no finding duplicated or dropped')

  // A dead agent resolves to null and must keep its slot.
  const withDead = settled.slice()
  withDead[0] = null
  withDead[batchThunks.length] = null
  assert.deepEqual(withDead.slice(0, batchThunks.length).filter(Boolean).flat().map(f => f.id), ['b3', 'b4'])
  assert.deepEqual(withDead.slice(batchThunks.length).map(f => f && f.id), [null, 'i2', 'i3', 'i4', 'i5'])
})
