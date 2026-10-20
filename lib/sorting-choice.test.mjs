// The outcome of the sorting before publication on the run store (lib/sorting-choice.mjs, the
// `craft-log-run sorting-choice` command; realm @nick/craft, node #281): the reviewer's choice appended to
// the same run's record, the newest sorted record of the project found, and the tally analyze-runs prints.
import { test } from 'vitest'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { run } from './craft-log-run.mjs'
import { aggregate, renderReport } from './analyze-runs.mjs'
import { applySortingChoice, latestSortedRecord, newSortingTally, renderSortingSection, tallySorting } from './sorting-choice.mjs'

const AT = new Date('2026-10-20T10:00:00Z')
const SORTING = { defect: 2, doubtful: 3, inDiffJudged: true, findings: [
  { n: 1, title: 'renamed key', file: 'a.rs', line: 3 }, { n: 2, title: 'old replicas', file: 'b.rs', line: 9 }, { n: 3, title: 'outside', file: 'c.rs', line: 1 },
] }
/** @param {Record<string, unknown>} [over] */
const rec = (over = {}) => ({ schemaVersion: 1, kind: 'workflow', name: 'review', project: '/repo', ts: '20261020-100000', verdict: 'Warning', sorting: SORTING, ...over })

test('apply: the choice under the finding number, a later one replacing it; the rest of the record kept', () => {
  const first = applySortingChoice(rec(), 2, 'question', AT)
  assert.ok(typeof first === 'object')
  assert.equal(first.finding.title, 'old replicas')
  assert.deepEqual(/** @type {any} */ (first.record).sorting.choices, { 2: { choice: 'question', at: '2026-10-20T10:00:00.000Z' } })
  assert.equal(first.record['verdict'], 'Warning')
  const again = applySortingChoice(first.record, 2, 'dropped', AT)
  assert.ok(typeof again === 'object')
  assert.equal(/** @type {any} */ (again.record).sorting.choices[2].choice, 'dropped')
  const third = applySortingChoice(again.record, 1, 'defect', AT)
  assert.ok(typeof third === 'object')
  assert.deepEqual(Object.keys(/** @type {any} */ (third.record).sorting.choices).sort(), ['1', '2'])
})

test('apply: refused, named — an unknown choice, no sorting, a number not listed', () => {
  assert.match(String(applySortingChoice(rec(), 1, 'ignore', AT)), /--choice must be one of question, defect, dropped/)
  assert.match(String(applySortingChoice(rec({ sorting: null }), 1, 'defect', AT)), /carries no sorting/)
  assert.match(String(applySortingChoice(rec(), 4, 'defect', AT)), /no doubtful finding numbered 4/)
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
  assert.match(report, /## SORTING — how the doubtful findings held back from the PR ended\n- 1 run\(s\) · 2 posted as defects at once · 3 held back as doubtful\n- of the doubtful: 0 posted as defect \(0%\) · 0 asked the author \(0%\) · 1 not posted \(33%\) · 2 still undecided/)
})

test('craft-log-run sorting-choice: appends to the newest sorted record of this project, through the one writer', async () => {
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
    assert.equal(latestSortedRecord(store, key), newer)
    const ok = await run(['sorting-choice', '--n', '2', '--choice', 'question', '--store', store, '--project', project], {})
    assert.equal(ok.exitCode, 0, ok.stderr.join('\n'))
    assert.match(String(ok.stdout[0]), /recorded question for doubtful finding 2 \(old replicas @ b\.rs:9\)/)
    assert.equal(JSON.parse(fs.readFileSync(newer, 'utf8')).sorting.choices[2].choice, 'question')
    assert.equal(JSON.parse(fs.readFileSync(older, 'utf8')).sorting.choices, undefined)
    const named = await run(['sorting-choice', '--n', '1', '--choice', 'dropped', '--record', older, '--store', store, '--project', project], {})
    assert.equal(named.exitCode, 0)
    assert.equal(JSON.parse(fs.readFileSync(older, 'utf8')).sorting.choices[1].choice, 'dropped')
    const bad = await run(['sorting-choice', '--n', '7', '--choice', 'defect', '--store', store, '--project', project], {})
    assert.equal(bad.exitCode, 1)
    assert.match(String(bad.stderr[0]), /no doubtful finding numbered 7/)
    assert.equal((await run(['sorting-choice', '--choice', 'defect', '--store', store, '--project', project], {})).exitCode, 1)
    const none = await run(['sorting-choice', '--n', '1', '--choice', 'defect', '--store', path.join(store, 'empty'), '--project', project], {})
    assert.match(String(none.stderr[0]), /carries doubtful findings/)
  } finally {
    fs.rmSync(store, { recursive: true, force: true })
    fs.rmSync(project, { recursive: true, force: true })
  }
})
