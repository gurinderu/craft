// Which unfinished records an engine or version slice of the run-store report lists, and how many it
// cannot attribute.
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { partialVersion, slicePartials, engineSlice } from './partial-slice.mjs'

// Slicing reads only the engine fields: runtime, version and revision, the record's own and its checkpoints'.
/** @param {Record<string, unknown>} over */
const partial = over => ({ name: 'review', partial: true, runtime: 'claude-code', engineRevision: 4, ...over })
/** A recovered record: the run's own revision stamped beside the recovering craft's. @param {Record<string, unknown>} over */
const recovered = over => partial({ runEngineRevision: 4, ...over })
/** @param {string} key */
const engine = key => {
  const slice = engineSlice(key)
  assert.ok(slice, key)
  return slice
}

test('an engine key that engineKey cannot write is no slice', () => {
  assert.equal(engineSlice('claude-code'), null)
  assert.deepEqual(engineSlice('claude-code unversioned r?'), { engine: 'claude-code unversioned r?', parts: { runtime: 'claude-code', version: null, revision: null } })
})

test('a partial is attributed to the version its phase checkpoints name when it carries none itself', () => {
  assert.equal(partialVersion({ craftVersion: '1.0.0' }), '1.0.0')
  assert.equal(partialVersion({ phases: [{ craftVersion: '0.24.4' }, { craftVersion: '0.24.4' }, {}] }), '0.24.4')
  assert.equal(partialVersion({ phases: [{ craftVersion: '0.24.4' }, { craftVersion: '0.24.5' }] }), null, 'two versions are no attribution')
  assert.equal(partialVersion({ phases: 'nope' }), null)
  assert.equal(partialVersion({}), null)
})

test('an engine slice lists its own partials and counts the ones it cannot attribute', () => {
  const mine = partial({ phases: [{ craftVersion: '0.34.1' }] })
  const older = partial({ phases: [{ craftVersion: '0.24.4' }] })
  const unknown = partial({})
  const otherRuntime = partial({ runtime: 'opencode' })
  const otherRev = partial({ engineRevision: 3 })
  const all = [mine, older, unknown, otherRuntime, otherRev]
  assert.deepEqual(slicePartials(all, engine('claude-code 0.34.1 r4')), { shown: [mine], unattributed: 1 })
  assert.deepEqual(slicePartials(all, { version: '0.24.4' }), { shown: [older], unattributed: 3 })
  assert.deepEqual(slicePartials(all, null), { shown: all, unattributed: 0 })
  // An unversioned engine is a key like any other: a record that names no version is that engine's.
  assert.deepEqual(slicePartials(all, engine('claude-code unversioned r4')), { shown: [unknown], unattributed: 0 })
})

test('a record recovered by a later craft is sliced by the engine of the run it recovered', () => {
  // engineRevision on a recovered record is the RECOVERING craft's; the run's own is runEngineRevision.
  const byR5 = recovered({ engineRevision: 5, runEngineRevision: 4, phases: [{ craftVersion: '0.34.1', engineRevision: 4 }] })
  assert.deepEqual(slicePartials([byR5], engine('claude-code 0.34.1 r4')), { shown: [byR5], unattributed: 0 })
  assert.deepEqual(slicePartials([byR5], engine('claude-code 0.34.1 r5')), { shown: [], unattributed: 0 })
  // Without runEngineRevision, the one revision its checkpoints agree on (the engine's own first).
  const fromPhases = partial({ engineRevision: 5, phases: [{ craftVersion: '0.34.1', workflowEngineRevision: 4, engineRevision: 5 }, { craftVersion: '0.34.1', engineRevision: 4 }] })
  assert.deepEqual(slicePartials([fromPhases], engine('claude-code 0.34.1 r4')).shown, [fromPhases])
  // Checkpoints that disagree leave the revision unknown: the `r?` bucket, as engineKey reads absence.
  const torn = partial({ engineRevision: 4, phases: [{ craftVersion: '0.34.1', engineRevision: 3 }, { craftVersion: '0.34.1', engineRevision: 4 }] })
  assert.deepEqual(slicePartials([torn], engine('claude-code 0.34.1 r4')).shown, [])
  assert.deepEqual(slicePartials([torn], engine('claude-code 0.34.1 r?')).shown, [torn])
  // An unversioned run of a later craft's recovery is not counted as this engine's unknown.
  assert.deepEqual(slicePartials([recovered({ engineRevision: 5, runEngineRevision: 3, phases: [{}] })], engine('claude-code 0.34.1 r5')), { shown: [], unattributed: 0 })
})
