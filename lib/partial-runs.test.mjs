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

// The 2026-10-02 shape: a record recovered from checkpoints keeps its run's START as `ts` and carries
// that run's own checkpoints. A concurrent run on the same head that started seconds earlier and filed
// its complete record later is another run; only checkpoints the complete record folded in tell twins.
const BRANCH = 'feat/post-logout-uri-shape'
const HEAD_10_02 = 'fa3755cd5aab6d44d6fbb2fc278e03171e10e3ad'
/** @param {Record<string, unknown>} over */
const recovered = over => partial({
  ts: '2026-10-02T21-43-18Z', branch: BRANCH, head: HEAD_10_02, runEngineRevision: 4,
  phases: [
    { phase: 'rust-plan', at: '2026-10-02T21:43:18.964Z' },
    { phase: 'rust-lenses', at: '2026-10-02T21:58:49.434Z' },
    { phase: 'ledger-01', at: '2026-10-02T22:08:04.181Z', ledgerShard: { n: 1 } },
  ],
  ...over,
})
/** @param {Record<string, unknown>} over */
const finished = over => complete({
  ts: '2026-10-02T22-05-36Z', branch: BRANCH, head: HEAD_10_02,
  phases: [
    { phase: 'rust-plan', at: '2026-10-02T21:43:11.748Z' },
    { phase: 'rust-lenses', at: '2026-10-02T21:53:20.863Z' },
    { phase: 'rust-verify', at: '2026-10-02T21:56:48.862Z' },
  ],
  ...over,
})

test('a recovered record with checkpoints of its own is not hidden by a concurrent run that finished', () => {
  assert.equal(splitSuperseded([recovered({})], [finished({})]).kept.length, 1)
})

test('a recovered record is the twin of the complete record that folded in every checkpoint it carries', () => {
  const p = recovered({})
  // Ledger shards never reach a complete record's phases (finalize drops them), so they are no evidence.
  /** @param {Record<string, unknown>[]} listed */
  const own = listed => finished({ phases: [...listed, { phase: 'rust-verify', at: '2026-10-02T22:02:26.101Z' }] })
  const c = own([{ phase: 'rust-plan', at: '2026-10-02T21:43:18.964Z' }, { phase: 'rust-lenses', at: '2026-10-02T21:58:49.434Z' }])
  assert.equal(splitSuperseded([p], [c]).hidden[0]?.by, c)
  // One checkpoint missing, or the same instant under another phase name, is another run.
  assert.equal(splitSuperseded([p], [own([{ phase: 'rust-plan', at: '2026-10-02T21:43:18.964Z' }])]).kept.length, 1)
  assert.equal(splitSuperseded([p], [own([{ phase: 'rust-plan', at: '2026-10-02T21:43:18.964Z' }, { phase: 'rust-verify', at: '2026-10-02T21:58:49.434Z' }])]).kept.length, 1)
  // Only ledger shards: nothing the complete record could have folded in, so nothing tells a twin.
  assert.equal(splitSuperseded([recovered({ phases: [{ phase: 'ledger-01', at: '2026-10-02T22:08:04.181Z', ledgerShard: {} }] })], [c]).kept.length, 1)
  // The common conditions still hold over the checkpoint match.
  assert.equal(splitSuperseded([p], [{ ...c, branch: 'other' }]).kept.length, 1)
  assert.equal(splitSuperseded([p], [{ ...c, ts: '2026-10-02T21-43-00Z' }]).kept.length, 1)
})

test('a record recovered by a later craft is sliced by the engine of the run it recovered', () => {
  // engineRevision on a recovered record is the RECOVERING craft's; the run's own is runEngineRevision.
  const byR5 = recovered({ engineRevision: 5, runEngineRevision: 4, phases: [{ craftVersion: '0.34.1', engineRevision: 4 }] })
  assert.deepEqual(slicePartials([byR5], { engine: 'claude-code 0.34.1 r4' }), { shown: [byR5], unattributed: 0 })
  assert.deepEqual(slicePartials([byR5], { engine: 'claude-code 0.34.1 r5' }), { shown: [], unattributed: 0 })
  // Without runEngineRevision, the one revision its checkpoints agree on (the engine's own first).
  const fromPhases = partial({ engineRevision: 5, phases: [{ craftVersion: '0.34.1', workflowEngineRevision: 4, engineRevision: 5 }, { craftVersion: '0.34.1', engineRevision: 4 }] })
  assert.deepEqual(slicePartials([fromPhases], { engine: 'claude-code 0.34.1 r4' }).shown, [fromPhases])
  // Checkpoints that disagree leave the revision unknown: the `r?` bucket, as engineKey reads absence.
  const torn = partial({ engineRevision: 4, phases: [{ craftVersion: '0.34.1', engineRevision: 3 }, { craftVersion: '0.34.1', engineRevision: 4 }] })
  assert.deepEqual(slicePartials([torn], { engine: 'claude-code 0.34.1 r4' }).shown, [])
  assert.deepEqual(slicePartials([torn], { engine: 'claude-code 0.34.1 r?' }).shown, [torn])
  // An unversioned run of a later craft's recovery is not counted as this engine's unknown.
  assert.deepEqual(slicePartials([recovered({ engineRevision: 5, runEngineRevision: 3, phases: [{}] })], { engine: 'claude-code 0.34.1 r5' }), { shown: [], unattributed: 0 })
})
