import { test } from 'vitest'
import assert from 'node:assert/strict'
import { pathSegments } from './path-segments.mjs'

test('pathSegments: separators of either kind, repeated or trailing, and `.` vanish', () => {
  assert.deepEqual(pathSegments('/r/./crates//core/'), ['r', 'crates', 'core'])
  assert.deepEqual(pathSegments('C:\\r\\crates\\core'), ['C:', 'r', 'crates', 'core'])
  assert.deepEqual(pathSegments(''), [])
  assert.deepEqual(pathSegments('/'), [])
})

test('pathSegments: an interior `..` pops, and absolute and relative spellings agree', () => {
  assert.deepEqual(pathSegments('/r/crates/legacy/../core'), ['r', 'crates', 'core'])
  assert.deepEqual(pathSegments('r/crates/legacy/../core'), ['r', 'crates', 'core'])
})

test('pathSegments: a `..` with nothing left to pop is kept as a literal segment', () => {
  // Callers rely on this: a path that climbs out stays visibly out (`..` first), never silently in.
  assert.deepEqual(pathSegments('../elsewhere'), ['..', 'elsewhere'])
  assert.deepEqual(pathSegments('a/../../b'), ['..', 'b'])
  assert.deepEqual(pathSegments('../../x'), ['..', '..', 'x'])
})

test('pathSegments: whatever it is given is read as a string', () => {
  assert.deepEqual(pathSegments(undefined), ['undefined'])
  assert.deepEqual(pathSegments(42), ['42'])
})
