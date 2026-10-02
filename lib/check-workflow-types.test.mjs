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

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { checkWorkflowTypes } from './check-workflow-types.mjs'
import { ROOT } from './inline-regions.mjs'

/** A throwaway repo root that borrows lib/, the OpenCode tsc and node_modules, with its own workflows/. */
function fakeRoot(/** @type {Record<string, string>} */ scripts, { withTsconfig = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'craft-wft-'))
  fs.mkdirSync(path.join(root, 'workflows'))
  for (const [name, src] of Object.entries(scripts)) fs.writeFileSync(path.join(root, 'workflows', name), src)
  fs.symlinkSync(path.join(ROOT, 'opencode'), path.join(root, 'opencode'))
  fs.symlinkSync(path.join(ROOT, 'node_modules'), path.join(root, 'node_modules'))
  if (withTsconfig) fs.symlinkSync(path.join(ROOT, 'lib'), path.join(root, 'lib'))
  else {
    fs.mkdirSync(path.join(root, 'lib'))
    fs.copyFileSync(path.join(ROOT, 'lib', 'workflow-sandbox.d.ts'), path.join(root, 'lib', 'workflow-sandbox.d.ts'))
  }
  return root
}

test('a planted type error is reported at its own line of workflows/<file>.js', () => {
  const root = fakeRoot({ 'x.js': ['export const meta = { name: "x" }', 'const n = 1', 'const bad = [1][0].toFixed()', 'return n'].join('\n') })
  const { problems } = checkWorkflowTypes(root)
  assert.ok(problems.some(p => p.startsWith('workflows/x.js:3:')), problems.join('\n'))
  fs.rmSync(root, { recursive: true, force: true })
})

test('a tsc failure with no file location (a missing config) fails the check, never passes it', () => {
  const root = fakeRoot({ 'x.js': 'return 1' }, { withTsconfig: false })
  const { problems } = checkWorkflowTypes(root)
  assert.ok(problems.length > 0, 'nothing was type-checked, so the check must not pass')
  fs.rmSync(root, { recursive: true, force: true })
})
