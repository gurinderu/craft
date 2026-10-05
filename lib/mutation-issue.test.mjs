import { onTestFinished, test } from 'vitest'
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

/**
 * A stand-in for `gh` that records every argv it is called with and prints `listed` for `issue list`.
 * @param {string} listed  what `gh issue list --json number,title` prints @returns {{ calls: string[][], gh: (args: string[]) => string }}
 */
function fakeGh(listed) {
  /** @type {string[][]} */
  const calls = []
  return { calls, gh: args => { calls.push(args); return args[1] === 'list' ? listed : '' } }
}

/** @param {string[]} argv @param {string} flag @returns {string | undefined} the value after `flag`, undefined when absent */
const flag = (argv, flag) => (argv.includes(flag) ? argv[argv.indexOf(flag) + 1] : undefined)

test('fileMutationIssue: the listing asks gh for the open issues whose title carries the phrase', () => {
  const { calls, gh } = fakeGh('[]')
  fileMutationIssue({ report: 'x', runUrl: RUN, gh })
  const list = calls[0] ?? []
  assert.deepEqual(list.slice(0, 2), ['issue', 'list'])
  assert.equal(flag(list, '--state'), 'open')
  assert.equal(flag(list, '--search'), 'in:title "Weekly mutation run failed"')
  assert.equal(flag(list, '--json'), 'number,title')
  // Room for every open issue the search returns, so the oldest of ours is among them.
  assert.ok(Number(flag(list, '--limit')) >= 100, flag(list, '--limit'))
})

test('fileMutationIssue: an issue gh returns with another title is not commented on — one is created', () => {
  const { calls, gh } = fakeGh('[{"number":5,"title":"Mutation run notes: Weekly mutation run failed (why)"}]')
  fileMutationIssue({ report: 'x', runUrl: RUN, gh })
  assert.deepEqual(calls.map(c => c[1]), ['list', 'create'])
})

test('fileMutationIssue: a listing that is not an array of { number, title } throws before any write', () => {
  for (const listed of ['{}', '[null]', '[7]', '[{"number":"7","title":"a"}]', '[{"number":7}]', '[{"title":"a"}]']) {
    const { calls, gh } = fakeGh(listed)
    assert.throws(() => fileMutationIssue({ report: 'x', runUrl: RUN, gh }), { message: 'gh issue list did not print an array of { number, title }' }, listed)
    assert.equal(calls.length, 1, listed)
  }
})

/** @param {unknown} report @returns {string} a report file */
function reportFile(report) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'craft-mut-issue-'))
  onTestFinished(() => fs.rmSync(dir, { recursive: true, force: true }))
  const file = path.join(dir, 'mutation.json')
  fs.writeFileSync(file, JSON.stringify(report))
  return file
}

test('fileMutationIssue: with an open issue it comments on it through gh, with the score from the report', () => {
  const { calls, gh } = fakeGh('[{"number":7,"title":"Weekly mutation run failed (65.10%)"}]')
  const report = reportFile({ files: { a: { mutants: [{ status: 'Killed' }, { status: 'Survived' }] } } })
  fileMutationIssue({ report, runUrl: RUN, gh })
  assert.equal(calls.length, 2)
  assert.deepEqual(calls[1], ['issue', 'comment', '7', '--body', `Failed again: ${RUN}\n\nScore: 50.00%.`])
})

test('fileMutationIssue: with none open and no report it creates one titled "no report"', () => {
  const { calls, gh } = fakeGh('[]')
  fileMutationIssue({ report: path.join(os.tmpdir(), 'craft-no-such-report.json'), runUrl: RUN, gh })
  assert.deepEqual(calls[1]?.slice(0, 4), ['issue', 'create', '--title', 'Weekly mutation run failed (no report)'])
  assert.equal(calls[1]?.[4], '--body')
  assert.match(calls[1]?.[5] ?? '', /^The weekly mutation run failed: https:.*\n\nScore: no report /)
})

test('fileMutationIssue: a listing it cannot read throws instead of opening a duplicate', () => {
  const { calls, gh } = fakeGh('not json')
  assert.throws(() => fileMutationIssue({ report: 'x', runUrl: RUN, gh }))
  assert.equal(calls.length, 1)
})
