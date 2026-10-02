import { test } from 'node:test'
import assert from 'node:assert/strict'
import { wrapWorkflow } from './check-workflow-types.mjs'

test('a workflow is wrapped as the sandbox runs it, its inlined regions swapped for imports, lines kept', () => {
  const src = [
    'export const meta = { name: "x" }',
    '// >>> craft-inline lib/run-record.mjs isCount',
    'function isCount(v) { return v }',
    '// <<< craft-inline',
    'return isCount(args)',
  ].join('\n')
  const { text, offset } = wrapWorkflow(src, '/r')
  const out = text.split('\n')
  assert.equal(out[0], 'import { isCount } from "/r/lib/run-record.mjs"')
  assert.equal(out[offset - 1], 'async function __wf() {')
  // line N of the source is line N + offset of the wrapped module (1-based both ways)
  assert.equal(out[offset + 5 - 1], 'return isCount(args)')
  assert.equal(out[offset + 1 - 1], 'const meta = { name: "x" }')
  assert.ok(!text.includes('function isCount(v)'), 'the region body is gone')
  assert.ok(text.includes('void meta'))
})

test('a JSDoc import of a lib type resolves from the wrapped copy as it does from workflows/', () => {
  const { text } = wrapWorkflow("/** @type {import('../lib/run-record.mjs').RunRecord} */\nconst r = {}\nreturn r", '/r')
  assert.ok(text.includes("import('/r/lib/run-record.mjs').RunRecord"), text)
})
