import test from 'node:test'
import assert from 'node:assert/strict'
import { VERIFY_WAVE_AGENTS, verifyWeight, weightedWaves } from './review-waves.mjs'

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
  // or the wave is budgeted for fewer agents than it dispatches.
  for (const plan of [{}, { verifyVotes: 0 }, { verifyVotes: -5 }, { verifyVotes: 'lots' }, null, undefined]) {
    assert.equal(verifyWeight({ severity: 'High' }, plan), 2, `plan ${JSON.stringify(plan)} still budgets the opening pair`)
  }
})

// ---- weightedWaves: bounded, and ORDER-PRESERVING ----

test('weightedWaves bounds each wave by summed weight, not by item count', () => {
  const entries = Array.from({ length: 10 }, (_u, i) => ({ id: i, weight: 4 }))
  const waves = weightedWaves(entries, 10)
  for (const w of waves) {
    assert.ok(w.reduce((s, e) => s + e.weight, 0) <= 10, 'no wave exceeds the budget')
  }
  assert.deepEqual(waves.map(w => w.length), [2, 2, 2, 2, 2], '4+4=8 fits, 4+4+4=12 does not')
})

test('weightedWaves preserves order exactly — flattening the waves rebuilds the input', () => {
  // THE invariant: the caller slices the merged results positionally, so any reordering hands one
  // finding's verdict to another finding.
  const entries = Array.from({ length: 200 }, (_u, i) => ({ id: i, weight: (i % 5) + 1 }))
  for (const cap of [1, 2, 3, 4, 7, 24, 199, 1000]) {
    const waves = weightedWaves(entries, cap)
    assert.deepEqual(waves.flat().map(e => e.id), entries.map(e => e.id), `cap ${cap} preserves order`)
    assert.equal(waves.flat().length, entries.length, `cap ${cap} drops nothing`)
  }
})

test('an entry heavier than the whole budget gets its own wave rather than being dropped', () => {
  const entries = [{ id: 'a', weight: 1 }, { id: 'big', weight: 99 }, { id: 'b', weight: 1 }]
  const waves = weightedWaves(entries, 4)
  assert.deepEqual(waves.map(w => w.map(e => e.id)), [['a'], ['big'], ['b']])
  assert.deepEqual(waves.flat().map(e => e.id), ['a', 'big', 'b'])
})

test('weightedWaves survives junk weights and junk budgets without losing entries', () => {
  const entries = [{ id: 'a' }, { id: 'b', weight: NaN }, { id: 'c', weight: 0 }, { id: 'd', weight: -3 }, { id: 'e', weight: 'two' }]
  for (const cap of [24, 0, -1, NaN, undefined, 'lots']) {
    const waves = weightedWaves(entries, cap)
    assert.deepEqual(waves.flat().map(e => e.id), ['a', 'b', 'c', 'd', 'e'], `cap ${String(cap)} keeps every entry, in order`)
  }
  assert.deepEqual(weightedWaves([], 24), [], 'an empty list yields no waves at all')
})

test('the wave budget is set to a value that actually bounds the queue', () => {
  assert.ok(Number.isInteger(VERIFY_WAVE_AGENTS) && VERIFY_WAVE_AGENTS > 0)
  // Below the heaviest single thunk (a High at verifyVotes=3 → 4 agents) the budget would degenerate
  // into one thunk per wave and serialize verification; far above it, the queue is unbounded again.
  assert.ok(VERIFY_WAVE_AGENTS >= 4 && VERIFY_WAVE_AGENTS <= 40, `${VERIFY_WAVE_AGENTS} keeps waves parallel but bounded`)
})

// ---- end to end: the positional split still attributes every verdict correctly ----

test('waves + positional split attribute every verdict to the finding it belongs to', () => {
  // Reproduces the workflow's merge exactly: batch thunks resolve to ARRAYS, individual thunks to a
  // single finding, and they share one result list sliced apart at batchThunks.length. Running it
  // over MULTIPLE waves is the point — an off-by-one across a wave boundary would silently hand a
  // batch verdict to an individual finding, corruption no verdict count would reveal.
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
  // Total weight is 3 + 4 + 1 + 4 + 4 + 1 = 17; a cap of 5 forces several waves.
  const waves = weightedWaves(entries, 5)
  assert.ok(waves.length > 1, 'the fixture must actually span multiple waves, or it proves nothing')

  const settled = []
  for (const wave of waves) settled.push(...wave.map(e => e.run()))
  const batched = settled.slice(0, batchThunks.length).filter(Boolean).flat()
  const judged = settled.slice(batchThunks.length)

  assert.deepEqual(batched.map(f => f.id), ['b1', 'b2', 'b3', 'b4'])
  assert.deepEqual(judged.map(f => f.id), ['i1', 'i2', 'i3', 'i4', 'i5'])
  assert.ok(batched.every(f => f.tier === 'batched'), 'no individual verdict leaked into the batch side')
  assert.ok(judged.every(f => f.tier === 'judged'), 'no batch verdict leaked into the individual side')
  const all = judged.concat(batched)
  assert.equal(new Set(all.map(f => f.id)).size, groups.flat().length + individual.length, 'no finding duplicated or dropped')

  // A dead agent resolves to null and must keep its slot, wave boundary or not.
  const withDead = settled.slice()
  withDead[0] = null
  withDead[batchThunks.length] = null
  assert.deepEqual(withDead.slice(0, batchThunks.length).filter(Boolean).flat().map(f => f.id), ['b3', 'b4'])
  assert.deepEqual(withDead.slice(batchThunks.length).map(f => f && f.id), [null, 'i2', 'i3', 'i4', 'i5'])
})
