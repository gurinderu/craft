// What the memory's bounds keep past their limit, executed directly; the craft CLI's
// `memory/bounds.rs` holds the same behaviour with the same cases.
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { keptRecords, pathEntries, spreadPairs } from './memory-bounds.mjs'
import { parsePriorDecisions, PRIOR_DECISIONS_MAX } from './prior-decisions.mjs'
import { rulePairs, RULE_JUDGE_SENT_MAX } from './project-rule-judge.mjs'

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

const finding = (/** @type {string} */ file, severity = 'Medium') => ({ file, severity, title: `defect in ${file}`, line: 25 })

test('past the judge’s bound each finding gets its best candidate first, the reviewed paths before the rest', () => {
  const a = finding('a.rs', 'Low')
  const b = finding('b.rs')
  const ranked = [0, 1, 2, 3, 4].map(d => ({ f: a, d })).concat([{ f: b, d: 5 }])
  assert.deepEqual(
    spreadPairs(ranked, 6, [], () => 0),
    ranked,
    'under the bound unchanged',
  )
  const out = spreadPairs(ranked, 3, [], () => 0)
  assert.deepEqual(
    out.slice(0, 3).map(p => p.d),
    [0, 1, 5],
  )
  assert.equal(out.length, 6, 'the cut pairs stay, after the sent ones')
  const focused = spreadPairs(ranked, 1, ['b.rs'], () => 0)
  assert.equal(focused[0]?.d, 5, 'a finding on the reviewed paths first')
  const prior = { ...finding('z.rs'), priorIndex: 0 }
  assert.equal(
    spreadPairs([...ranked, { f: prior, d: 9 }], 2, ['b.rs'], () => 0)
      .slice(0, 2)
      .map(p => p.d)
      .join(),
    '5,9',
    'a prior re-adjudicated is in focus',
  )
})

test('the rule judge’s pairs past its bound spread over findings, each finding’s first rule before its second', () => {
  const rule = (/** @type {string} */ id) =>
    /** @type {import('./prior-decision-record.mjs').PriorDecision} */ (
      /** @type {unknown} */ ({ id, kind: 'rule', title: 'clones are fine', scope: '.', reason: 'r', lens: '', links: [] })
    )
  const one = finding('a.rs')
  const others = Array.from({ length: RULE_JUDGE_SENT_MAX }, (_, i) => finding(`o${i}.rs`))
  const rules = [rule('rule-a'), rule('rule-b')]
  const pairs = rulePairs([one, ...others], rules)
  assert.equal(pairs.length, 2 * (RULE_JUDGE_SENT_MAX + 1))
  const sent = pairs.slice(0, RULE_JUDGE_SENT_MAX)
  assert.equal(new Set(sent.map(p => p.f)).size, RULE_JUDGE_SENT_MAX, 'no finding takes two of the bound while another has none')
})

test('a path spelled with ./ or doubled slashes is covered by its directory entry', () => {
  assert.deepEqual(pathEntries(['./a/x.rs', 'a//y.rs', 'b/z.rs'], 2), { entries: ['a/', 'b/'], grouped: 3, cut: 0 })
})
