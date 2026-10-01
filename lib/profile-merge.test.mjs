import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mergeGateStatus, profilesRanLenses } from './profile-merge.mjs'
import { aggregate } from './analyze-runs.mjs'

// Per-profile results in the shape reviewProfile returns: a gate-failed profile returns
// `ranLenses: []`; a profile that ran carries the lenses that completed.
const rustGateFailed = { profile: { id: 'rust' }, gateStatus: 'fail', ranLenses: [] }
const nixRan = { profile: { id: 'nix' }, gateStatus: 'pass', ranLenses: ['correctness', 'security'] }
const nixGateFailed = { profile: { id: 'nix' }, gateStatus: 'fail', ranLenses: [] }

// The record fields review.js builds from the merge — `gate.status` and `surfaceGate.lensesRan` —
// with the nix profile's surface-gate drop of negative-space and nothing left to dispatch.
const recordFrom = results => ({
  schemaVersion: 1, name: 'review', verdict: 'Block', notRun: [], dimensions: [],
  gate: { status: mergeGateStatus(results) },
  surfaceGate: { dropped: ['negative-space'], dispatched: [], namedByCritic: [], lensesRan: profilesRanLenses(results) },
})

test('gate status merges worst-of: any fail is fail, all pass is pass, otherwise unknown', () => {
  assert.equal(mergeGateStatus([rustGateFailed, nixRan]), 'fail')
  assert.equal(mergeGateStatus([{ gateStatus: 'pass' }, { gateStatus: 'pass' }]), 'pass')
  assert.equal(mergeGateStatus([{ gateStatus: 'pass' }, { gateStatus: 'unknown' }]), 'unknown')
})

test('lensesRan is true when any profile completed lenses, false when none did or the field is absent', () => {
  assert.equal(profilesRanLenses([rustGateFailed, nixRan]), true)
  assert.equal(profilesRanLenses([rustGateFailed, nixGateFailed]), false)
  assert.equal(profilesRanLenses([{ gateStatus: 'fail' }]), false)
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
