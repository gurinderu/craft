// A passed copy overrides only when it is newer than everything that opposes it: the store's inactive
// copy of it AND any active recalled record that supersedes or answers it (realm @nick/craft, node
// #229). Newer than both → applied, the successor's link to it dropped for this run; not newer than the
// successor → held back and named "held by <id> (active, <date>)". The memory line and the refusals
// never disagree. Dates: a timestamp without a zone is UTC; a bare date against a timestamp compares by
// the timestamp's UTC day; a day the calendar lacks is malformed.
import { test, afterEach } from 'vitest'
import assert from 'node:assert/strict'
import { mergeAndRead, mergeRecall, readMemoryRecall, notLaterWhy } from './memory-recall.mjs'
import { parsePriorDecisions } from './prior-decisions.mjs'
import { applyPriorDecisions } from './prior-decision-apply.mjs'

const A = { id: 'decision-aaaaaaaaaa', kind: 'decision', title: 'unwrap in parser may panic', body: 'the fresh word', scope: 'src/parse.rs', author: 'bob', commit: 'abc1234', links: [] }
const B = { id: 'decision-bbbbbbbbbb', kind: 'decision', title: 'unwrap in parser is now checked', body: 'the successor', scope: 'src/parse.rs', status: 'active', author: 'alice', commit: 'abc1234', links: ['supersedes: decision-aaaaaaaaaa'] }
const MEM = /** @type {const} */ ({ source: 'recalled', count: 1, why: 'mcp (w)' })

/** @param {string} bDate @param {string} [inactiveDate] no inactive entry when absent */
const recall = (bDate, inactiveDate) => readMemoryRecall({
  backend: 'mcp', why: 'w', decisions: [{ ...B, date: bDate }],
  inactive: inactiveDate ? [{ id: A.id, kind: 'decision', title: A.title, scope: A.scope, status: 'superseded', date: inactiveDate }] : [],
}, 0)
const scopes = async () => ({ unchanged: [], missing: [], reason: '' })

for (const inactiveDate of ['2026-10-01', undefined]) {
  test(`newer than the successor${inactiveDate ? ' and the inactive copy' : ''}: applied, the successor's link to it does not drop it`, async () => {
    const r = mergeRecall({ ...recall('2026-10-03', inactiveDate), memory: MEM }, [{ ...A, date: '2026-10-05' }], parsePriorDecisions)
    assert.deepEqual(r.prior.decisions.map(d => d.id).sort(), [A.id, B.id])
    assert.deepEqual(r.prior.refused, [])
    assert.match(r.memory.why, new RegExp(`passed decision #0 \\(${A.id}\\) applied over .*${B.id} \\(active, 2026-10-03\\): newer`))
    const applied = await applyPriorDecisions({ confirmed: [] }, r.prior.decisions, scopes)
    assert.doesNotMatch(applied.notes.join('\n'), /superseded by another given record/)
  })

  test(`not newer than the successor${inactiveDate ? ' (though newer than the inactive copy)' : ''}: held back, named by the successor`, () => {
    const r = mergeRecall({ ...recall('2026-10-06', inactiveDate), memory: MEM }, [{ ...A, date: '2026-10-05' }], parsePriorDecisions)
    assert.deepEqual(r.prior.decisions.map(d => d.id), [B.id])
    assert.equal(r.prior.refused.length, 1)
    assert.match(String(r.prior.refused[0]), new RegExp(`^passed decision #0 \\(${A.id}\\) not applied: held by ${B.id} \\(active, 2026-10-06\\) \\(the passed record's date 2026-10-05 is not later than the active record's 2026-10-06\\)$`))
    assert.doesNotMatch(r.memory.why, /applied over/)
  })
}

test('an undated passed copy against an active successor is held back by it, named', () => {
  const r = mergeAndRead(recall('2026-10-03').decisions, [A], parsePriorDecisions, [])
  assert.deepEqual(r.parts, { recalled: 1, passed: 0 })
  assert.match(String(r.blocked[0]), new RegExp(`held by ${B.id} \\(active, 2026-10-03\\) \\(the passed record carries no ISO date`))
})

test('the forwarded list carries the successor without its link to the overriding copy, its other links kept', () => {
  const other = { ...B, links: ['supersedes: decision-aaaaaaaaaa', 'supersedes: decision-cccccccccc', 'https://x/pr/1'], date: '2026-10-03' }
  const r = mergeAndRead([other], [{ ...A, date: '2026-10-05' }], parsePriorDecisions, [])
  assert.deepEqual(/** @type {any} */ (r.merged[0]).links, ['supersedes: decision-cccccccccc', 'https://x/pr/1'])
  assert.deepEqual(r.parts, { recalled: 1, passed: 1 })
})

const TZ = process.env['TZ']
afterEach(() => { if (TZ === undefined) delete process.env['TZ']; else process.env['TZ'] = TZ })

test('dates: a timestamp without a zone is UTC, whatever the local zone', () => {
  process.env['TZ'] = 'Asia/Tokyo'
  const e = { status: 'withdrawn', date: '2026-10-01T08:00:00Z' }
  assert.equal(notLaterWhy('2026-10-01T12:00:00', e), '')
  assert.match(notLaterWhy('2026-10-01T07:00', e), /is not later/)
})

test('dates: a bare date against a timestamp compares by the timestamp\'s UTC day', () => {
  assert.match(notLaterWhy('2026-10-02T01:00:00+05:00', { status: 'withdrawn', date: '2026-10-01' }), /is not later/)
  assert.match(notLaterWhy('2026-10-01', { status: 'withdrawn', date: '2026-09-30T22:00:00-05:00' }), /is not later/)
  assert.equal(notLaterWhy('2026-10-02', { status: 'withdrawn', date: '2026-09-30T22:00:00-05:00' }), '')
  for (const [stamp, day] of [['2026-01-01T01:00+05:00', '2025-12-31'], ['2026-12-31T23:00-05:00', '2027-01-01'], ['2024-03-01T01:00+02:00', '2024-02-29'], ['2026-10-31T23:30-01:00', '2026-11-01']]) {
    assert.match(notLaterWhy(String(day), { status: 'withdrawn', date: String(stamp) }), /is not later/, `${stamp} is ${day} in UTC`)
    assert.equal(notLaterWhy(String(day), { status: 'withdrawn', date: `${String(stamp).slice(0, 10)}T12:00Z` }) === '', String(day) > String(stamp).slice(0, 10), String(stamp))
  }
  assert.equal(notLaterWhy('2026-10-01T00:30+01:00', { status: 'withdrawn', date: '2026-09-30T23:00Z' }), '', 'across midnight UTC: 23:30Z is after 23:00Z')
})

test('dates: a day the calendar lacks is malformed on either side', () => {
  assert.match(notLaterWhy('2026-02-30', { status: 'withdrawn', date: '2026-01-01' }), /the passed record carries no ISO date/)
  assert.match(notLaterWhy('2026-03-01', { status: 'withdrawn', date: '2026-02-29T10:00:00Z' }), /the withdrawn record carries no ISO date/)
  assert.equal(notLaterWhy('2024-03-01', { status: 'withdrawn', date: '2024-02-29' }), '')
  for (const bad of ['1900-02-29', '2026-04-31', '2026-00-10', '2026-10-01T24:10Z', '2026-10-01T10:60Z', '2026-10-01T10:00+24:00']) {
    assert.match(notLaterWhy(bad, { status: 'withdrawn', date: '2026-01-01' }), /the passed record carries no ISO date/, bad)
  }
})
