// A CLI run stopped and resumed files a record per part (integrations/shared/run-parts.mjs): counted once, as its
// finished record, each part's cost on it once.
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { foldResumedRuns } from './run-duplicates.mjs'

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
  assert.equal(run['outputTokens'], 3694226 + 4256220)
  assert.equal(/** @type {any} */ (finished['cost']).total, 53805638, 'the record read is left as filed')
  assert.equal(foldResumedRuns([finished, stopped]).records.length, 1, 'whatever order they are read in')
})

test('a part whose cost was never measured leaves the run measured in part, not whole', () => {
  const { records } = foldResumedRuns([{ ...stopped, cost: null }, finished])
  assert.equal(/** @type {any} */ (records[0])['cost'].skipped, 1)
})

test('a run whose every part stopped stands as its newest; a record naming no run directory folds on nothing', () => {
  const later = { ...stopped, ts: '2026-11-22T10-00-00Z' }
  const { records, folded } = foldResumedRuns([stopped, later])
  assert.deepEqual([records.map(r => r['ts']), folded], [['2026-11-22T10-00-00Z'], 1])
  assert.equal(/** @type {any} */ (records[0])['cost'].total, 2 * 124261147)
  const legacy = foldResumedRuns([
    { ...stopped, cliRun: undefined },
    { ...finished, cliRun: undefined },
  ])
  assert.deepEqual([legacy.records.length, legacy.folded], [2, 0])
})
