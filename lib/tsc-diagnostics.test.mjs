import { test } from 'vitest'
import assert from 'node:assert/strict'
import path from 'node:path'
import { compileProblems, realOrResolved } from './tsc-diagnostics.mjs'

// A wrapped engine whose wrapper adds 3 lines above its 120.
const WRAPPED = path.resolve('/nonexistent-craft/x.mjs')
const byReal = new Map([[WRAPPED, { file: 'workflows/x.js', offset: 3, lines: 120 }]])
const err = (/** @type {number} */ line, msg = 'error TS2322: bad') => `${WRAPPED}(${line},7): ${msg}`

test('an error inside an engine\'s own lines is placed at its line and column of workflows/<file>.js', () => {
  assert.deepEqual(compileProblems({ status: 2, text: err(4) }, byReal, []), ['workflows/x.js:1:7 error TS2322: bad'])
  assert.deepEqual(compileProblems({ status: 2, text: err(13) }, byReal, []), ['workflows/x.js:10:7 error TS2322: bad'])
  assert.match(compileProblems({ status: 2, text: err(123) }, byReal, [])[0] ?? '', /^workflows\/x\.js:120:7 /)
})

test('an error in the lines the wrapper adds is the engine\'s, never placed on a line of it', () => {
  for (const line of [3, 124]) {
    const [p] = compileProblems({ status: 2, text: err(line) }, byReal, [])
    assert.ok(p?.startsWith('workflows/x.js ') && p.endsWith('error TS2322: bad'), p)
  }
})

test('an error elsewhere is reported as tsc printed it, trimmed; its indented elaboration travels with it', () => {
  const other = `  ${path.resolve('/elsewhere/y.mjs')}(1,1): error TS1: no  `
  assert.deepEqual(compileProblems({ status: 2, text: other }, byReal, []), [other.trim()])
  assert.deepEqual(compileProblems({ status: 2, text: 'error TS5083: Cannot read file' }, byReal, []), ['error TS5083: Cannot read file'])
  const text = [err(5), '  Types of property a', '    are incompatible.', err(6, 'error TS2345: also'), 'Found 2 errors.'].join('\n')
  assert.deepEqual(compileProblems({ status: 2, text }, byReal, []), [
    'workflows/x.js:2:7 error TS2322: bad\n  Types of property a\n  are incompatible.',
    'workflows/x.js:3:7 error TS2345: also',
  ])
  // An elaboration only follows an error; a blank line ends it; output may end on one.
  assert.deepEqual(compileProblems({ status: 2, text: `${err(5)}\n\n  stray` }, byReal, []), ['workflows/x.js:2:7 error TS2322: bad'])
  assert.deepEqual(compileProblems({ status: 2, text: `${err(5)}\n  last` }, byReal, []), ['workflows/x.js:2:7 error TS2322: bad\n  last'])
})

test('only an `error TS<n>` token counts, at the start of a line or after a space', () => {
  for (const text of ['Xerror TS2322: glued', 'error TS: no code', 'warning TS2322: not one']) {
    assert.deepEqual(compileProblems({ status: 0, text }, byReal, []), [], text)
  }
  assert.equal(compileProblems({ status: 0, text: 'x error TS7: spaced' }, byReal, []).length, 1)
})

test('a compile that exited non-zero with nothing to report fails closed; a clean exit adds nothing', () => {
  assert.deepEqual(compileProblems({ status: 0, text: '' }, byReal, []), [])
  assert.deepEqual(compileProblems({ status: 0, text: '' }, byReal, ['earlier']), ['earlier'])
  assert.deepEqual(compileProblems({ status: 1, text: 'tsc: out of memory' }, byReal, ['earlier']), ['earlier'])
  const [failed] = compileProblems({ status: 1, text: '  a\nb\nc\nd  ' }, byReal, [])
  assert.ok(failed?.includes('1') && failed.includes('a | b | c') && !failed.includes('| d'), failed)
  const [silent] = compileProblems({ status: 3, text: ' \n ' }, byReal, [])
  assert.ok(silent?.includes('3') && silent.includes('no output'), silent)
})

test('a path that cannot be resolved to a real file is resolved as written', () => {
  assert.equal(realOrResolved('/nonexistent-craft/../nonexistent-craft/x.mjs'), WRAPPED)
  assert.equal(realOrResolved(path.dirname(new URL(import.meta.url).pathname)), path.dirname(new URL(import.meta.url).pathname))
})
