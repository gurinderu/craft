// Unit tests of lib/focus-files.mjs: the `files` argument adversarial-review takes from a launching review.
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { focusFilesArg, focusLine } from './focus-files.mjs'

test('files arrive as a list or one comma-separated string, blanks dropped', () => {
  assert.deepEqual(focusFilesArg(['a.js', ' b.ts ', '', 3]), ['a.js', 'b.ts'])
  assert.deepEqual(focusFilesArg('a.js, b.ts,,'), ['a.js', 'b.ts'])
  assert.deepEqual(focusFilesArg(undefined), [])
  assert.deepEqual(focusFilesArg({}), [])
})

test('the lens line names the files, and is empty without them', () => {
  assert.equal(focusLine([]), '')
  assert.match(focusLine(['a.js', 'b.ts']), /^FOCUS: review only these changed files .*: a\.js, b\.ts$/)
})

test('adversarial-review speaks the focus to its finder lenses and files the record as nested under review', async () => {
  const { runEngine, filedRecord } = await import('./engine-harness.mjs')
  const scout = { head: 'abc1234', baseRef: 'main', sizeBucket: 'small', lenses: ['correctness', 'errors'], changedFiles: ['src/lib.rs', 'web/app.js'], notes: '' }
  const run = await runEngine('adversarial-review', { args: { diffBase: 'main', files: ['web/app.js'], _via: 'review' }, script: { scout, 'log-run': { ok: true, output: [] }, '*': null } })
  const finders = run.calls.filter(c => /You are the \*\*(correctness|errors)\*\* review lens/.test(c.prompt))
  assert.ok(finders.length >= 2, run.calls.map(c => c.label).join(', '))
  for (const c of finders) assert.match(c.prompt, /FOCUS: review only these changed files .*: web\/app\.js/)
  const rec = filedRecord(run)
  assert.deepEqual([rec?.nested, rec?.via], [true, 'review'])
  const plain = await runEngine('adversarial-review', { args: { diffBase: 'main' }, script: { scout, '*': null } })
  assert.ok(!plain.calls.some(c => /FOCUS:/.test(c.prompt)))
})
