// The line-based YAML reading (lib/manifest-lines.mjs, realm @nick/craft, node #435): key lines, siblings in one
// mapping, and patterns that read back exactly the version they were built from.
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { escapeRe, keyLine, linePattern, pairPattern, scalarValue, siblingIndex } from './manifest-lines.mjs'
import { versionPattern } from './external-source-spec.mjs'

test('a plain scalar is read; a template, flow, block, alias or spaced value is none', () => {
  assert.deepEqual(['v1', '"v1"', "'v1' # c", 'v1 # pinned'].map(scalarValue), ['v1', 'v1', 'v1', 'v1'])
  for (const raw of ['{{ .Values.tag }}', '${TAG}', '[a]', '|', '>-', '*ref', '&a v1', '!!str v1', 'a b', '']) assert.equal(scalarValue(raw), '', raw)
})

test('a key line carries its key column past a list dash, its value and the text from the key on', () => {
  assert.deepEqual(keyLine('  - name: nginx  '), { col: 4, dash: true, key: 'name', value: 'nginx', rest: 'name: nginx' })
  assert.deepEqual(keyLine('tag: v1\r'), { col: 0, dash: false, key: 'tag', value: 'v1', rest: 'tag: v1' })
  assert.equal(keyLine('# comment'), null)
  assert.equal(keyLine('- plain item'), null)
})

test('a sibling is found in the same mapping, before or after, deeper lines passed over; another item or a parent ends it', () => {
  const lines = ['image:', '  repository: a/b', '  extra:', '    tag: no', '', '  tag: v1', 'other:', '  tag: v2']
  assert.equal(siblingIndex(lines, 1, 'tag'), 5)
  assert.equal(siblingIndex(lines, 5, 'repository'), 1)
  const items = ['- name: a', '  other: x', '- name: b', '  newTag: v2']
  assert.equal(siblingIndex(items, 0, 'newTag'), -1, 'the next item\'s key is not this item\'s')
  assert.equal(siblingIndex(items, 2, 'newTag'), 3)
  assert.equal(siblingIndex(['x: 1', '  y: 2'], 0, 'y'), -1)
})

/** What `src` reads from `text`, compiled by the validated builder discovery uses. @param {string} src @param {string} text */
const read = (src, text) => {
  const p = versionPattern(src)
  if ('error' in p) throw new Error(p.error)
  return p.re.exec(text)?.[1]
}

test('a pair pattern reads the version of the anchor\'s own sibling, after it or before it, the lines between counted', () => {
  const text = 'a:\n  repository: x/y\n  tag: v0\nb:\n  repository: x/z\n  pull: Always\n  tag: "v1.2"\nc:\n  tag: v3\n  repository: x/w\n'
  const lines = text.split('\n')
  assert.equal(read(pairPattern(lines, 4, 6, 'tag'), text), 'v1.2')
  assert.equal(read(pairPattern(lines, 9, 8, 'tag'), text), 'v3')
  assert.equal(read(linePattern('image: ghcr.io/a/b:'), 'x:\n  image: ghcr.io/a/b:v9 # c\n'), 'v9')
  assert.equal(escapeRe('a.b*c(d)[e]'), 'a\\.b\\*c\\(d\\)\\[e\\]')
})
