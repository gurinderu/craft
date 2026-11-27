// What the memory's bounds keep past their limit, executed directly; the craft CLI's
// `memory/bounds.rs` holds the same behaviour with the same cases.
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { keptRecords, pathEntries } from './memory-bounds.mjs'
import { parsePriorDecisions, PRIOR_DECISIONS_MAX } from './prior-decisions.mjs'

test('changed paths past the bound are listed by directory, as deep as still fits, not cut', () => {
  const few = ['src/a.rs', 'src/b.rs']
  assert.deepEqual(pathEntries(few, 60), { entries: few, grouped: 0, cut: 0 })
  const many = [
    ...Array.from({ length: 40 }, (_, i) => `crates/x/src/f${i}.rs`),
    ...Array.from({ length: 25 }, (_, i) => `crates/y/src/g${i}.rs`),
    ...Array.from({ length: 4 }, (_, i) => `crates/z/h${i}.rs`),
    'README.md',
  ]
  assert.deepEqual(pathEntries(many, 60), {
    entries: ['README.md', 'crates/x/src/', 'crates/y/src/', 'crates/z/h0.rs', 'crates/z/h1.rs', 'crates/z/h2.rs', 'crates/z/h3.rs'],
    grouped: 65,
    cut: 0,
  })
  const flat = Array.from({ length: 65 }, (_, i) => `f${String(i).padStart(2, '0')}.rs`)
  const top = pathEntries(flat, 60)
  assert.deepEqual([top.entries.length, top.grouped, top.cut], [60, 0, 5])
})

const record = (/** @type {number} */ i, /** @type {string} */ scope, extra = {}) => ({ id: `decision-${i}`, title: `t${i}`, reason: 'r', scope, ...extra })

test('past the cap the records closest to the reviewed paths are kept', () => {
  const list = [record(0, '.'), record(1, 'other/x.rs'), record(2, 'src'), record(3, 'src/a.rs'), record(4, 'other/y.rs', { date: '2026-11-01' })]
  assert.deepEqual(keptRecords(list, ['src/a.rs'], 5), [true, true, true, true, true], 'under the cap all stay')
  assert.deepEqual(keptRecords(list, ['src/a.rs'], 3), [false, false, true, true, true])
  // Through the parse: 160 records, a delta over three files keeps every record on them.
  const delta = ['a.rs', 'b.rs', 'c.rs']
  const all = [
    ...Array.from({ length: 148 }, (_, i) => record(i, `o${i >> 2}.rs`)),
    ...Array.from({ length: 12 }, (_, i) => record(148 + i, delta[i >> 2] ?? '')),
  ]
  const parsed = parsePriorDecisions(all, undefined, delta)
  assert.equal(parsed.decisions.length, PRIOR_DECISIONS_MAX)
  assert.equal(parsed.decisions.filter(d => delta.includes(d.scope)).length, 12)
  assert.match(String(parsed.refused[0]), /^60 decision\(s\) past the cap of 100 were not applied — kept are the records closest to the reviewed paths/)
})

test('a path spelled with ./ or doubled slashes is covered by its directory entry', () => {
  assert.deepEqual(pathEntries(['./a/x.rs', 'a//y.rs', 'b/z.rs'], 2), { entries: ['a/', 'b/'], grouped: 3, cut: 0 })
})
