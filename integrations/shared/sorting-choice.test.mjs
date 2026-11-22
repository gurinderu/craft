// The outcome of the sorting before publication on the run store (integrations/shared/sorting-choice.mjs, the
// choice the binary appends, `craft runs sorting-choice`; realm @nick/craft, node #281): the newest sorted
// record of the project found, a publication's carried choices, and the tally analyze-runs prints.
import { test } from 'vitest'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { aggregate, renderReport } from './analyze-runs.mjs'
import { applyPublication, latestSortedRecord, newSortingTally, renderSortingSection, tallySorting } from './sorting-choice.mjs'

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

test('tally and section: of the doubtful, how many ended as defect, question, dropped, still undecided', () => {
  const t = newSortingTally()
  tallySorting(t, rec({ sorting: { ...SORTING, choices: { 1: { choice: 'defect' }, 2: { choice: 'question' } } } }))
  tallySorting(t, rec({ sorting: { defect: 1, doubtful: 1, findings: [{ n: 1 }], choices: { 1: { choice: 'dropped' }, 9: { choice: 'bogus' } } } }))
  tallySorting(t, rec({ sorting: undefined }))
  assert.deepEqual(t, { runs: 2, doubtful: 4, defect: 1, question: 1, dropped: 1, posted: 3 })
  assert.deepEqual(renderSortingSection(t), [
    '## SORTING — how the doubtful findings held back from the PR ended',
    '- 2 run(s) · 3 posted as defects at once · 4 held back as doubtful',
    '- of the doubtful: 1 posted as defect (25%) · 1 asked the author (25%) · 1 not posted (25%) · 1 still undecided',
  ])
  assert.match(String(renderSortingSection(newSortingTally())[1]), /NOT MEASURED/)
})

test('analyze-runs prints the section from the records', () => {
  const report = renderReport(aggregate([rec({ sorting: { ...SORTING, choices: { 3: { choice: 'dropped' } } } })]))
  assert.match(
    report,
    /## SORTING — how the doubtful findings held back from the PR ended\n- 1 run\(s\) · 2 posted as defects at once · 3 held back as doubtful\n- of the doubtful: 0 posted as defect \(0%\) · 0 asked the author \(0%\) · 1 not posted \(33%\) · 2 still undecided/,
  )
})

test("latestSortedRecord: the newest sorted record of this project, refused when it is another branch's", () => {
  const store = fs.mkdtempSync(path.join(os.tmpdir(), 'sorting-choice-'))
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'sorting-project-'))
  try {
    const key = fs.realpathSync(project)
    const older = path.join(store, '20261019-090000-workflow-review.json')
    const newer = path.join(store, '20261020-090000-workflow-review.json')
    fs.writeFileSync(older, JSON.stringify(rec({ project: key })))
    fs.writeFileSync(newer, JSON.stringify(rec({ project: key })))
    fs.writeFileSync(path.join(store, '20261021-090000-workflow-review.json'), JSON.stringify(rec({ project: '/other' })))
    fs.writeFileSync(path.join(store, '20261022-090000-workflow-review.json'), JSON.stringify(rec({ project: key, sorting: null })))
    assert.equal(latestSortedRecord(store, key, 'feat/x'), newer)
    assert.equal(latestSortedRecord(store, key, ''), newer, 'a detached HEAD takes the newest')
    assert.throws(() => latestSortedRecord(store, key, 'main'), /is of branch "feat\/x", not "main" — name the one meant with --record/)
    assert.throws(() => latestSortedRecord(path.join(store, 'nope'), key, 'feat/x'), /carries doubtful findings/)
  } finally {
    fs.rmSync(store, { recursive: true, force: true })
    fs.rmSync(project, { recursive: true, force: true })
  }
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
