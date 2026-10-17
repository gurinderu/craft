// Records of one run counted once (realm @nick/craft, node #249).
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { foldResumedRuns } from './run-duplicates.mjs'

/** @param {Record<string, unknown>} over @returns {Record<string, unknown>} */
const rec = over => ({ kind: 'workflow', name: 'review', project: '/p', branch: 'b', head: 'h', filesDigest: 'd', round: 1, ts: 't1', findings: { total: 1, bySeverity: { Low: 1 } }, ...over })

test('the newest record of one run stands for it', () => {
  const { records, folded } = foldResumedRuns([rec({ ts: 't2', v: 'new' }), rec({ ts: 't1', v: 'old' })])
  assert.equal(folded, 1)
  assert.deepEqual(records.map(r => r['v']), ['new'])
})

test('another engine build, project, head, digest, round, setting or finding count is another run', () => {
  const base = rec({})
  const others = [{ name: 'adversarial-review' }, { project: '/q' }, { head: 'g' }, { filesDigest: 'e' }, { round: 2 },
    { engineRevision: 5 }, { craftVersion: '9.9.9' }, { strict: true }, { dirty: true }, { partial: true },
    { findings: { total: 1, bySeverity: { High: 1 } } }].map(o => rec(o))
  const { records, folded } = foldResumedRuns([base, ...others])
  assert.equal(folded, 0)
  assert.equal(records.length, others.length + 1)
})

test('a record that proves no identity is never folded', () => {
  const { records, folded } = foldResumedRuns([rec({ filesDigest: '' }), rec({ filesDigest: '' }), rec({ head: '', commit: '' }), rec({ head: '', commit: '' })])
  assert.equal(folded, 0)
  assert.equal(records.length, 4)
})

test('a short commit stands in for a missing head', () => {
  const { folded } = foldResumedRuns([rec({ head: undefined, commit: 'c' }), rec({ head: undefined, commit: 'c', ts: 't2' })])
  assert.equal(folded, 1)
})

test('a nested review, a record with no branch and a run that found nothing are never folded', () => {
  for (const over of [{ nested: true }, { branch: '' }, { findings: { total: 0, bySeverity: {} } }]) {
    const { folded } = foldResumedRuns([rec(over), rec({ ...over, ts: 't2' })])
    assert.equal(folded, 0, JSON.stringify(over))
  }
})
