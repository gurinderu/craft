// The review's content layer (lib/content.mjs): `{{name}}` templates and `$ref` schemas, nothing more.
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { contentText, render, resolveRefs } from './content.mjs'

test("a content file's final newline is not part of its text", () => {
  assert.equal(contentText('a\n'), 'a')
  assert.equal(contentText('a\n\n'), 'a\n')
  assert.equal(contentText('a'), 'a')
})

test('render fills every placeholder in one pass and never renders a value', () => {
  assert.equal(render('{{a}} and {{b}}{{a}}\n', { a: 'x', b: '{{a}} $& $1' }), 'x and {{a}} $& $1x')
  assert.equal(render('no {placeholder} here {{ a }}\n'), 'no {placeholder} here {{ a }}')
})

test('render refuses a placeholder it has no value for, rather than ship the braces', () => {
  assert.throws(() => render('{{missing}}', { other: '' }), /\{\{missing\}\} has no value/)
  assert.throws(() => render('{{toString}}'), /has no value/, 'an inherited name is not a value')
})

test('resolveRefs inlines each referenced schema, nested references included', () => {
  const refs = { 'a.json': { type: 'object', properties: { b: { $ref: 'b.json' } } }, 'b.json': { type: 'string' } }
  assert.deepEqual(resolveRefs({ items: [{ $ref: 'a.json' }], n: null, k: 1 }, refs), {
    items: [{ type: 'object', properties: { b: { type: 'string' } } }],
    n: null,
    k: 1,
  })
  assert.throws(() => resolveRefs({ $ref: 'c.json' }, refs), /c\.json is not known/)
})
