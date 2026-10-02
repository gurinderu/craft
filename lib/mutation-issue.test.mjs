import { test } from 'vitest'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileMutationIssue, issueAction } from './mutation-issue.mjs'

const RUN = 'https://github.com/o/r/actions/runs/1'

test('issueAction: no open mutation issue — one is created, titled with the score', () => {
  const a = issueAction([{ number: 3, title: 'something else' }], '68.95%', RUN)
  assert.equal(a.kind, 'create')
  assert.equal(a.kind === 'create' && a.title, 'Weekly mutation run failed (68.95%)')
  assert.match(a.body, /68\.95%/)
  assert.match(a.body, /actions\/runs\/1/)
})

test('issueAction: an open one with another score is commented on, not duplicated', () => {
  const open = [{ number: 9, title: 'Weekly mutation run failed (no report)' }, { number: 7, title: 'Weekly mutation run failed (65.10%)' }]
  const a = issueAction(open, '68.95%', RUN)
  assert.equal(a.kind, 'comment')
  // The oldest open one carries the thread.
  assert.equal(a.kind === 'comment' && a.number, 7)
  assert.match(a.body, /68\.95%/)
  assert.match(a.body, /actions\/runs\/1/)
})

test('issueAction: a title that only mentions the phrase elsewhere is not the run issue', () => {
  const a = issueAction([{ number: 4, title: 'Why the Weekly mutation run failed (notes)' }], 'no report', RUN)
  assert.equal(a.kind, 'create')
})

/** @param {string} listed  what `gh issue list --json number,title` prints @returns {{ calls: string[][], gh: (args: string[]) => string }} */
function fakeGh(listed) {
  /** @type {string[][]} */
  const calls = []
  return { calls, gh: args => { calls.push(args); return args[1] === 'list' ? listed : '' } }
}

/** @param {unknown} report @returns {string} a report file */
function reportFile(report) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'craft-mut-issue-'))
  const file = path.join(dir, 'mutation.json')
  fs.writeFileSync(file, JSON.stringify(report))
  return file
}

test('fileMutationIssue: with an open issue it comments on it through gh, with the score from the report', () => {
  const { calls, gh } = fakeGh('[{"number":7,"title":"Weekly mutation run failed (65.10%)"}]')
  const report = reportFile({ files: { a: { mutants: [{ status: 'Killed' }, { status: 'Survived' }] } } })
  fileMutationIssue({ report, runUrl: RUN, gh })
  assert.equal(calls.length, 2)
  assert.deepEqual(calls[1]?.slice(0, 3), ['issue', 'comment', '7'])
  assert.match(calls[1]?.at(-1) ?? '', /50\.00%/)
})

test('fileMutationIssue: with none open and no report it creates one titled "no report"', () => {
  const { calls, gh } = fakeGh('[]')
  fileMutationIssue({ report: path.join(os.tmpdir(), 'craft-no-such-report.json'), runUrl: RUN, gh })
  assert.deepEqual(calls[1]?.slice(0, 4), ['issue', 'create', '--title', 'Weekly mutation run failed (no report)'])
})

test('fileMutationIssue: a listing it cannot read throws instead of opening a duplicate', () => {
  const { calls, gh } = fakeGh('not json')
  assert.throws(() => fileMutationIssue({ report: 'x', runUrl: RUN, gh }))
  assert.equal(calls.length, 1)
})
