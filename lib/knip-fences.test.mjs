import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fencesAsImports } from '../knip.config.js'

// The compiler is what Knip reads in place of an engine body: a name it emits is a use. Listing a
// name in a craft-inline fence only copies it into the engine; the engine calling it is the use.
const ENGINE = [
  '// Mirrors: called, carriedOnly, mentionedOnly (a comment naming a helper is not a call)',
  '// >>> craft-inline lib/src-a.mjs called carriedOnly mentionedOnly crossCalled',
  'function called() { return 1 }',
  'function carriedOnly() { return called() }',
  'function mentionedOnly() { return 3 }',
  'function crossCalled() { return 4 }',
  '// <<< craft-inline',
  '// >>> craft-inline lib/src-b.mjs viaOtherRegion',
  'function viaOtherRegion() { return crossCalled() }',
  '// <<< craft-inline',
  'const x = called() // mentionedOnly is named here only in a trailing comment',
  '/* mentionedOnly in a block comment */',
  'return viaOtherRegion()',
].join('\n')

test('fencesAsImports: a spread is a use, a `/*` inside a string opens no comment, a property is not a use', () => {
  const text = [
    '// >>> craft-inline lib/src-a.mjs spread inPrompt prop',
    'function spread() {}',
    'function inPrompt() {}',
    'function prop() {}',
    '// <<< craft-inline',
    'const tally = { ...spread() }',
    'const prompt = `never list .ci/workflows/* wholesale',
    '${inPrompt()}`',
    'const y = other.prop',
    'const z = 1 /* ends here */',
  ].join('\n')
  assert.equal(fencesAsImports(text, 'workflows/e.js'), "import { spread, inPrompt } from '../lib/src-a.mjs'")
})

/** @param {string} out @returns {string[]} */
const importLines = out => out.split('\n').filter(Boolean).sort()

test('fencesAsImports: only names the engine references outside their own region count as used', () => {
  assert.deepEqual(importLines(fencesAsImports(ENGINE, '/repo/workflows/engine.js')), [
    "import { called, crossCalled } from '../lib/src-a.mjs'",
    "import { viaOtherRegion } from '../lib/src-b.mjs'",
  ])
})

test('fencesAsImports: a fence whose names the engine never calls emits nothing', () => {
  const text = '// >>> craft-inline lib/src-a.mjs dead\nfunction dead() {}\n// <<< craft-inline\nreturn 1'
  assert.equal(fencesAsImports(text, 'workflows/engine.js').trim(), '')
})

test('fencesAsImports: a file outside workflows/ passes through untouched', () => {
  assert.equal(fencesAsImports(ENGINE, '/repo/lib/x.js'), ENGINE)
})
