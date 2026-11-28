// The outcome of the sorting before publication on the run store (integrations/shared/sorting-choice.mjs, the
// choice the binary appends, `craft runs sorting-choice`; realm @nick/craft, node #281): a publication's carried
// choices (the tally of how they ended is `craft runs retro`'s).
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { applyPublication } from './sorting-choice.mjs'

const SORTING = {
  defect: 2,
  doubtful: 3,
  inDiffJudged: true,
  findings: [
    { n: 1, title: 'renamed key', file: 'a.rs', line: 3 },
    { n: 2, title: 'old replicas', file: 'b.rs', line: 9 },
    { n: 3, title: 'outside', file: 'c.rs', line: 1 },
  ],
}
/** @param {Record<string, unknown>} [over] */
const rec = (over = {}) => ({
  schemaVersion: 1,
  kind: 'workflow',
  name: 'review',
  project: '/repo',
  branch: 'feat/x',
  ts: '20261020-100000',
  verdict: 'Warning',
  sorting: SORTING,
  ...over,
})

test("a publication after the fact carries each recorded choice to its finding's new number, and names those whose finding is gone", () => {
  const choices = { 1: { choice: 'question', at: 'a' }, 2: { choice: 'dropped', at: 'b' }, 3: { choice: 'defect', at: 'c' } }
  const record = rec({ sorting: { ...SORTING, choices } })
  const sorting = {
    defect: 3,
    doubtful: 2,
    inDiffJudged: true,
    findings: [
      { n: 1, title: 'old replicas', file: 'b.rs', line: 9 },
      { n: 2, title: 'renamed key', file: 'a.rs', line: 3 },
    ],
  }
  const got = applyPublication(record, { sorting, prComments: { posted: 1 }, memoryContradictions: null })
  assert.deepEqual(/** @type {any} */ (got.record).sorting.choices, { 1: { choice: 'dropped', at: 'b' }, 2: { choice: 'question', at: 'a' } })
  assert.deepEqual(got.dropped, ['3 (outside @ c.rs:1): defect'])
  assert.deepEqual(/** @type {any} */ (got.record).prComments, { posted: 1 })
  const none = applyPublication(rec(), { sorting, prComments: null, memoryContradictions: null })
  assert.equal(/** @type {any} */ (none.record).sorting.choices, undefined)
  assert.deepEqual(none.dropped, [])
})
