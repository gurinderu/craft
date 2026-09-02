import test from 'node:test'
import assert from 'node:assert/strict'
import { extractDeclaration, renderRegion, findRegions, lineDiff, checkAll, unresolvedSiblings } from './inline-regions.mjs'

const SRC = [
  '// leading note',
  '// second line',
  'export function alpha(x) {',
  '  return `}` + x  // a brace in a template literal must not end the slice',
  '}',
  '',
  'export const BETA = { a: 1 }',
  '',
  'export const DELTA = new Set([',
  "  'a', 'b',",
  '  // a comment inside the table travels with it',
  "  'c',",
  '])',
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

test('extracts a multi-line const table, ending at its closer at column 0', () => {
  assert.equal(extractDeclaration(SRC, 'DELTA'), [
    'const DELTA = new Set([',
    "  'a', 'b',",
    '  // a comment inside the table travels with it',
    "  'c',",
    '])',
  ].join('\n'))
})

test('a multi-line const with no closer at column 0 fails loudly', () => {
  assert.throws(
    () => extractDeclaration("export const OPEN = new Set([\n  'a',", 'OPEN'),
    /unterminated const 'OPEN'/,
  )
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

// The gate that a green run hid. `usableVote` was added to lib/adversarial-judge.mjs and called from
// `judgeVotes`, but the fence header still named only `judgeVotes` — so the workflow carried a call
// to a function it never defined. `check-workflows` printed "13 inlined region(s) match their
// source" and every unit test passed, because the tests import the lib copy where the definition
// exists and the region really did match the declarations it was told to name. A free identifier is
// a runtime error in JavaScript, so the script parsed too. It would have died at the first call,
// after the whole agent spend and before the run record was written.
test('a region calling a sibling export the fence does not carry is reported', () => {
  const source = `export function helper(x) { return x }\nexport function main(x) { return helper(x) }\n`
  const text = [
    '// >>> craft-inline lib/fake.mjs main',
    'function main(x) { return helper(x) }',
    '// <<< craft-inline',
  ].join('\n')
  const found = unresolvedSiblings(text, findRegions(text), () => source)
  assert.deepEqual(found.map(f => f.name), ['helper'])
})

test('it stays quiet when the fence carries the sibling, or the workflow declares it itself', () => {
  const source = `export function helper(x) { return x }\nexport function main(x) { return helper(x) }\n`
  const carried = [
    '// >>> craft-inline lib/fake.mjs helper main',
    'function helper(x) { return x }',
    'function main(x) { return helper(x) }',
    '// <<< craft-inline',
  ].join('\n')
  assert.deepEqual(unresolvedSiblings(carried, findRegions(carried), () => source), [])

  const declaredOutside = `function helper(x) { return x }\n${['// >>> craft-inline lib/fake.mjs main', 'function main(x) { return helper(x) }', '// <<< craft-inline'].join('\n')}`
  assert.deepEqual(unresolvedSiblings(declaredOutside, findRegions(declaredOutside), () => source), [])
})

test('a sibling named only in a comment is prose, not a call', () => {
  // A marker that fires on a mention would be one people stop reading — the same rule as everywhere
  // else here: it must fire on the failure and stay silent on the healthy case.
  const source = `export function helper(x) { return x }\nexport function main(x) { return x }\n`
  const text = [
    '// >>> craft-inline lib/fake.mjs main',
    '// helper(0) used to be called here, and is not any more',
    'function main(x) { return x }',
    '// <<< craft-inline',
  ].join('\n')
  assert.deepEqual(unresolvedSiblings(text, findRegions(text), () => source), [])
})
