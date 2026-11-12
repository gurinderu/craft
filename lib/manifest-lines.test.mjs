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
  assert.equal(siblingIndex(items, 0, 'newTag'), -1, "the next item's key is not this item's")
  assert.equal(siblingIndex(items, 2, 'newTag'), 3)
  assert.equal(siblingIndex(['x: 1', '  y: 2'], 0, 'y'), -1)
})

/** What `src` reads from `text`, compiled by the validated builder discovery uses. @param {string} src @param {string} text */
const read = (src, text) => {
  const p = versionPattern(src)
  if ('error' in p) throw new Error(p.error)
  return p.re.exec(text)?.[1]
}

test("a pair pattern reads the version of the anchor's own sibling, after it or before it, the lines between counted", () => {
  const text = 'a:\n  repository: x/y\n  tag: v0\nb:\n  repository: x/z\n  pull: Always\n  tag: "v1.2"\nc:\n  tag: v3\n  repository: x/w\n'
  const lines = text.split('\n')
  assert.equal(read(pairPattern(lines, 4, 6, 'tag'), text), 'v1.2')
  assert.equal(read(pairPattern(lines, 9, 8, 'tag'), text), 'v3')
  assert.equal(read(linePattern('image: ghcr.io/a/b:'), 'x:\n  image: ghcr.io/a/b:v9 # c\n'), 'v9')
  assert.equal(escapeRe('a.b*c(d)[e]'), 'a\\.b\\*c\\(d\\)\\[e\\]')
})

test("a pair pattern still reads its pair after lines are added inside the mapping, never a deeper key or another mapping's", () => {
  const before = 'image:\n  repository: ghcr.io/a/app\n  tag: v1.2\nother:\n  tag: v9\n'
  const lines = before.split('\n')
  const src = pairPattern(lines, 1, 2, 'tag')
  assert.ok(src.length <= 200, 'within the versionMatch bound')
  assert.ok(!('error' in versionPattern(src)), 'one capture group, compiles')
  assert.equal(read(src, before), 'v1.2')
  const grown = 'image:\n  repository: ghcr.io/a/app\n  pullPolicy: IfNotPresent\n  # pinned\n\n  extra:\n    tag: deeper\n  tag: v1.3\nother:\n  tag: v9\n'
  assert.equal(read(src, grown), 'v1.3', 'lines added between, a deeper tag passed over')
  const moved = 'image:\n  repository: ghcr.io/a/app\nother:\n  tag: v9\n'
  assert.equal(read(src, moved), undefined, "a tag past the mapping's end is not its sibling")
  const up = 'a:\n  tag: v3\n  pullPolicy: Always\n  repository: x/w\n'
  assert.equal(read(pairPattern('a:\n  tag: v3\n  repository: x/w\n'.split('\n'), 2, 1, 'tag'), up), 'v3', 'the version above its anchor, a line added between')
  const items = '- name: a\n  version: 1.0\n- name: b\n  version: 2.0\n'
  const item = pairPattern(items.split('\n'), 2, 3, 'version')
  assert.equal(read(item, '- name: b\n  repository: r\n  version: 2.1\n'), '2.1')
  assert.equal(read(item, '- name: b\n- name: c\n  version: 3.0\n'), undefined, "the next item's version is not this item's")
})

test('a pair whose bounded pattern would pass the versionMatch bound counts the lines between exactly', () => {
  const text = `image:\n  repository: ghcr.io/${'r'.repeat(80)}\n  tag: v1\n`
  const src = pairPattern(text.split('\n'), 1, 2, 'tag')
  assert.ok(!src.includes('{0,') && src.length <= 200, src)
  assert.equal(read(src, text), 'v1')
})
