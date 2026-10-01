import { test } from 'node:test'
import assert from 'node:assert/strict'
import { failedProfiles, mergeGateStatus, profilesRanLenses, gateRecord, savedSurfaceDrops, surfaceGateRecord, optionalTallyFrom } from './profile-merge.mjs'
import { aggregate } from './analyze-runs.mjs'

// Per-profile results in the shape reviewProfile returns: a gate-failed profile returns
// `ranLenses: []`; a profile that ran carries the lenses that completed. Each carries its own
// surface-gate drops (`surfaceDropped`), which the gate decides BEFORE the mechanical gate runs —
// so a profile that then fails its gate still carries drops that were never a saving.
const rustGateFailed = { profile: { id: 'rust' }, gateStatus: 'fail', gateProvenance: 'cargo test red', surfaceDropped: ['compat', 'invariants'], ranLenses: [] }
const nixRan = { profile: { id: 'nix' }, gateStatus: 'pass', gateProvenance: 'nix flake check', surfaceDropped: ['negative-space'], ranLenses: ['correctness', 'security'] }
const nixGateFailed = { profile: { id: 'nix' }, gateStatus: 'fail', gateProvenance: 'nix flake check red', surfaceDropped: ['negative-space'], ranLenses: [] }

// A record whose `gate` and `surfaceGate` come from the same functions review.js's reviewRecord
// calls, with nothing gateable dispatched (`surfaceGateDispatched` is a Set in the engine).
const recordFrom = results => ({
  schemaVersion: 1, name: 'review', verdict: 'Block', notRun: [], dimensions: [],
  gate: gateRecord(results),
  surfaceGate: surfaceGateRecord(results, { dispatched: new Set(), namedByCritic: new Set() }),
})

test('gate status merges worst-of: any fail is fail, all pass is pass, otherwise unknown', () => {
  assert.equal(mergeGateStatus([rustGateFailed, nixRan]), 'fail')
  assert.equal(mergeGateStatus([{ gateStatus: 'pass' }, { gateStatus: 'pass' }]), 'pass')
  assert.equal(mergeGateStatus([{ gateStatus: 'pass' }, { gateStatus: 'unknown' }]), 'unknown')
})

test('failedProfiles names the red profiles and gateRecord merges worst-of with per-profile provenance', () => {
  const results = [rustGateFailed, nixRan]
  assert.deepEqual(failedProfiles(results).map(r => r.profile.id), ['rust'])
  assert.equal(gateRecord(results).status, 'fail')
  assert.equal(gateRecord(results).provenance, '[rust] cargo test red · [nix] nix flake check')
})

test('lensesRan is true when any profile got a lens agent back, false when none did or the field is absent', () => {
  assert.equal(profilesRanLenses([rustGateFailed, nixRan]), true)
  assert.equal(profilesRanLenses([rustGateFailed, nixGateFailed]), false)
  assert.equal(profilesRanLenses([{ gateStatus: 'fail' }]), false)
})

test('a gate-failed profile\'s drops are not savings; a drop dispatched in another profile is not either', () => {
  // Falsifier: unioning every profile's drops (the engine's behaviour before this) counts rust's
  // compat/invariants as saved although rust aborted before any lens could run.
  assert.deepEqual(savedSurfaceDrops([rustGateFailed, nixRan], []), ['negative-space'])
  const rustRan = { ...nixRan, profile: { id: 'rust' }, surfaceDropped: ['negative-space', 'compat'] }
  assert.deepEqual(savedSurfaceDrops([rustRan, nixRan], new Set(['negative-space'])), ['compat'])
})

test('surfaceGateRecord sorts, accepts Sets, and keeps only critic-named lenses that are still saved', () => {
  const p = { gateStatus: 'pass', surfaceDropped: ['perf', 'compat', 'invariants'], ranLenses: ['x'] }
  const sg = surfaceGateRecord([p], { dispatched: new Set(['invariants', 'a']), namedByCritic: new Set(['perf', 'invariants', 'other']) })
  // `invariants` was named but ran elsewhere, `other` was never dropped: neither is a gap.
  assert.deepEqual(sg, { dropped: ['compat', 'perf'], dispatched: ['a', 'invariants'], namedByCritic: ['perf'], lensesRan: true })
})

// realm @nick/craft #103: the mixed rust(fail)+nix(ran) run carries the same gate.status and the
// same empty `dispatched` as an all-abort, so only the merged `lensesRan` keeps its real saving.
test('mixed rust-fail + nix-ran run: the merged record keeps the nix saving in the analyzer', () => {
  const rec = recordFrom([rustGateFailed, nixRan])
  assert.equal(rec.gate.status, 'fail', 'worst-of: the rust failure makes the whole run red')
  const w = aggregate([rec]).workflows.find(x => x.name === 'review')
  assert.equal(w.sgGateFailedRuns, 0, 'a profile ran its lenses — not a fictional saving')
  assert.equal(w.sgSavedRuns, 1)
  assert.equal(w.sgSavedPasses, 1)
  assert.deepEqual(w.sgSavedByLens, { 'negative-space': 1 })
})

test('all profiles aborted at the gate: the merged record is excluded as a fictional saving', () => {
  const w = aggregate([recordFrom([rustGateFailed, nixGateFailed])]).workflows.find(x => x.name === 'review')
  assert.equal(w.sgGateFailedRuns, 1)
  assert.equal(w.sgSavedRuns, 0)
  assert.equal(w.sgSavedPasses, 0)
  assert.deepEqual(w.sgSavedByLens, {})
})

// realm @nick/craft #109: the optional-pass tally counts a red profile's lenses only where the caller
// asked for them — an unrequested lens there was never a declined purchase; a requested one was
// asked for and not delivered.
const OPT = ['performance', 'api-idioms', 'api-boundary']
test('optional tally: a red profile\'s unrequested lenses are neither ran nor skipped', () => {
  const red = { gateStatus: 'fail', optionalScope: OPT }
  assert.deepEqual(optionalTallyFrom([red], new Set()), { ran: [], skipped: [] })
})

test('optional tally: a red profile\'s requested lenses still read as skipped', () => {
  const red = { gateStatus: 'fail', optionalScope: OPT }
  assert.deepEqual(optionalTallyFrom([red], new Set(), ['performance']), { ran: [], skipped: ['performance'] })
})

test('optional tally: a passing profile\'s scope splits by dispatch, named once across profiles, in roster order', () => {
  const a = { gateStatus: 'pass', optionalScope: OPT }
  const b = { gateStatus: 'pass', optionalScope: ['api-idioms'] }
  assert.deepEqual(optionalTallyFrom([a, b], new Set(['api-idioms'])), { ran: ['api-idioms'], skipped: ['performance', 'api-boundary'] })
})

test('optional tally: a red and a passing profile together — the red one adds only what was requested', () => {
  const red = { gateStatus: 'fail', optionalScope: OPT }
  const ok = { gateStatus: 'pass', optionalScope: ['performance'] }
  assert.deepEqual(optionalTallyFrom([red, ok], new Set()), { ran: [], skipped: ['performance'] })
  assert.deepEqual(optionalTallyFrom([red, ok], new Set(), ['api-boundary']), { ran: [], skipped: ['api-boundary', 'performance'] })
  // A lens the red profile requested but the passing profile dispatched reads as ran, not skipped.
  assert.deepEqual(optionalTallyFrom([red, ok], new Set(['performance']), ['performance']), { ran: ['performance'], skipped: [] })
})

// realm @nick/craft #107: a lost slice per lens empties `ranLenses` but not the round counts.
test('lensesRan counts a profile whose lenses came back incomplete, not one whose agents all died', () => {
  const lostSlices = { gateStatus: 'pass', ranLenses: [], lensRounds: [{ round: 1, agents: 11, returned: 2 }] }
  const allDied = { gateStatus: 'pass', ranLenses: [], lensRounds: [{ round: 1, agents: 11, returned: 0 }] }
  const resurrected = { gateStatus: 'pass', ranLenses: ['safety'], lensRounds: [{ round: 1, agents: 1, returned: 0 }] }
  assert.equal(profilesRanLenses([rustGateFailed, lostSlices]), true)
  assert.equal(profilesRanLenses([rustGateFailed, allDied]), false, 'nothing came back — still reads as not run (an under-count)')
  assert.equal(profilesRanLenses([resurrected]), true, 'a lens recovered by resurrection counts through ranLenses')
})
