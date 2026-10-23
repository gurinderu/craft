// The sift's pure parts (realm @nick/craft, nodes #303, #305): where a gathered location points, which
// findings repeat one another, the ledger rows the sift writes, and what a noise class settles.
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { collapseRepeats, conflictEntry, locationParts, repeatsFinding, setAsideEntry, severityRank, siftByMemory, siftFinding } from './triage-sift.mjs'
import { classifiedVerdict, issueOf, noiseClassOf } from './triage-noise-class.mjs'

/** @param {string} title @param {string} location @param {string} [severity] @param {string} [thread] */
const f = (title, location, severity = 'Medium', thread = '') => siftFinding({ severity, title, location, detail: 'd', proposed_fix: '', thread_id: thread, source: 's' }, `s::${location}::${title}`)

test('locationParts reads path:line, ignores a column or range, and names no file for prose', () => {
  assert.deepEqual(locationParts('src/a.rs:10'), { file: 'src/a.rs', line: 10 })
  assert.deepEqual(locationParts('src/a.rs:10:4'), { file: 'src/a.rs', line: 10 })
  assert.deepEqual(locationParts('src/a.rs:10-12'), { file: 'src/a.rs', line: 10 })
  assert.deepEqual(locationParts('src/a.rs'), { file: 'src/a.rs', line: 0 })
  assert.deepEqual(locationParts('PR-level'), { file: '', line: 0 })
  assert.deepEqual(locationParts('the whole crate'), { file: '', line: 0 })
  assert.deepEqual(locationParts(undefined), { file: '', line: 0 })
})

test('siftFinding keeps the finding, adds its id, site, the detail as why and an empty memory note', () => {
  const s = f('t', 'a/b.js:3')
  assert.deepEqual([s.stable_id, s.file, s.line, s.why, s.memoryNote, s.title], ['s::a/b.js:3::t', 'a/b.js', 3, 'd', '', 't'])
})

test('severityRank orders Critical first and an unknown severity last', () => {
  assert.ok(severityRank('critical') < severityRank('High'))
  assert.ok(severityRank('Info') < severityRank('bogus'))
  assert.equal(severityRank(' Low '), 3)
})

test('repeatsFinding: the same thread, or the same file nearby with the same title words', () => {
  assert.ok(repeatsFinding(f('x', '', 'Low', 'T1'), f('y', '', 'Low', 'T1')))
  assert.ok(repeatsFinding(f('null deref in parse', 'a.rs:10'), f('parse null deref', 'a.rs:13')))
  assert.ok(!repeatsFinding(f('null deref in parse', 'a.rs:10'), f('parse null deref', 'a.rs:14')), 'past the sure window')
  assert.ok(!repeatsFinding(f('null deref in parse', 'a.rs:10'), f('null deref in parse', 'b.rs:10')))
  assert.ok(!repeatsFinding(f('null deref in parse', 'a.rs:10'), f('slow loop in render', 'a.rs:10')))
  assert.ok(repeatsFinding(f('null deref in parse', 'a.rs'), f('parse null deref', 'a.rs:99')), 'a line-less copy compares by title')
  assert.ok(!repeatsFinding(f('x', 'PR-level'), f('x', 'PR-level')), 'no file, no thread: nothing to say they are one')
})

test('collapseRepeats keeps the most severe copy and re-points earlier repeats onto it', () => {
  const a = f('null deref in parse', 'a.rs:10', 'Low')
  const b = f('parse null deref', 'a.rs:11', 'Medium')
  const c = f('null deref parse', 'a.rs:12', 'Critical')
  const d = f('other thing', 'a.rs:12', 'Low')
  const r = collapseRepeats([a, b, c, d, a])
  assert.deepEqual(r.kept.map(x => x.stable_id), [c.stable_id, d.stable_id])
  assert.deepEqual(r.repeated.map(x => [x.f.stable_id, x.of]), [[a.stable_id, c.stable_id], [b.stable_id, c.stable_id]])
  const same = collapseRepeats([b, f('parse null deref', 'a.rs:11', 'Medium')])
  assert.equal(same.kept.length, 1, 'the same id twice is kept once')
})

test('setAsideEntry and conflictEntry: the record mark, the verdict by kind, the conflict for a human', () => {
  const base = { ...f('t', 'a.rs:1'), memoryNote: ' · REJECTED BEFORE: r — bob', priorMatch: 'matched by title' }
  assert.deepEqual(setAsideEntry({ ...base, priorKind: 'decision' }), { stable_id: base.stable_id, verdict: 'reject', sifted: true, reason: 'SIFTED BEFORE VALIDATION — REJECTED BEFORE: r — bob · matched by title' })
  assert.equal(setAsideEntry({ ...base, priorKind: 'question' }).verdict, 'defer')
  assert.equal(setAsideEntry({ ...base, priorKind: 'rule' }).verdict, 'reject')
  const c = conflictEntry({ ...base, memoryContradicts: { id: 'd1', kind: 'rule', why: 'w' } })
  assert.equal(c.verdict, 'conflict')
  assert.match(c.reason, /goes against rule d1 in project memory \(w\); a human decides/)
})

test('siftByMemory with no records sends everything to the validator and asks no agent', async () => {
  const fail = () => Promise.reject(new Error('no agent expected'))
  const r = await siftByMemory([f('t', 'a.rs:1')], [], fail, fail, fail)
  assert.equal(r.toValidate.length, 1)
  assert.deepEqual(r.ledger, [])
  assert.deepEqual(r.counts, { rejectedBefore: 0, deferred: 0, covered: 0, conflict: 0, reraised: 0 })
})

test('noiseClassOf reads 1..6 and nothing else', () => {
  assert.equal(noiseClassOf({ noise_class: 3 }), 3)
  for (const v of [{ noise_class: 0 }, { noise_class: 7 }, { noise_class: 1.5 }, { noise_class: 'x' }, {}, null]) assert.equal(noiseClassOf(v), 0)
})

test('classifiedVerdict: class 1 defers with an issue only when the base was opened; class 5 needs a decision', () => {
  const v = { stable_id: 'i', verdict: 'reject', reason: 'r', premise_checked: 'git show b:x' }
  assert.deepEqual(classifiedVerdict({ ...v, noise_class: 1 }), { ...v, noise_class: 1, verdict: 'defer', action: 'issue' })
  const unchecked = classifiedVerdict({ ...v, premise_checked: ' ', noise_class: 1 })
  assert.equal(unchecked.verdict, 'needs-decision')
  assert.match(unchecked.reason, /nothing at the base was opened to show it — r$/)
  assert.equal(classifiedVerdict({ ...v, noise_class: 5 }).verdict, 'needs-decision')
  for (const n of [0, 2, 3, 4, 6]) assert.deepEqual(classifiedVerdict({ ...v, noise_class: n }), { ...v, noise_class: n })
})

test('issueOf titles the issue by the finding and says where it was checked', () => {
  const i = issueOf({ severity: 'High', title: 'T', location: '', detail: 'D', source: 'github-pr', stable_id: 'id' }, { reason: 'at main', premise_checked: 'git show m:a' })
  assert.equal(i.title, 'T')
  assert.equal(i.stable_id, 'id')
  assert.equal(i.body, 'High · no location · from github-pr\n\nD\n\nNot introduced by the PR it was raised on: at main (checked at git show m:a)')
})
