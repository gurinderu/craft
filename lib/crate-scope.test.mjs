// lib/crate-scope.mjs: which crate owns a file, the crate partition, the question tally and the seam
// pass's dispositions.
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { crateRootOf, crateOf, touchedCrates, sliceByCrate, crateSliceKey, questionTally } from './crate-scope.mjs'
import { applyDispositions } from './crate-seam.mjs'

const ROOTS = ['crates/a', 'crates/ab', './crates/a/sub/', '.']

test('crateRootOf spells a root as git does', () => {
  assert.equal(crateRootOf('./crates/a/'), 'crates/a')
  assert.equal(crateRootOf('.'), '.')
  assert.equal(crateRootOf(''), '.')
})

test('crateOf picks the nearest root by whole segments', () => {
  assert.equal(crateOf('crates/a/src/lib.rs', ROOTS), 'crates/a')
  assert.equal(crateOf('crates/ab/src/lib.rs', ROOTS), 'crates/ab')
  assert.equal(crateOf('crates/a/sub/src/x.rs', ROOTS), 'crates/a/sub')
  assert.equal(crateOf('tools/x.rs', ROOTS), '.')
  assert.equal(crateOf('tools/x.rs', ['crates/a']), '')
  assert.equal(crateOf('crates/a', ['crates/a']), '', 'a root is not inside itself')
})

test('touchedCrates lists each owning crate once, manifests included', () => {
  assert.deepEqual(touchedCrates(['crates/a/Cargo.toml', 'crates/a/src/x.rs', 'crates/ab/src/y.rs', 'docs/z.md'], ['crates/a', 'crates/ab']), ['crates/a', 'crates/ab'])
  assert.deepEqual(touchedCrates('nope', null), [])
})

/** @param {string} dir @param {number} n */
const files = (dir, n) => Array.from({ length: n }, (_v, i) => `${dir}/src/f${i}.rs`)

test('sliceByCrate gives each crate its own slice and never merges crates', () => {
  const all = [...files('crates/a', 4), ...files('crates/b', 4), ...files('crates/c', 4), 'Cargo.lock']
  const slices = sliceByCrate(all, ['crates/a', 'crates/b', 'crates/c'])
  assert.deepEqual(slices.map(s => [s.key, s.crate, s.files.length]), [
    ['crate:crates/a', 'crates/a', 5], ['crate:crates/b', 'crates/b', 5], ['crate:crates/c', 'crates/c', 5],
  ])
  for (const s of slices) assert.ok(s.files.includes('Cargo.lock'), 'shared files ride on every slice')
})

test('sliceByCrate splits an oversized crate by module and keeps files outside crates', () => {
  const big = [...Array.from({ length: 6 }, (_v, i) => `crates/a/src/m1/f${i}.rs`), ...Array.from({ length: 6 }, (_v, i) => `crates/a/src/m2/f${i}.rs`)]
  const slices = sliceByCrate([...big, 'tools/gen/x.rs', 'tools/gen/y.rs'], ['crates/a'])
  const crateSlices = slices.filter(s => s.crate)
  assert.ok(crateSlices.length >= 2, 'a crate above the cap splits')
  assert.ok(crateSlices.every(s => s.crate === 'crates/a' && s.key.startsWith('crate:crates/a//')), 'a module slice keeps its crate root readable in its key')
  const loose = slices.filter(s => !s.crate)
  assert.deepEqual(loose.flatMap(s => s.files).sort(), ['tools/gen/x.rs', 'tools/gen/y.rs'])
  const covered = new Set(slices.flatMap(s => s.files))
  for (const f of [...big, 'tools/gen/x.rs']) assert.ok(covered.has(f), `${f} reaches a slice`)
})

test('sliceByCrate does not slice a small diff or a single slice', () => {
  assert.deepEqual(sliceByCrate(files('crates/a', 3), ['crates/a']), [])
  assert.deepEqual(sliceByCrate(files('crates/a', 12), ['crates/a'], { maxSlices: 1 }), [])
})

test('questionTally counts blocking, deferred, answered and timed out', () => {
  const q = (/** @type {boolean} */ blocking, /** @type {boolean} */ answered, answer = '') => ({ blocking, answered, answer })
  assert.deepEqual(questionTally([q(true, true), q(true, false), q(true, false, 'NO-COORDINATOR'), q(false, false), null]),
    { blocking: 3, deferred: 1, answered: 1, timedOut: 1, noCoordinator: 1 }, 'a question asked after the coordinator left is not a timeout')
  assert.deepEqual(questionTally(undefined), { blocking: 0, deferred: 0, answered: 0, timedOut: 0, noCoordinator: 0 })
})

test('crateSliceKey names the crate root, and the module below it after //', () => {
  assert.equal(crateSliceKey('crates/a', 'crates/a'), 'crate:crates/a')
  assert.equal(crateSliceKey('crates/a', 'crates/a/src/m1'), 'crate:crates/a//src/m1')
  assert.equal(crateSliceKey('.', 'src'), 'crate:.//src')
})

test('applyDispositions matches a finding by lens, file and title — never by title alone', () => {
  const pool = [
    { title: 'A leaks', file: 'crates/a/src/x.rs', source: 'safety' },
    { title: 'A leaks', file: 'crates/b/src/y.rs', source: 'safety' },
    { title: 'A leaks', file: 'crates/a/src/x.rs', source: 'errors' },
    { title: 'B races', file: 'crates/a/src/z.rs', source: 'concurrency' },
    { title: 'C panics', file: 'crates/a/src/w.rs', source: 'errors' },
  ]
  const open = [
    { lens: 'safety', findingFile: 'crates/a/src/x.rs', findingTitle: 'A leaks' },
    { lens: 'concurrency', findingFile: 'crates/a/src/z.rs', findingTitle: 'B races' },
  ]
  const { kept, counts, setAside } = applyDispositions(pool, [
    { lens: 'safety', findingFile: 'crates/a/src/x.rs', findingTitle: 'a LEAKS ', action: 'drop', why: 'it is closed upstream' },
    { lens: 'concurrency', findingFile: 'crates/a/src/z.rs', findingTitle: 'B races', action: 'confirm' },
    { lens: 'errors', findingFile: 'crates/a/src/w.rs', findingTitle: 'C panics', action: 'drop' },
    { lens: 'concurrency', findingFile: 'crates/a/src/z.rs', findingTitle: 'B races', action: 'bogus' },
  ], open)
  assert.deepEqual(kept.map(f => `${f.source}:${f.file}:${f.title}`), [
    'safety:crates/b/src/y.rs:A leaks', 'errors:crates/a/src/x.rs:A leaks', 'concurrency:crates/a/src/z.rs:B races', 'errors:crates/a/src/w.rs:C panics',
  ], 'only the named finding goes: the same title in another file or from another lens stays, and C was named by no question')
  assert.deepEqual(counts, { confirm: 1, drop: 1, convert: 0 })
  assert.deepEqual(setAside, [{ action: 'drop', lens: 'safety', title: 'A leaks', file: 'crates/a/src/x.rs', line: 0, severity: '', why: 'it is closed upstream' }],
    'what the seam pass took out of the pool is kept, with its why')
})
