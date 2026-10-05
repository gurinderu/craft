// wrapWorkflow's edges: which `meta` it unexports and reads, which lines a region blanks, how a
// region's names come back as one import.
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { wrapWorkflow } from './check-workflow-types.mjs'

const body = (/** @type {string} */ src) => {
  const { text, offset } = wrapWorkflow(src, '/r')
  return { head: text.split('\n').slice(0, offset), lines: text.split('\n').slice(offset, offset + src.split('\n').length) }
}

test('only an `export const meta` that opens a line is unexported, and only such a `meta` is read', () => {
  const { head, lines } = body("const s = 'export const meta'\nexport const meta = { name: 'x' }\nreturn s")
  assert.deepEqual(lines.slice(0, 2), ["const s = 'export const meta'", "       const meta = { name: 'x' }"])
  assert.ok(head.includes('void (() => meta)'), 'a meta below the first line is still read')
  assert.ok(!body("foo();       const meta = 1\nreturn 1").head.includes('void (() => meta)'), 'seven spaces mid-line are not an unexported meta')
  assert.ok(!body('return 1').head.includes('void (() => meta)'))
})

test('a region\'s names come back as one import and one read, and both of its fence lines are blanked', () => {
  const src = ['// >>> craft-inline lib/run-record.mjs isCount isRunRecord', 'function isCount() {}', 'function isRunRecord() {}', '// <<< craft-inline', 'return 1'].join('\n')
  const { head, lines } = body(src)
  assert.deepEqual(head.slice(0, 2), ['import { isCount, isRunRecord } from "/r/lib/run-record.mjs"', 'void [isCount, isRunRecord]'])
  assert.deepEqual(lines, ['', '', '', '', 'return 1'])
})
