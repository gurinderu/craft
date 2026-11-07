// Direct unit tests of lib/lens-scope.mjs's building blocks: the grouping key, the deep split and
// its bounds, the merge choice and its tie-breaks, the per-slice cap, and the UTF-8 / C-quote
// boundaries. lens-scope.test.mjs pins the partition on the measured tree; these pin the edges.
import { test } from 'vitest'
import assert from 'node:assert/strict'
import {
  groupKey, splitDeep, sliceDiff, partitionOwned, pickMerge, closerMerge, commonPrefixLength, mergedKey,
  uniqueKey, utf8Bytes, utf8Text, decodeGitPath,
} from './lens-scope.mjs'

/** @param {string} key @param {number} n */
const group = (key, n) => ({ key, files: Array.from({ length: n }, (_v, i) => `${key}/f${i}.rs`) })
/** @param {import('./lens-scope.mjs').Group[]} gs */
const shape = gs => gs.map(g => [g.key, g.files.length])

test('groupKey: a shallow path keys on its directory, a root file on ".", a deep one on its first segments', () => {
  assert.equal(groupKey('a.rs'), '.')
  assert.equal(groupKey('a/b.rs'), 'a')
  assert.equal(groupKey('a/b/c/d.rs'), 'a/b')
  assert.equal(groupKey('a/b/c.rs', 3), 'a/b')
})

test('splitDeep leaves a group of exactly the cap whole', () => {
  const g = { key: 'm', files: ['m/a/x.rs', 'm/b/y.rs'] }
  assert.deepEqual(splitDeep(g, 2, 3), [g])
})

test('splitDeep still separates at depth 8, and an unseparable group keeps its own key', () => {
  const deep = 'a/b/c/d/e/f/g'
  const g = { key: 'top', files: [`${deep}/x1/f.rs`, `${deep}/x2/f.rs`] }
  assert.deepEqual(shape(splitDeep(g, 1, 8)), [[`${deep}/x1`, 1], [`${deep}/x2`, 1]])
  const same = { key: 'top', files: ['m/src/a/x.rs', 'm/src/a/y.rs'] }
  assert.deepEqual(splitDeep(same, 1, 3), [same])
})

const TREE = [
  'a/x/p/f1.rs', 'a/x/p/f2.rs', 'a/x/p/f3.rs', 'a/x/q/f1.rs', 'a/x/q/f2.rs', 'a/x/q/f3.rs',
  'b/y/f1.rs', 'b/y/f2.rs', 'b/y/f3.rs', 'b/y/f4.rs', 'b/y/f5.rs', 'b/y/f6.rs',
  'c/w/m/f.rs', 'c/w/n/f.rs',
]

test('sliceDiff: the default cap is the even share, an explicit cap replaces it', () => {
  // 14 files over 6 slices: a cap of 3, so the 6-file module splits and the 2-file one does not.
  assert.deepEqual(shape(sliceDiff(TREE)), [['b/y', 6], ['a/x/p', 3], ['a/x/q', 3], ['c/w', 2]])
  assert.deepEqual(shape(sliceDiff(TREE, { maxFilesPerSlice: 6 })), [['a/x', 6], ['b/y', 6], ['c/w', 2]])
})

test('sliceDiff slices at exactly minFiles, not below, and never slices an empty name', () => {
  assert.equal(sliceDiff(TREE, { minFiles: 14 }).length, 4)
  assert.deepEqual(sliceDiff(TREE, { minFiles: 15 }), [])
  const withHoles = sliceDiff([...TREE, '', ''])
  assert.ok(withHoles.every(s => !s.files.includes('')))
})

test('partitionOwned: an owned shared file under the cap rides along, it is not partitioned too', () => {
  /** @param {string} f */
  const owns = f => f.endsWith('.rs') || f === 'Cargo.toml'
  assert.deepEqual(partitionOwned(['a.rs', 'README.md', 'Cargo.toml'], owns), { shared: ['Cargo.toml'], owned: ['a.rs'] })
})

test('pickMerge: among equally small fallbacks the first pair wins', () => {
  const p = pickMerge([group('a', 2), group('b', 2), group('c', 2)], 1)
  assert.deepEqual([p.i, p.j], [0, 1])
})

test('pickMerge: the closest merge that fits exactly at the cap wins over a smaller unrelated one', () => {
  const p = pickMerge([group('x/a', 2), group('x/b', 2), group('y', 1), group('z', 1)], 4)
  assert.deepEqual([p.i, p.j], [0, 1])
})

test('pickMerge: a closer merge over the cap loses to one that fits', () => {
  const p = pickMerge([group('x/a', 3), group('x/b', 3), group('y', 1), group('z', 1)], 4)
  assert.deepEqual([p.i, p.j], [2, 3])
})

test('closerMerge: more shared segments first, then the smaller merge, ties keep the incumbent', () => {
  const best = { shared: 1, size: 4 }
  assert.equal(closerMerge(best, null), true)
  assert.equal(closerMerge({ shared: 2, size: 9 }, best), true)
  assert.equal(closerMerge({ shared: 0, size: 1 }, best), false)
  assert.equal(closerMerge({ shared: 1, size: 3 }, best), true)
  assert.equal(closerMerge({ shared: 1, size: 4 }, best), false)
  assert.equal(closerMerge({ shared: 1, size: 5 }, best), false)
})

test('commonPrefixLength counts whole segments, identical keys included', () => {
  assert.equal(commonPrefixLength('bin/service-a', 'bin/service-admin'), 1)
  assert.equal(commonPrefixLength('a/b', 'a/b'), 2)
  assert.equal(commonPrefixLength('a', 'a/b'), 1)
})

test('mergedKey names the shared ancestor, else both', () => {
  assert.equal(mergedKey('a/b/c', 'a/b/d'), 'a/b')
  assert.equal(mergedKey('a', 'b'), 'a + b')
})

test('uniqueKey numbers a taken key from 2 upward', () => {
  assert.equal(uniqueKey('k', []), 'k')
  assert.equal(uniqueKey('k', [{ key: 'other', files: [] }]), 'k')
  assert.equal(uniqueKey('k', [{ key: 'k', files: [] }]), 'k (2)')
  assert.equal(uniqueKey('k', [{ key: 'k', files: [] }, { key: 'k (2)', files: [] }]), 'k (3)')
})

test('utf8Bytes agrees with TextEncoder at every encoding boundary', () => {
  const enc = new TextEncoder()
  for (const cp of [0x7f, 0x80, 0x7ff, 0x800, 0xd7ff, 0xe000, 0xffff, 0x10000]) {
    const s = String.fromCodePoint(cp)
    assert.deepEqual(utf8Bytes(s), [...enc.encode(s)], cp.toString(16))
  }
  assert.deepEqual(utf8Bytes('\udfff'), [...enc.encode('\udfff')], 'a lone low surrogate is a replacement')
})

test('utf8Text agrees with TextDecoder at every lead-byte boundary', () => {
  const dec = new TextDecoder('utf-8', { ignoreBOM: true })
  for (const bytes of [
    [0x7f], [0x80], [0xc1, 0x80], [0xc2, 0x80], [0xdf, 0xbf], [0xe0, 0xa0, 0x80], [0xef, 0xbf, 0xbf],
    [0xf0, 0x90, 0x80, 0x80], [0xf4, 0x8f, 0xbf, 0xbf], [0xf5, 0x80, 0x80, 0x80],
  ]) assert.equal(utf8Text(bytes), dec.decode(new Uint8Array(bytes)), bytes.map(b => b.toString(16)).join(' '))
})

test('decodeGitPath only unquotes a name quoted at BOTH ends, and reads an absent name as empty', () => {
  assert.equal(decodeGitPath(null), '')
  assert.equal(decodeGitPath('ab"'), 'ab"')
  assert.equal(decodeGitPath('"ab'), '"ab')
  assert.equal(decodeGitPath('"ab"'), 'ab')
})
