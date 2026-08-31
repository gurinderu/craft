import test from 'node:test'
import assert from 'node:assert/strict'
import { extractDeclaration, renderRegion, findRegions, lineDiff, checkAll } from './inline-regions.mjs'

const SRC = [
  '// leading note',
  '// second line',
  'export function alpha(x) {',
  '  return `}` + x  // a brace in a template literal must not end the slice',
  '}',
  '',
  'export const BETA = { a: 1 }',
  '',
  'export function gamma() {',
  '  return /}/.test("}")',
  '}',
  '',
].join('\n')

test('extracts a function with its leading comment block and drops `export`', () => {
  assert.equal(extractDeclaration(SRC, 'alpha'), [
    '// leading note',
    '// second line',
    'function alpha(x) {',
    '  return `}` + x  // a brace in a template literal must not end the slice',
    '}',
  ].join('\n'))
})

test('braces inside strings, template literals and regexes do not confuse the slicer', () => {
  assert.equal(extractDeclaration(SRC, 'gamma'), 'function gamma() {\n  return /}/.test("}")\n}')
})

test('extracts a single-line const', () => {
  assert.equal(extractDeclaration(SRC, 'BETA'), 'const BETA = { a: 1 }')
})

test('an unknown name is an error, not a silent empty region', () => {
  assert.throws(() => extractDeclaration(SRC, 'delta'), /no exported declaration named 'delta'/)
})

test('a rendered region is valid JS and joins entries with one blank line', () => {
  assert.equal(renderRegion(SRC, ['BETA', 'gamma']), 'const BETA = { a: 1 }\n\nfunction gamma() {\n  return /}/.test("}")\n}')
})

test('findRegions reads the fence header and the exact bytes between the fences', () => {
  const text = [
    'before',
    '// >>> craft-inline lib/run-record.mjs alpha beta',
    'body line',
    '// <<< craft-inline',
    'after',
  ].join('\n')
  const [r] = findRegions(text)
  assert.equal(r.source, 'lib/run-record.mjs')
  assert.deepEqual(r.names, ['alpha', 'beta'])
  assert.equal(r.actual, 'body line')
})

test('an unclosed fence fails loudly', () => {
  assert.throws(() => findRegions('// >>> craft-inline lib/run-record.mjs alpha\nbody'), /unclosed craft-inline fence/)
})

test('lineDiff shows the drifted line on both sides', () => {
  assert.equal(lineDiff('a\nb', 'a\nc'), '    - c\n    + b')
})

test('every inlined region in workflows/ currently matches lib/', () => {
  const res = checkAll()
  assert.deepEqual(res.mismatches, [])
  assert.ok(res.regionCount > 0, 'expected at least one fenced region')
})
