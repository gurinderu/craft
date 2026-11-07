// wrapWorkflow's edges: a bundled-form engine is checked as written, any other form is refused as the build refuses it.
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { wrapWorkflow } from './check-workflow-types.mjs'
import { NOT_BUNDLED } from './engine-form.mjs'

test('a bundled-form engine is the module it is, its lines where they are', () => {
  const src = "import { x } from '../lib/x.mjs'\nexport const meta = { name: 'e' }\nexport async function __run() {\nreturn x\n}\n"
  assert.deepEqual(wrapWorkflow(src), { text: src, offset: 0 })
})

test('a sandbox body is refused, naming the form the build takes', () => {
  assert.throws(() => wrapWorkflow("export const meta = { name: 'e' }\nreturn args"), { message: NOT_BUNDLED })
  assert.throws(() => wrapWorkflow("const s = 'export async function __run() {'\nreturn s"), { message: NOT_BUNDLED }, 'the opener in a string is no bundled form')
})
