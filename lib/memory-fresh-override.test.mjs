// A passed record newer than the store's withdrawn or superseded copy of it overrides the block; an
// older, same-day or undated one stays blocked, named with why (realm @nick/craft, node #229). A passed
// copy an ACTIVE recalled record already holds is a duplicate, never checked against `inactive`. A link
// naming a question by the store's own id still releases it once the engine set the skill's id (realm
// @nick/craft, node #215).
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { mergeAndRead, mergeRecall, readMemoryRecall } from './memory-recall.mjs'
import { parsePriorDecisions } from './prior-decisions.mjs'
import { applyPriorDecisions, deferralReleased } from './prior-decision-apply.mjs'
import { deferralOf } from './ledger-deferral.mjs'

const PASSED = { id: 'p-1', kind: 'decision', title: 'unwrap in parser may panic', body: 'a reason from a PR thread', scope: 'src/parse.rs', author: 'bob', commit: 'abc1234', links: [] }
/** @param {Record<string, unknown>} over */
const inactive = (over = {}) => readMemoryRecall({ backend: 'mcp', why: 'w', decisions: [], inactive: [{ id: 'p-1', kind: 'decision', title: 'old', scope: 'src', status: 'withdrawn', date: '2026-10-01', ...over }] }, 0)
const MEM = /** @type {const} */ ({ source: 'recalled', count: 0, why: 'mcp (w)' })

test('a passed record dated after the withdrawn record is applied, the override named once on the memory line', () => {
  for (const date of ['2026-10-02', '2026-10-02T09:00:00Z']) {
    const r = mergeRecall({ ...inactive(), memory: MEM }, [{ ...PASSED, date }], parsePriorDecisions)
    assert.deepEqual(r.prior.decisions.map(d => d.id), ['p-1'], date)
    assert.deepEqual(r.prior.refused, [], date)
    assert.equal(r.memory.why.match(/passed decision #0 \(p-1\) applied over a withdrawn record of 2026-10-01: newer/g)?.length, 1, date)
  }
  const full = mergeAndRead([], [{ ...PASSED, date: '2026-10-01T12:00:00Z' }], parsePriorDecisions, inactive({ date: '2026-10-01T08:00:00Z' }).inactive)
  assert.deepEqual(full.parts, { recalled: 0, passed: 1 }, 'two full timestamps compare to the instant')
  assert.deepEqual(full.overrides, ['passed decision #0 (p-1) applied over a withdrawn record of 2026-10-01T08:00:00Z: newer'])
})

test('a passed record of the same day, older, or undated stays blocked, named with why', () => {
  /** @param {Record<string, unknown>} passed @param {Record<string, unknown>} [over] */
  const blocked = (passed, over) => mergeAndRead([], [{ ...PASSED, ...passed }], parsePriorDecisions, inactive(over).inactive)
  for (const [passed, over, why] of /** @type {Array<[Record<string, unknown>, Record<string, unknown> | undefined, RegExp]>} */ ([
    [{ date: '2026-10-01' }, undefined, /not later than the withdrawn record's 2026-10-01/],
    [{ date: '2026-10-01T23:00:00Z' }, undefined, /not later than the withdrawn record's 2026-10-01/],
    [{ date: '2026-09-01' }, undefined, /2026-09-01 is not later/],
    [{}, undefined, /the passed record carries no ISO date/],
    [{ date: 'last week' }, undefined, /the passed record carries no ISO date/],
    [{ date: '2026-10-09' }, { date: undefined }, /the withdrawn record carries no ISO date/],
    [{ date: '2026-10-09' }, { date: '2026-13-45' }, /the withdrawn record carries no ISO date/],
  ])) {
    const r = blocked(passed, over)
    assert.deepEqual(r.parts, { recalled: 0, passed: 0 }, JSON.stringify([passed, over]))
    assert.equal(r.blocked.length, 1)
    assert.match(String(r.blocked[0]), /^passed decision #0 \(p-1\) not applied: withdrawn in memory/)
    assert.match(String(r.blocked[0]), why)
    assert.deepEqual(r.overrides, [])
  }
})

test('a passed copy an active recalled record holds is a silent duplicate, never refused as superseded beside it', () => {
  const active = { ...PASSED, id: 'p-1', body: 'the store says so', status: 'active', date: '2026-10-03' }
  const r = mergeRecall({ decisions: [active], memory: { ...MEM, count: 1 }, inactive: inactive({ status: 'superseded' }).inactive }, [{ ...PASSED, date: '2026-09-01' }], parsePriorDecisions)
  assert.deepEqual(r.prior.decisions.map(d => d.reason), ['the store says so'])
  assert.deepEqual(r.prior.refused, [])
  assert.deepEqual(r.recalledRefused, [])
})

test('a link naming a question by the store id releases it after the engine set the skill id', async () => {
  const q = { id: 'node-5', kind: 'question', title: 'is the parser input trusted', body: 'decide later', scope: 'src/parse.rs', status: 'active', date: '2026-10-01', author: 'alice', commit: 'abc1234', deferred: true, links: [] }
  const recalled = readMemoryRecall({ backend: 'mcp', why: 'w', decisions: [{ id: 'decision-1234567890', kind: 'decision', title: 'parser input is trusted', body: 'answered', scope: 'src/parse.rs', status: 'active', date: '2026-10-05', author: 'alice', commit: 'abc1234', links: ['answers: node-5'] }], questions: [q] }, 0)
  const records = parsePriorDecisions(recalled.decisions).decisions
  const question = records.find(d => d.kind === 'question')
  assert.match(String(question?.id), /^question-[0-9a-f]{10}$/)
  assert.equal(deferralReleased(deferralOf(/** @type {any} */ (question)), records), true)
  const r = await applyPriorDecisions({ confirmed: [] }, records, async () => ({ unchanged: [], missing: [], reason: '' }))
  assert.match(r.notes.join('\n'), new RegExp(`superseded by another given record — not applied: ${String(question?.id)}`))
})
