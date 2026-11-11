// The answer a pi task printed (lib/pi-review-answer.mjs): the last fenced json block, else the last top-level object
// that parses, else none.
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { answerOf } from './pi-review-answer.mjs'

test('the craft-answer block is the answer, not a schema-shaped example printed after it in a json fence', () => {
  const out = 'Answer:\n```craft-answer\n{"findings": [{"t": "real"}]}\n```\nFor example:\n```json\n{"findings": []}\n```'
  assert.deepEqual(answerOf(out), { findings: [{ t: 'real' }] })
})

test('``` inside a JSON string closes no fence, and an unclosed brace in prose hides nothing after it', () => {
  const out = 'In `fn run() {` I saw:\n```json\n{"a": "x ``` y"}\n```\n'
  assert.deepEqual(answerOf(out), { a: 'x ``` y' })
  assert.deepEqual(answerOf('fn run() { … and then {"k": 1}'), { k: 1 })
})

test('without a craft-answer block, the last json block holding an object is the answer', () => {
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
