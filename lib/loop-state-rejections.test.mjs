// Which rejection reasons prove a round happened, and which of those carry a STOPPED run's head.
// The two lists are decisions, not data: dropping 'partial-only' from the stopped list reads a stalled
// run's head as a completed incremental round, and re-running on that same commit then reviews an empty
// delta as an ordinary re-review (realm @nick/craft, node #76). Pinned through the functions the
// readers call, not only through the exported arrays.
import { test, vi } from 'vitest'
import assert from 'node:assert/strict'

// The lists are module-level constants, evaluated once on import. Re-evaluating the module inside each
// test is what lets mutation coverage credit these tests with them, rather than whichever test happened
// to import the module first.
const fresh = async () => {
  vi.resetModules()
  return import('./loop-state.mjs')
}

test('provesRound: an unreadable detail and a stopped run both prove a round', async () => {
  const { provesRound } = await fresh()
  assert.equal(provesRound('detail-unreadable'), true)
  assert.equal(provesRound('partial-only'), true)
})

test('provesRound: no reason proves nothing — empty, undefined and null alike', async () => {
  const { provesRound } = await fresh()
  assert.equal(provesRound(''), false)
  assert.equal(provesRound(undefined), false)
  assert.equal(provesRound(null), false)
})

test('headFromStoppedRun: only a stopped run carries a head the engine must not diff off', async () => {
  const { headFromStoppedRun } = await fresh()
  assert.equal(headFromStoppedRun('partial-only'), true)
  assert.equal(headFromStoppedRun('detail-unreadable'), false,
    'a finished round whose detail is damaged still has a completed head; an incremental delta off it is legitimate')
})

test('headFromStoppedRun: no reason is no stopped run — empty, undefined and null alike', async () => {
  const { headFromStoppedRun } = await fresh()
  assert.equal(headFromStoppedRun(''), false)
  assert.equal(headFromStoppedRun(undefined), false)
  assert.equal(headFromStoppedRun(null), false)
})
