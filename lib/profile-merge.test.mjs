import { test } from 'node:test'
import assert from 'node:assert/strict'
import { failedProfiles, mergeGateStatus, profilesRanLenses, gateRecord, surfaceGateRecord } from './profile-merge.mjs'
import { aggregate } from './analyze-runs.mjs'

// Per-profile results in the shape reviewProfile returns: a gate-failed profile returns
// `ranLenses: []`; a profile that ran carries the lenses that completed.
const rustGateFailed = { profile: { id: 'rust' }, gateStatus: 'fail', gateProvenance: 'cargo test red', ranLenses: [] }
const nixRan = { profile: { id: 'nix' }, gateStatus: 'pass', gateProvenance: 'nix flake check', ranLenses: ['correctness', 'security'] }
const nixGateFailed = { profile: { id: 'nix' }, gateStatus: 'fail', gateProvenance: 'nix flake check red', ranLenses: [] }

// A record whose `gate` and `surfaceGate` come from the same functions review.js's reviewRecord
// calls. The run-level sets are what the nix profile produced: negative-space dropped by the surface
// gate, nothing else gateable left to dispatch (`surfaceGateDispatched` is a Set in the engine).
const recordFrom = results => ({
  schemaVersion: 1, name: 'review', verdict: 'Block', notRun: [], dimensions: [],
  gate: gateRecord(results),
  surfaceGate: surfaceGateRecord(results, { dropped: ['negative-space'], dispatched: new Set(), namedByCritic: [] }),
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

test('lensesRan is true when any profile completed lenses, false when none did or the field is absent', () => {
  assert.equal(profilesRanLenses([rustGateFailed, nixRan]), true)
  assert.equal(profilesRanLenses([rustGateFailed, nixGateFailed]), false)
  assert.equal(profilesRanLenses([{ gateStatus: 'fail' }]), false)
})

test('surfaceGateRecord sorts the lens sets and accepts a Set for dispatched', () => {
  const sg = surfaceGateRecord([nixRan], { dropped: ['perf', 'compat'], dispatched: new Set(['b', 'a']), namedByCritic: ['perf'] })
  assert.deepEqual(sg, { dropped: ['compat', 'perf'], dispatched: ['a', 'b'], namedByCritic: ['perf'], lensesRan: true })
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
