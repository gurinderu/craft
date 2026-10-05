// Names with `$` in them, and a one-line function with a comment after it: two shapes the byte-compare
// gate once read wrong without failing.
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { extractDeclaration, renderRegion, unresolvedSiblings } from './inline-regions.mjs'

/** The siblings a one-region workflow is missing, its region carrying `names` from a source `src`. */
function missing(/** @type {string} */ src, /** @type {string[]} */ names, /** @type {string} */ around = '') {
  const actual = renderRegion(src, names)
  const text = `${around}\n// >>> craft-inline lib/s.mjs ${names.join(' ')}\n${actual}\n// <<< craft-inline\n`
  const regions = [{ source: 'lib/s.mjs', names, open: 1, close: 3, actual }]
  return unresolvedSiblings(text, regions, () => src).map(s => s.name)
}

test('a sibling whose name holds a `$` is found when called, and only as a whole identifier', () => {
  const src = (/** @type {string} */ call) => `export function $fmt(x) { return x }\nexport function fmt$(x) { return x }\nexport function show(x) { return ${call} }`
  assert.deepEqual(missing(src('$fmt(x)'), ['show']), ['$fmt'])
  assert.deepEqual(missing(src('fmt$(x)'), ['show']), ['fmt$'])
  assert.deepEqual(missing(src('a$fmt(x)'), ['show']), [], 'a$fmt is another identifier')
  assert.deepEqual(missing(src('fmt$$(x)'), ['show']), [], 'fmt$$ is another identifier')
  assert.deepEqual(missing(src('o.$fmt(x)'), ['show']), [], 'a method of o is not the sibling')
})

test('a `$` sibling the workflow declares itself is not missing, nor one a longer name merely starts with', () => {
  const src = 'export function fmt$(x) { return x }\nexport function show(x) { return fmt$(x) }'
  assert.deepEqual(missing(src, ['show'], 'function fmt$(x) { return String(x) }'), [])
  assert.deepEqual(missing(src, ['show'], 'const fmt$$ = 1'), ['fmt$'])
})

test('a `$` name is extracted by its own name, not by one it is a prefix or suffix of', () => {
  const src = 'export const $a$b = 2\nexport const $a = 1'
  assert.equal(extractDeclaration(src, '$a'), 'const $a = 1')
  assert.equal(extractDeclaration(src, '$a$b'), 'const $a$b = 2')
})

test('a one-line function with a comment after it ends on its own line', () => {
  const src = 'export function f() { return 1 } // note (an aside\n\nexport function g() {\n  return 2\n}\n'
  assert.equal(extractDeclaration(src, 'f'), 'function f() { return 1 } // note (an aside')
  assert.equal(extractDeclaration('export function f() { return { a: 1 } } /* note */\nexport function g() {\n}', 'f'), 'function f() { return { a: 1 } } /* note */')
  // A first line that only opens the body, a comment after it or not, still runs to its column-0 `}`.
  assert.equal(extractDeclaration('export function f() { // note\n  return 1\n}', 'f'), 'function f() { // note\n  return 1\n}')
  assert.equal(extractDeclaration('export function f() { if (a) { b() } // c\n  return 1\n}', 'f'), 'function f() { if (a) { b() } // c\n  return 1\n}')
})

test('a first line whose `}` is followed by code, not a comment, is not a one-line function', () => {
  assert.equal(extractDeclaration('export function f() { return 1 } x\n  y()\n}\n', 'f'), 'function f() { return 1 } x\n  y()\n}')
  assert.throws(() => extractDeclaration('export function f() { return 1 } x', 'f'), /unterminated function 'f'/)
})
