// Direct unit tests of lib/review-ledger.mjs: the record verdict (first pass, re-review, strict
// escalation), the floor premise re-read, the late usage limit, the ledger rows and tombstones, the
// shard checkpoints and the run record — with the review run's collaborators faked.
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { ledgerPhase } from './review-ledger.mjs'
import { toLedgerEntry } from './review-ledger-entry.mjs'
import { fingerprint } from './run-record.mjs'

/** @param {string} file @param {Record<string, unknown>} [extra] */
const F = (file, extra = {}) => ({ file, line: 1, severity: 'Low', title: `t ${file}`, why: 'w', source: 'a', ruleId: 'R', symbol: 's', ...extra })

/** @param {Record<string, any>} [s] @param {Record<string, any>} [r] */
async function phase(s = {}, r = {}) {
  /** @type {any[]} */ const records = []
  /** @type {any[]} */ const checkpoints = []
  /** @type {string[]} */ const logs = []
  const reviewRun = /** @type {any} */ ({
    isMaintainability: (/** @type {any} */ f) => f.maint === true,
    finalVerdict: (/** @type {any[]} */ c) => (c.length ? 'Warning' : 'Approve'),
    strict: false,
    limitStop: { seen: () => false, note: () => 'LIMIT' },
    checkpoint: async (/** @type {string} */ name, /** @type {any} */ payload, /** @type {string} */ ph) => { checkpoints.push({ name, payload, ph }); return r['landed'] ?? true },
    logRun: async (/** @type {any} */ x) => { records.push(x) },
    rejoinArmed: false,
    sb: { log: (/** @type {string} */ l) => logs.push(l) },
    ...r,
  })
  const state = /** @type {any} */ ({
    tierLists: { confirmed: [], suspected: [], unverified: [] }, dropped: 0, priorRejected: [], priorRejectedLive: 0, isRereview: false,
    adjudicated: { stillOpen: [], regressed: [], resolved: [], carried: [], retired: [] }, savedByFloor: [], notRun: [], thisRound: 3,
    priorFpComparable: true, priorTombstones: [], priorDisposition: () => 'rejected', branch: 'b', head: 'h',
    reviewRecord: (/** @type {any} */ x) => ({ ...x, wrapped: true }), coverageNotes: [], results: [], thinned: 0,
    sortingRecord: () => 'S', contradictionsRecord: () => 'C', ...s,
  })
  const res = await ledgerPhase(reviewRun, state)
  return { res, record: records[0], records, checkpoints, logs, state }
}

test('a first pass records its verdict, verification counts, dimensions and the ledger in shards', async () => {
  const c = F('c.rs', { severity: 'Medium', tier: 'confirmed', source: 'a' })
  const s = F('s.rs', { tier: 'suspected', source: 'a' })
  const u = F('u.rs', { source: 'b' })
  const p = F('p.rs', { priorTier: 'suspected' })
  const pu = F('pu.rs', { priorTier: 'unverified' })
  const results = [
    { plan: { lenses: ['a', 'b'] }, profile: { id: 'rust' }, confirmed: [c], suspected: [s], unverified: [u], refuted: [F('r.rs', { source: 'b' })], ranLenses: ['a'] },
    { plan: { lenses: ['x'] }, profile: { id: 'nix' }, confirmed: [], suspected: [] },
  ]
  const { res, record, checkpoints, logs } = await phase({ tierLists: { confirmed: [c], suspected: [s], unverified: [u] }, dropped: 2, priorRejected: [p, pu], priorRejectedLive: 1, results, thinned: 4 })
  assert.deepEqual(res, { recordVerdict: 'Warning', floorPremiseHeld: true })
  assert.deepEqual(logs, [])
  const ledger = [toLedgerEntry(c, 'open', 'confirmed'), toLedgerEntry(s, 'open', 'suspected'), toLedgerEntry(u, 'open', 'suspected'), toLedgerEntry(p, 'rejected', 'suspected'), toLedgerEntry(pu, 'rejected', 'unverified')]
  assert.deepEqual(checkpoints.map(x => [x.name, x.ph, x.payload.branch, x.payload.head, x.payload.ledgerShard.index]), [['ledger-01', 'Synthesize', 'b', 'h', 1]])
  assert.deepEqual(checkpoints[0].payload.ledgerItems, ledger)
  assert.deepEqual(record.ledgerInShards, { of: 1, total: 5 })
  assert.equal(record.ledger, undefined)
  assert.deepEqual([record.wrapped, record.verdict, record.round, record.sorting, record.memoryContradictions, record.savedByFloorPremiseHeld], [true, 'Warning', 3, 'S', 'C', true])
  assert.deepEqual(record.verification, { candidates: 4, confirmed: 1, refuteRate: 0.5, unverified: 1, thinned: 4 }, 'the unverified prior and the live one are out of the denominator')
  assert.equal(record.findings.total, 3)
  assert.deepEqual(record.dimensions.map((/** @type {any} */ d) => [d.dimension, d.ran, d.findingCount, d.confirmedCount, d.suspectedCount, d.refutedCount, d.unverifiedCount, d.verdict]), [
    ['rust:a', true, 1, 1, 1, 0, 0, ''], ['rust:b', false, 0, 0, 0, 1, 1, ''], ['nix:x', true, 0, 0, 0, 0, 0, ''],
  ])
  assert.equal(record.dimensions[0].bySeverity.Medium, 1)
})

test('the ledger rides the record when a shard did not land or the run directory may be adopted', async () => {
  const c = F('c.rs', { tier: 'confirmed' })
  for (const r of [{ landed: false }, { rejoinArmed: true }]) {
    const { record } = await phase({ tierLists: { confirmed: [c], suspected: [], unverified: [] } }, r)
    assert.deepEqual(record.ledger, [toLedgerEntry(c, 'open', 'confirmed')])
    assert.equal(record.ledgerInShards, undefined)
  }
  const empty = await phase()
  assert.deepEqual([empty.checkpoints, empty.record.ledger, empty.record.verdict], [[], [], 'Approve'])
})

test('a floor saving whose Block did not come out turns into a coverage hole', async () => {
  const { res, record, logs } = await phase({ savedByFloor: ['m.rs saved'], tierLists: { confirmed: [F('c.rs')], suspected: [], unverified: [] } })
  assert.deepEqual(res, { recordVerdict: 'Warning', floorPremiseHeld: false })
  assert.deepEqual(record.notRun, ['m.rs saved — AND THE PREMISE DID NOT HOLD: the run ended at Warning, not Block, so the saving rested on a confirmed finding that did not reach the verdict; re-run to check them'])
  assert.deepEqual(logs, ['⚠️ 1 verification(s) were skipped because the verdict was already Block, but the run ended at Warning — the skipped findings are reported as a coverage hole, not as a saving'])
  assert.deepEqual([record.verdict, record.savedByFloor, record.savedByFloorPremiseHeld], ['Warning (INCOMPLETE)', ['m.rs saved'], false])
  const held = await phase({ savedByFloor: ['m.rs saved'] }, { finalVerdict: () => 'Block' })
  assert.deepEqual([held.res.floorPremiseHeld, held.record.notRun, held.logs], [true, [], []])
})

test('a late usage limit leads notRun once, and a coverage note marks the verdict partial', async () => {
  const limitStop = { seen: () => true, note: () => 'LIMIT' }
  const late = await phase({ notRun: ['x'] }, { limitStop })
  assert.deepEqual([late.record.notRun, late.record.verdict], [['LIMIT', 'x'], 'INCOMPLETE'])
  const again = await phase({ notRun: ['LIMIT'] }, { limitStop })
  assert.deepEqual(again.record.notRun, ['LIMIT'])
  const partial = await phase({ coverageNotes: ['gap'] })
  assert.equal(partial.record.verdict, 'Approve (PARTIAL COVERAGE)')
})

test('a re-review carries every live track and tombstones what closed, under the current basis', async () => {
  const c = F('c.rs', { tier: 'confirmed' })
  const s = F('s.rs')
  const u = F('u.rs')
  const dup = F('dup.rs', { ledgerDupOfUnverifiedPrior: true })
  const open = F('open.rs', { tier: 'confirmed', disposition: 'open' })
  const reg = F('reg.rs', { tier: 'confirmed' })
  const resolved = F('res.rs', { tier: 'confirmed', fp: 'old', whyRef: { record: 'r', fp: 'f' } })
  const retired = F('ret.rs', { tier: 'confirmed' })
  const carried = F('car.rs', { disposition: 'justified', tier: 'confirmed' })
  const p = F('p.rs', { priorTier: 'confirmed', priorKind: 'question' })
  const earlier = { ...toLedgerEntry(F('old.rs'), 'closed', 'confirmed'), why: 'resolved in round 1' }
  const adjudicated = { stillOpen: [open], regressed: [reg], resolved: [resolved], carried: [carried], retired: [retired] }
  const { res, checkpoints } = await phase({ isRereview: true, tierLists: { confirmed: [c], suspected: [s], unverified: [u, dup] }, adjudicated, priorRejected: [p], priorTombstones: [earlier], priorDisposition: () => 'deferred' }, { landed: false })
  assert.equal(res.recordVerdict, 'Approve', 'Low findings only')
  const rows = checkpoints[0].payload.ledgerItems
  assert.deepEqual(rows.map((/** @type {any} */ x) => [x.file, x.disposition, x.tier]), [
    ['c.rs', 'open', 'confirmed'], ['s.rs', 'open', 'suspected'], ['u.rs', 'open', 'unverified'], ['open.rs', 'open', 'confirmed'], ['reg.rs', 'open', 'confirmed'],
    ['res.rs', 'closed', 'confirmed'], ['ret.rs', 'closed', 'confirmed'], ['old.rs', 'closed', 'confirmed'], ['car.rs', 'justified', 'confirmed'], ['p.rs', 'deferred', 'confirmed'],
  ])
  const [tRes, tRet] = rows.slice(5, 7)
  assert.deepEqual([tRes.why, tRes.fp, tRes.whyRef, tRet.why], ['resolved in round 3', fingerprint(/** @type {any} */ (resolved)), undefined, 'dismissed in round 3'])
  const stale = await phase({ isRereview: true, priorTombstones: [earlier], priorFpComparable: false }, { landed: false })
  assert.deepEqual(stale.record.ledger, [], 'tombstones from an incomparable basis are dropped')
})

test('a re-review verdict counts the live priors, and strict mode blocks on a Medium maintainability one', async () => {
  const adjudicated = { stillOpen: [F('o.rs', { severity: 'Medium', maint: true })], regressed: [], resolved: [], carried: [], retired: [] }
  const plain = await phase({ isRereview: true, adjudicated })
  assert.equal(plain.res.recordVerdict, 'Warning')
  const strict = await phase({ isRereview: true, adjudicated }, { strict: true })
  assert.equal(strict.res.recordVerdict, 'Block')
  for (const severity of ['Critical', 'High']) {
    const hi = await phase({ isRereview: true, adjudicated: { ...adjudicated, stillOpen: [], regressed: [F('r.rs', { severity: 'Low', maint: true })] }, tierLists: { confirmed: [F('c.rs', { severity, maint: true })], suspected: [], unverified: [] } }, { strict: true })
    assert.equal(hi.res.recordVerdict, 'Block')
  }
  const low = await phase({ isRereview: true, adjudicated: { ...adjudicated, stillOpen: [F('o.rs', { severity: 'Low', maint: true })] } }, { strict: true })
  assert.equal(low.res.recordVerdict, 'Approve')
  const notMaint = await phase({ isRereview: true, adjudicated: { ...adjudicated, stillOpen: [F('o.rs', { severity: 'Medium' })] } }, { strict: true })
  assert.equal(notMaint.res.recordVerdict, 'Warning')
})
