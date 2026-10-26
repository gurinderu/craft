// Which unfinished records the run-store report lists: the ones the selected engine wrote, and none
// whose run went on to write its complete record.
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { storeTsMs, partialVersion, splitSuperseded, slicePartials } from './partial-runs.mjs'

const HEAD = '23342f2964d2dade85d92dbf342faeaa23d63d4b'
const PROJECT = '/work/vodopad'
/** @param {Record<string, unknown>} over */
const partial = over => ({ name: 'review', partial: true, ts: '2026-10-25T21-38-37Z', project: PROJECT, branch: 'review-1360', head: '23342f29', runtime: 'claude-code', engineRevision: 4, ...over })
/** @param {Record<string, unknown>} over */
const complete = over => ({
  name: 'review', ts: '2026-10-25T21-39-42Z', project: PROJECT, branch: 'review-1360', head: HEAD,
  runtime: 'claude-code', craftVersion: '0.34.1', engineRevision: 4,
  phases: [{ phase: 'rust-verify', at: '2026-10-25T18:32:54.659Z' }, { phase: 'rust-lenses', at: '2026-10-25T18:31:23.544Z' }],
  ...over,
})

test('a store timestamp reads as the instant it names', () => {
  assert.equal(storeTsMs('2026-10-25T21-38-37Z'), Date.parse('2026-10-25T21:38:37Z'))
  assert.equal(storeTsMs('2026-10-25T21:38:37Z'), null)
  assert.equal(storeTsMs(undefined), null)
  assert.equal(storeTsMs('2026-13-45T99-99-99Z'), null)
})

test('the observed rebuilt twin is hidden behind the complete record of the same run', () => {
  const p = partial({}), c = complete({})
  const { kept, hidden } = splitSuperseded([p], [c])
  assert.deepEqual(kept, [])
  assert.equal(hidden.length, 1)
  assert.equal(hidden[0]?.partial, p)
  assert.equal(hidden[0]?.by, c)
  // The prefix runs either way.
  assert.equal(splitSuperseded([partial({ head: HEAD })], [complete({ head: '23342f2964' })]).hidden.length, 1)
})

test('a partial stays listed unless every sign says the same run finished', () => {
  /** @type {Array<[string, Record<string, unknown>, Record<string, unknown>]>} */
  const cases = [
    ['complete has no phases', {}, { phases: [] }],
    ['complete phases carry no time', {}, { phases: [{ phase: 'x' }] }],
    ['complete started after the partial was written', {}, { phases: [{ at: '2026-10-25T21:38:38Z' }] }],
    ['complete is older', {}, { ts: '2026-10-25T21-38-37Z' }],
    ['another project', {}, { project: '/work/other' }],
    ['another branch', {}, { branch: 'review-1361' }],
    ['no branch on either', { branch: '' }, { branch: '' }],
    ['heads differ', { head: '23342f30' }, {}],
    ['head too short to tell', { head: '233429' }, { head: '233429' }],
    ['no head', { head: null }, {}],
    ['not a review', { name: 'rust-audit' }, { name: 'rust-audit' }],
    ['partial ts unreadable', { ts: 'yesterday' }, {}],
  ]
  for (const [why, p, c] of cases) {
    assert.equal(splitSuperseded([partial(p)], [complete(c)]).kept.length, 1, why)
  }
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
  assert.deepEqual(slicePartials(all, { engine: 'claude-code 0.34.1 r4' }), { shown: [mine], unattributed: 1 })
  assert.deepEqual(slicePartials(all, { version: '0.24.4' }), { shown: [older], unattributed: 3 })
  assert.deepEqual(slicePartials(all, null), { shown: all, unattributed: 0 })
  // An unversioned engine is a key like any other: a record that names no version is that engine's.
  assert.deepEqual(slicePartials(all, { engine: 'claude-code unversioned r4' }), { shown: [unknown], unattributed: 0 })
})
