// A CLI run stopped and resumed files a record per part (integrations/shared/run-parts.mjs): counted once, as its
// finished record, each part's cost on it once.
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { foldResumedRuns } from './run-duplicates.mjs'
import { costProblem } from './run-record.mjs'

/** @param {number} total @param {string} source */
const cost = (total, source) => ({
  output: total,
  input: 0,
  cacheRead: 0,
  cacheWrite: 0,
  total,
  agents: 1,
  source,
  rule: 'per-message',
  slice: { index: 1, of: 1 },
})

/** @param {Record<string, unknown>} over @returns {Record<string, unknown>} */
const part = over => ({
  schemaVersion: 1,
  kind: 'workflow',
  name: 'review',
  driver: 'cli',
  project: '/p',
  branch: 'b',
  head: 'h',
  cliRun: '/s/cli/1795339093-2927550',
  findings: { total: 0, bySeverity: {} },
  ...over,
})

// As the 2026-11-22 rauthy review filed them: the stopped part, then the resume's finished one.
const stopped = part({ ts: '2026-11-22T09-42-49Z', verdict: 'INCOMPLETE', round: 1, outputTokens: 3694226, cost: cost(124261147, 'wf_a') })
const finished = part({ ts: '2026-11-22T09-56-50Z', verdict: 'Block', round: 2, outputTokens: 4256220, cost: cost(53805638, 'wf_b') })

test("a stopped part folds into its run's finished record, which carries both parts' cost once", () => {
  const { records, folded } = foldResumedRuns([stopped, finished])
  assert.equal(folded, 1)
  assert.equal(records.length, 1)
  const run = /** @type {Record<string, any>} */ (records[0])
  assert.deepEqual([run['verdict'], run['round'], run['ts']], ['Block', 2, '2026-11-22T09-56-50Z'])
  assert.equal(run['cost'].total, 124261147 + 53805638)
  assert.equal(run['cost'].output, 124261147 + 53805638)
  assert.equal(run['cost'].agents, 2)
  assert.equal(run['outputTokens'], 4256220, "the indicative pool is the standing record's own, never summed")
  assert.equal(/** @type {any} */ (finished['cost']).total, 53805638, 'the record read is left as filed')
  assert.equal(foldResumedRuns([finished, stopped]).records.length, 1, 'whatever order they are read in')
})

test('a part whose cost was never measured, or measured in part, leaves the run measured in part, not whole', () => {
  const unmeasured = /** @type {Record<string, any>} */ (foldResumedRuns([{ ...stopped, cost: null }, finished]).records[0])
  assert.deepEqual([unmeasured['cost'].partsUnmeasured, unmeasured['cost'].skipped], [1, undefined], 'skipped counts transcripts, not parts')
  assert.equal(costProblem(unmeasured['cost']), 'partial', 'a lower bound is never averaged in as a whole cost')
  const lower = { ...stopped, cost: { ...cost(10, 'wf_a'), skipped: 2 } }
  const partial = /** @type {Record<string, any>} */ (foldResumedRuns([lower, finished]).records[0])
  assert.deepEqual([partial['cost'].total, partial['cost'].skipped], [10 + 53805638, 2], "the partial part's measured share is kept")
  assert.equal(costProblem(partial['cost']), 'partial')
})

test('a run whose every part stopped stands as its newest; a record naming no run directory folds on nothing', () => {
  const later = { ...stopped, ts: '2026-11-22T10-00-00Z', cost: cost(124261147, 'wf_c') }
  const { records, folded } = foldResumedRuns([stopped, later])
  assert.deepEqual([records.map(r => r['ts']), folded], [['2026-11-22T10-00-00Z'], 1])
  assert.equal(/** @type {any} */ (records[0])['cost'].total, 2 * 124261147)
  const legacy = foldResumedRuns([
    { ...stopped, cliRun: undefined },
    { ...finished, cliRun: undefined },
  ])
  assert.deepEqual([legacy.records.length, legacy.folded], [2, 0])
})

test('parts one Workflow run filed share its cost: summed once per workflow and slice, its token pool never summed', () => {
  // A phantom INCOMPLETE of the same Workflow run as the finished record: the same cost slice, its own pool reading.
  const phantom = { ...stopped, cost: finished['cost'], outputTokens: 4000000 }
  const run = /** @type {Record<string, any>} */ (foldResumedRuns([phantom, finished]).records[0])
  assert.deepEqual([run['cost'].total, run['outputTokens']], [53805638, 4256220])
  // Two slices of one Workflow run's cost are its two records' disjoint shares: both count.
  const first = { ...stopped, cost: { ...cost(10, 'wf_c'), slice: { index: 1, of: 2 } }, outputTokens: 5 }
  const second = { ...finished, cost: { ...cost(20, 'wf_c'), slice: { index: 2, of: 2 } }, outputTokens: 9 }
  const sliced = /** @type {Record<string, any>} */ (foldResumedRuns([first, second]).records[0])
  assert.deepEqual([sliced['cost'].total, sliced['outputTokens']], [30, 9])
})
