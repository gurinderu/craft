// The answer a pi task printed (lib/pi-review-answer.mjs): the last fenced json block, else the last top-level object
// that parses, else none.
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { answerOf } from './pi-review-answer.mjs'

test('the last fenced json block holding an object is the answer', () => {
  const out = 'First:\n```json\n{"a": 1}\n```\nThen, finally:\n```json\n{"a": 2, "s": "}{"}\n```\nDone.'
  assert.deepEqual(answerOf(out), { a: 2, s: '}{' })
})

test('without a usable fence, the last top-level object that parses, braces in prose and strings skipped', () => {
  assert.deepEqual(answerOf('I saw {the diff}. {"x": "a \\" } b", "y": {"z": [1]}} and {broken'), { x: 'a " } b', y: { z: [1] } })
  assert.deepEqual(answerOf('```json\n[1, 2]\n```\n{"k": true}'), { k: true }, 'a fence holding no object falls back')
})

test('no object at all is no answer', () => {
  assert.equal(answerOf('done'), null)
  assert.equal(answerOf('{"unclosed": 1'), null)
})
