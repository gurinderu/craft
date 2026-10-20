// The memory-contradiction line of analyze-runs (lib/memory-contradiction-tally.mjs; realm @nick/craft,
// nodes #281, #282): the counts the review runs filed, and each finding's fate in the newest later round.
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { aggregate, renderReport } from './analyze-runs.mjs'
import { fateOf, renderContradictionLines, tallyContradictions } from './memory-contradiction-tally.mjs'

const BASE = { schemaVersion: 1, kind: 'workflow', name: 'review', project: '/p', branch: 'feat/x', verdict: 'Warning', findings: { total: 1 }, dimensions: [] }
/** @param {string} fp @param {boolean} toPr @param {number} signs */
const item = (fp, toPr, signs) => ({ fp, record: 'decision-cap', kind: 'decision', severity: 'Medium', title: 't', file: 'a', line: 1, doubtSigns: Array(signs).fill('s'), toPr })

test('fateOf: by the later ledger row; no later round, no fingerprint, a sharded or silent ledger', () => {
  const later = { ledger: [{ fp: 'a', disposition: 'closed' }, { fp: 'b', disposition: 'open' }, { fp: 'c', disposition: 'deferred' }] }
  assert.deepEqual(['a', 'b', 'c', 'd'].map(fp => fateOf(fp, later)), ['fixed', 'open', 'setAside', 'unknown'])
  assert.equal(fateOf('a', undefined), 'noLaterRound')
  assert.equal(fateOf('', undefined), 'unknown', 'no fingerprint (adversarial-review): no round chain to follow')
  assert.equal(fateOf('a', { ledgerInShards: { of: 1, total: 2 } }), 'unknown')
})

test('tallyContradictions: counts, signs, the PR, and the newest later round of the same branch decides', () => {
  const first = { ...BASE, ts: '2026-10-20T10-00-00Z', memoryContradictions: { count: 2, doubtSignsAlone: 1, inDiffJudged: true, findings: [item('a', true, 0), item('b', true, 1)] } }
  const mid = { ...BASE, ts: '2026-10-20T11-00-00Z', ledger: [{ fp: 'a', disposition: 'open' }] }
  const newest = { ...BASE, ts: '2026-10-20T12-00-00Z', ledger: [{ fp: 'a', disposition: 'closed' }, { fp: 'b', disposition: 'open' }], memoryContradictions: { count: 0, doubtSignsAlone: 0, inDiffJudged: true, findings: [] } }
  const otherBranch = { ...BASE, branch: 'feat/y', ts: '2026-10-20T13-00-00Z', ledger: [] }
  const nested = { ...BASE, nested: true, ts: '2026-10-20T14-00-00Z', ledger: [] }
  const t = tallyContradictions([first, mid, newest, otherBranch, nested])
  assert.deepEqual(t, { runs: 2, count: 2, doubtSignsAlone: 1, toPr: 2, fixed: 1, open: 1, setAside: 0, noLaterRound: 0, unknown: 0 })
  assert.match(String(renderContradictionLines(t)[1]), /^- 2 finding\(s\) in 2 run\(s\) · 1 the doubt signs alone would have sent to the reviewer · 2 sent to the PR as defects · later rounds: 1 fixed · 1 still open/)
  assert.match(String(renderContradictionLines(tallyContradictions([BASE]))[1]), /NOT MEASURED/)
})

test('analyze-runs prints the memory-contradiction line', () => {
  const r = { ...BASE, ts: '2026-10-20T10-00-00Z', memoryContradictions: { count: 1, doubtSignsAlone: 1, inDiffJudged: false, findings: [item('a', false, 1)] } }
  assert.match(renderReport(aggregate([r])), /## MEMORY CONTRADICTIONS[^\n]*\n- 1 finding\(s\) in 1 run\(s\) · 1 the doubt signs alone[^\n]*1 no later round/)
})
