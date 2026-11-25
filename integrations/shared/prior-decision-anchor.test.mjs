// A record anchored by its date when it names no commit (realm @nick/craft, node #676): the date read,
// the scope-check answer read, and the split it drives; the scope-check line against a repository is
// integrations/shared/prior-decision-anchor-repo.test.mjs.
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { parsePriorDecisions } from './prior-decisions.mjs'
import { anchorMissingReason, anchorSince, decisionDate, hasAnchor } from './prior-decision-anchor.mjs'
import { applyPriorDecisions, recordsDeferral, reraiseReason } from './prior-decision-apply.mjs'
import { candidatesToCheck, decisionsToCheck, readScopeCheck, runScopeCheck } from './prior-decision-scope.mjs'

const record = (/** @type {Record<string, unknown>} */ over = {}) => ({
  id: 'decision-d1d1d1d1d1',
  title: 'clone in the hot loop',
  scope: 'src/a.rs',
  reason: 'measured cold',
  who: 'nick',
  when: '2026-05-02',
  ...over,
})
const parsed = (/** @type {Array<Record<string, unknown>>} */ ...over) => /** @type {any[]} */ (parsePriorDecisions(over.map(o => record(o))).decisions)
const finding = (over = {}) => ({ file: 'src/a.rs', title: 'clone in the hot loop', severity: 'Medium', why: 'w', ...over })

test('date: the UTC day `when` names, a real calendar day not run on by another digit', () => {
  /** @type {Array<[string, string]>} */
  const cases = [
    ['2026-05-01', '2026-05-01'],
    ['2026-05-01T10:00:00Z', '2026-05-01'],
    ['2026-05-01T10:00:00', '2026-05-01'],
    // A zone moves the moment to its UTC day, either way.
    ['2026-05-01T23:30:00-02:00', '2026-05-02'],
    ['2026-05-02T01:00:00+05:00', '2026-05-01'],
    ['2026-12-31T23:00:00-01:30', '2027-01-01'],
    ['2026-05-01T25:00:00Z', ''],
    ['2026-05-01T10:00:00+25:00', ''],
    ['2026-05-01T10:00:00Z by nick', ''],
    ['2026-05-01 by nick', '2026-05-01'],
    ['2024-02-29', '2024-02-29'],
    ['2000-02-29', '2000-02-29'],
    ['1900-02-29', ''],
    ['2026-02-29', ''],
    ['2026-00-10', ''],
    ['2026-13-01', ''],
    ['2026-05-00', ''],
    ['2026-05-011', ''],
    ['2026/05/01', ''],
    ['2026-05/01', ''],
    ['+026-05-01', ''],
    ['2026-5-011x', ''],
    ['26-05-01', ''],
    ['June 2026', ''],
    ['', ''],
  ]
  for (const [when, day] of cases) assert.equal(decisionDate(/** @type {any} */ ({ when })), day, when)
  const last = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
  last.forEach((days, i) => {
    const m = String(i + 1).padStart(2, '0')
    assert.equal(decisionDate(/** @type {any} */ ({ when: `2026-${m}-${days}` })), `2026-${m}-${days}`)
    assert.equal(decisionDate(/** @type {any} */ ({ when: `2026-${m}-${days + 1}` })), '', `2026-${m}-${days + 1}`)
  })
})

test('anchor: the commit before the date, the date when there is no commit, and neither is no anchor', () => {
  const [both, dated, vague, undated] = parsed({ commit: 'abc1234' }, { id: 'd2' }, { id: 'd3', when: 'early May' }, { id: 'd4', commit: 'abc1234', when: '' })
  assert.deepEqual([hasAnchor(both), hasAnchor(dated), hasAnchor(vague), hasAnchor(undated)], [true, true, false, true])
  assert.equal(anchorSince(both), 'abc1234')
  assert.equal(anchorSince(dated), 'the decision date 2026-05-02')
  assert.equal(anchorMissingReason(both), 'commit abc1234 not found in this repo — raised normally')
  assert.equal(anchorMissingReason(dated), 'no commit in this repo before the decision date 2026-05-02 — raised normally')
  assert.equal(anchorMissingReason(dated, 'missing'), anchorMissingReason(dated))
  assert.equal(anchorMissingReason(both, 'no-trunk'), anchorMissingReason(both))
  assert.equal(anchorMissingReason(dated, 'future'), 'the decision date 2026-05-02 is in the future, so no commit precedes it — raised normally')
  assert.equal(
    anchorMissingReason(dated, 'no-trunk'),
    'the trunk this change forks from could not be resolved (no origin/HEAD, or no merge-base of it with HEAD), so nothing anchors the decision date 2026-05-02 — raised normally',
  )
  assert.equal(anchorMissingReason(dated, 'unreadable'), "git could not list the trunk's commits before the decision date 2026-05-02 — raised normally")
  assert.equal(anchorSince(parsed({ when: '2026-05-01T23:30:00-02:00' })[0]), 'the decision date 2026-05-02')
  const f = finding()
  assert.equal(reraiseReason(f, dated, new Set([dated.id])), '')
  assert.equal(reraiseReason(f, dated, new Set()), 'the code in src/a.rs changed since the decision date 2026-05-02 (or that could not be checked)')
  assert.equal(reraiseReason(f, dated, new Set(), new Map([[dated.id, 'missing']])), anchorMissingReason(dated))
  assert.equal(reraiseReason(f, dated, new Set([dated.id]), new Map([[dated.id, 'future']])), anchorMissingReason(dated, 'future'))
  assert.equal(reraiseReason(f, vague, new Set([vague.id])), 'the decision records no commit and no date, so an unchanged scope cannot be established')
  assert.equal(reraiseReason(finding({ severity: 'Critical' }), dated, new Set([dated.id])), 'a Critical finding is never set aside by a prior decision')
})

test('check list: a dated record is checked, one with neither a commit nor a date is not', () => {
  const ds = parsed({}, { id: 'd2', when: 'early May' })
  assert.deepEqual(
    decisionsToCheck([finding()], ds).map(d => d.id),
    ['decision-d1d1d1d1d1'],
  )
  assert.deepEqual(decisionsToCheck([finding()], ds.slice(1)), [])
  assert.deepEqual(candidatesToCheck([finding()], ds.slice(1)), [])
  assert.deepEqual(
    candidatesToCheck([finding()], ds).map(d => d.id),
    ['decision-d1d1d1d1d1'],
  )
})

test('deferral: a question records one with a date in place of a commit, not with neither', () => {
  const q = (/** @type {Record<string, unknown>} */ over) => ({ kind: 'question', deferred: true, ...over })
  const [dated, vague] = parsed(q({ id: 'question-1' }), q({ id: 'question-2', when: '' }))
  assert.equal(recordsDeferral(dated), true)
  assert.equal(recordsDeferral(vague), false)
})

test('apply: a dated record sets aside when unchanged, raises and names its date when no commit precedes it', async () => {
  const [d, vague] = parsed({}, { id: 'd2', scope: 'src/b.rs', title: 'sleep in the retry', when: 'soon' })
  const f = finding()
  const g = finding({ file: 'src/b.rs', title: 'sleep in the retry' })
  const aside = await applyPriorDecisions({ confirmed: [f, g] }, [d, vague], async () => ({ unchanged: [d.id, 'd2'], missing: [], reason: '' }))
  assert.equal(aside.setAside.length, 1)
  assert.equal(aside.setAside[0]?.priorDecision, d.id)
  assert.match(String(aside.tiers['confirmed']?.[0]?.why), /records no commit and no date/)
  const missing = await applyPriorDecisions({ confirmed: [f] }, [d], async () => ({ unchanged: [], missing: [d.id], reason: '' }))
  assert.equal(missing.setAside.length, 0)
  assert.deepEqual(missing.refused, [`decision ${d.id}: no commit in this repo before the decision date 2026-05-02 — raised normally`])
  const qs = parsed({ id: 'question-9', kind: 'question', deferred: true, when: '' })
  const noted = await applyPriorDecisions({ confirmed: [f] }, qs, async () => ({ unchanged: ['question-9'], missing: [], reason: '' }))
  assert.match(noted.refused.join('\n'), /question question-9: records a deferral but no commit and no date/)
})

test('scope answer: an unusable anchor is read with its word, a word outside the list or a commit record is not', async () => {
  const ans = {
    unchanged: [],
    missing: ['c'],
    unusable: [
      { id: 'a', word: 'future' },
      { id: 'b', word: 'later' },
      { id: 7, word: 'no-trunk' },
      { id: 'k', word: 'no-trunk' },
    ],
    reason: '',
  }
  assert.deepEqual(readScopeCheck(ans)?.unusable, [
    { id: 'a', word: 'future' },
    { id: 'k', word: 'no-trunk' },
  ])
  assert.deepEqual(readScopeCheck({ unchanged: [], missing: [], unusable: 'x', reason: '' })?.unusable, [])
  const ds = parsed({ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'k', commit: 'abc1234' })
  const notes = /** @type {string[]} */ ([])
  const { missing } = await runScopeCheck(ds, async () => ans, notes)
  assert.deepEqual(
    [...missing],
    [
      ['a', 'future'],
      ['c', 'missing'],
    ],
  )
})

test('apply: a date in the future or with no trunk raises its finding and names why', async () => {
  const [d] = parsed({ when: '2099-01-01' })
  const answer = async () => ({ unchanged: [d.id], missing: [], unusable: [{ id: d.id, word: 'future' }], reason: '' })
  const r = await applyPriorDecisions({ confirmed: [finding()] }, [d], answer)
  assert.equal(r.setAside.length, 0)
  assert.deepEqual(r.refused, [`decision ${d.id}: the decision date 2099-01-01 is in the future, so no commit precedes it — raised normally`])
  assert.match(String(r.tiers['confirmed']?.[0]?.why), /raised again: the decision date 2099-01-01 is in the future/)
})
