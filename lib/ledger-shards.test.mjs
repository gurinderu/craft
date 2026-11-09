// The LEDGER must outlive the record it used to ride on — and a partial carry must never read as a
// full one.
//
// Written against the measured failure, not against the code. Three consecutive review runs filed no
// record: a network error, a 196KB logger payload, and a 131-agent/87-minute run whose logger refused
// outright, saying it could not reproduce a ~170-entry ledger plus a 14-element dimensions array
// without risking truncation inside one tool call. All three left their phase checkpoints intact and
// all three lost the ledger. So every case below asks: the record is gone — does the next round get
// the round's FINDINGS (not merely its number), and is a shortfall visible when one occurs?
import { test } from 'vitest'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { assembleLedgerShards } from './ledger-shards.mjs'
import { findPriorRound, partialChainEvidence, checkpointDir, writeCheckpoint, finalizeRun } from './craft-log-run.mjs'

/** @typedef {{ ledgerShard: { index: number, of: number, total: number }, ledgerItems: unknown[] }} Shard */
/** @typedef {ReturnType<typeof entry>} Entry */

// The shard checkpoints a review run of the retired JS engine left in the store, as its writer cut them: `per`
// entries each, every one declaring its index, the shard count and the round's entry count.
/** @param {unknown[]} items @param {number} [per] @returns {{ ledgerShard: { index: number, of: number, total: number }, ledgerItems: unknown[] }[]} */
const shardLedger = (items, per = 1) => {
  const groups = []
  for (let i = 0; i < items.length; i += per) groups.push(items.slice(i, i + per))
  return groups.map((ledgerItems, i) => ({ ledgerShard: { index: i + 1, of: groups.length, total: items.length }, ledgerItems }))
}

// A ledger entry the size the live runs actually produce: `why` is capped at 500 characters by the
// engine and most confirmed findings come close to it.
/** @param {number} i @param {number} [whyLen] */
function entry(i, whyLen = 400) {
  return {
    fp: `fp${String(i).padStart(4, '0')}`, file: `src/module_${i}/thing.rs`, line: 100 + i,
    symbol: `fn_${i}`, severity: i % 5 === 0 ? 'High' : 'Medium', tier: 'confirmed',
    disposition: 'open', source: 'invariants', ruleId: `rule-${i}`,
    title: `finding number ${i} in a plausible place`, why: 'x'.repeat(whyLen),
  }
}

// The live run this work exists for: ~170 entries.
const bigLedger = Array.from({ length: 170 }, (_, i) => entry(i))

function tempRepo(branch = 'feat/x') {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'craft-shard-repo-')))
  /** @param {string[]} a */
  const g = a => execFileSync('git', a, { cwd: dir, stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf8' }).trim()
  g(['init', '-q', '-b', branch])
  g(['config', 'user.email', 't@t']); g(['config', 'user.name', 't'])
  fs.writeFileSync(path.join(dir, 'a'), '1'); g(['add', 'a']); g(['commit', '-qm', 'one'])
  return { dir, head: g(['rev-parse', '--short', 'HEAD']) }
}

function tmpStore() {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'craft-shard-store-')))
}

test('BACK-COMPAT: phases carrying no shard at all assemble to the pre-existing empty answer', () => {
  const back = assembleLedgerShards([{ phase: 'rust-plan', branch: 'feat/x' }, { phase: 'rust-verify', findings: { total: 6 } }])
  assert.deepEqual(back, { ledger: [], total: 0, shardsOf: 0, shardsSeen: 0, complete: false })
  assert.deepEqual(assembleLedgerShards(null), { ledger: [], total: 0, shardsOf: 0, shardsSeen: 0, complete: false })
})

test('a full set of shards round-trips and reads as COMPLETE', () => {
  const back = assembleLedgerShards(shardLedger(bigLedger, 15))
  assert.equal(back.complete, true)
  assert.deepEqual(back.ledger, bigLedger)
  assert.equal(back.total, bigLedger.length)
  assert.equal(back.shardsSeen, back.shardsOf)
})

test('REQUIREMENT: a ledger carried PARTIALLY reads as partial, never as full', () => {
  const shards = shardLedger(bigLedger, 15)
  assert.ok(shards.length >= 3)
  const landed = shards.filter((_, i) => i !== 1)          // one shard's write died
  const back = assembleLedgerShards(landed)
  assert.equal(back.complete, false, 'a missing shard must not read as a complete ledger')
  assert.ok(back.ledger.length > 0, 'and what did land is still carried — a partial ledger beats none')
  assert.ok(back.total > back.ledger.length,
    'the declared total exceeds the array: that inequality IS the signal a reader takes for a truncated ledger')
})

test('a duplicate shard index cannot inflate the recovered count into looking complete', () => {
  const shards = shardLedger(bigLedger, 15)
  const back = assembleLedgerShards([shards[0], { ...shards[0] }])
  assert.equal(back.shardsSeen, 1)
  assert.equal(back.complete, false)
})

test('a corrupt total below what actually landed never reads as over-full', () => {
  const one = /** @type {Shard} */ (shardLedger([entry(0), entry(1)], 2)[0])
  const back = assembleLedgerShards([{ ...one, ledgerShard: { ...one.ledgerShard, total: 0 } }])
  assert.equal(back.total, 2)
  assert.equal(back.complete, false, 'a declaration we cannot believe is not a completeness claim')
})

/** @param {string} store @param {string} project @param {string} branch @param {string} head @param {any[]} ledger @param {{ drop?: number[], now?: string }} [opts] */
function deadRunWithShards(store, project, branch, head, ledger, { drop = [], now = '2026-07-11T00:00:00Z' } = {}) {
  const dir = checkpointDir({ kind: 'workflow', name: 'review' }, { store, project, now: new Date(now) })
  writeCheckpoint(dir, 'rust-plan', { branch, head }, { project })
  writeCheckpoint(dir, 'rust-verify', { branch, head, findings: { total: ledger.length } }, { project })
  shardLedger(ledger, 15).forEach((shard, i) => {
    if (drop.includes(i)) return
    writeCheckpoint(dir, `ledger-${String(i + 1).padStart(2, '0')}`, { branch, head, ...shard }, { project })
  })
  return dir
}

test('REQUIREMENT: the final record is LOST and the next round gets the prior round\'s FINDINGS, not just their count', (t) => {
  const store = tmpStore()
  const { dir: project, head } = tempRepo('feat/x')
  t.onTestFinished(() => { [store, project].forEach(d => fs.rmSync(d, { recursive: true, force: true })) })
  // No index, no detail file — the record never landed, exactly as in all three measured losses.
  deadRunWithShards(store, project, 'feat/x', head, bigLedger)

  const hit = findPriorRound({ store, project, branch: 'feat/x' })
  assert.equal(hit.found, true)
  assert.equal(hit.round, 1, 'nothing complete precedes it, so the dead round is round 1')
  assert.equal(hit.ledger.length, bigLedger.length, 'the round\'s findings survived the lost record')
  assert.equal(hit.ledgerCount, bigLedger.length, 'and the authoritative count agrees — this reads as a COMPLETE ledger')
  assert.equal(/** @type {Entry} */ (hit.ledger[0]).fp, /** @type {Entry} */ (bigLedger[0]).fp)
  assert.equal(/** @type {Entry} */ (hit.ledger[169]).why, /** @type {Entry} */ (bigLedger[169]).why, 'entries are carried whole, not summarized')
})

test('REQUIREMENT: a dead run\'s shards outrank the last COMPLETE round\'s stale ledger', (t) => {
  const store = tmpStore()
  const { dir: project, head } = tempRepo('feat/x')
  t.onTestFinished(() => { [store, project].forEach(d => fs.rmSync(d, { recursive: true, force: true })) })
  const stale = [entry(900)]
  fs.writeFileSync(path.join(store, '2026-07-10T00-00-00Z-workflow-review.json'),
    JSON.stringify({ round: 2, head, ledger: stale, findings: { total: 1 } }))
  fs.writeFileSync(path.join(store, 'index.jsonl'),
    JSON.stringify({ ts: '2026-07-10T00-00-00Z', kind: 'workflow', name: 'review', project, branch: 'feat/x', head, round: 2, findingsTotal: 1 }) + '\n')
  deadRunWithShards(store, project, 'feat/x', head, bigLedger)

  const hit = findPriorRound({ store, project, branch: 'feat/x' })
  assert.equal(hit.round, 3)
  assert.equal(hit.ledger.length, bigLedger.length)
  assert.equal(/** @type {Entry} */ (hit.ledger[0]).fp, /** @type {Entry} */ (bigLedger[0]).fp, 'the DEAD round\'s ledger, not the older complete round\'s')
  assert.equal(hit.ledgerCount, bigLedger.length)
})

test('REQUIREMENT: a partially sharded dead run reaches the engine as a TRUNCATED ledger (the loud shape)', (t) => {
  const store = tmpStore()
  const { dir: project, head } = tempRepo('feat/x')
  t.onTestFinished(() => { [store, project].forEach(d => fs.rmSync(d, { recursive: true, force: true })) })
  deadRunWithShards(store, project, 'feat/x', head, bigLedger, { drop: [1, 4] })

  const hit = findPriorRound({ store, project, branch: 'feat/x' })
  assert.equal(hit.found, true)
  assert.ok(hit.ledger.length > 0)
  assert.equal(hit.ledgerCount, bigLedger.length, 'the count stays the round\'s own, so it cannot pass as complete')
  assert.notEqual(hit.ledgerCount, hit.ledger.length, 'this inequality is what a reader of the round takes for a degraded one')
})

test('a finalized record does NOT carry the ledger twice — the shards are folded OUT', (t) => {
  const store = tmpStore()
  const { dir: project, head } = tempRepo('feat/x')
  t.onTestFinished(() => { [store, project].forEach(d => fs.rmSync(d, { recursive: true, force: true })) })
  const dir = deadRunWithShards(store, project, 'feat/x', head, bigLedger)
  const { file } = finalizeRun({ kind: 'workflow', name: 'review', round: 1, ledger: bigLedger, findings: { total: bigLedger.length } },
    { store, project, dir, workdir: project })
  const rec = JSON.parse(fs.readFileSync(file, 'utf8'))
  assert.equal(rec.ledger.length, bigLedger.length, 'the record keeps its own ledger')
  assert.ok(Array.isArray(rec.phases) && rec.phases.length, 'the ordinary phases are still folded in')
  assert.equal(rec.phases.filter(/** @param {{ ledgerShard?: unknown }} p */ p => p.ledgerShard).length, 0, 'but not the shards — that would store the ledger twice')
})

test('BACK-COMPAT: a dead run with NO shards still reads exactly as it did before this existed', (t) => {
  const store = tmpStore()
  const { dir: project, head } = tempRepo('feat/x')
  t.onTestFinished(() => { [store, project].forEach(d => fs.rmSync(d, { recursive: true, force: true })) })
  // Shape of the 2026-09-18 leftover in the live store: three checkpoints, no ledger of any kind.
  const dir = checkpointDir({ kind: 'workflow', name: 'review' }, { store, project, now: new Date('2026-07-11T00:00:00Z') })
  writeCheckpoint(dir, 'rust-plan', { branch: 'feat/x', head }, { project })
  writeCheckpoint(dir, 'rust-lenses', { branch: 'feat/x', head }, { project })
  writeCheckpoint(dir, 'rust-verify', { branch: 'feat/x', head, findings: { total: 86 } }, { project })

  const [ev] = partialChainEvidence({ store, project, branch: 'feat/x' })
  assert.ok(ev)
  assert.equal(ev.findingsTotal, 86)
  assert.deepEqual(ev.ledger, [], 'no shards, no ledger — and no crash')
  assert.equal(ev.ledgerTotal, 0)
  const hit = findPriorRound({ store, project, branch: 'feat/x' })
  assert.equal(hit.found, true, 'the round still counts')
  assert.equal(hit.priorFindings, 86)
  assert.deepEqual(hit.ledger, [], 'and the pre-existing degraded shape is unchanged')
  assert.equal(hit.ledgerCount, 0)
})

// ---- the tombstone bound: the memory cannot invert into a per-round rescan --------------------



test('shard reassembly: first writer of an index wins, malformed phases and entries are skipped, the largest declaration counts', () => {
  const got = assembleLedgerShards([
    { ledgerShard: { index: 2, of: 1, total: 'x' }, ledgerItems: [{ a: 1 }, null, 3] },
    { ledgerShard: { index: 2, of: 1, total: 5 }, ledgerItems: [{ dup: 1 }] },
    { ledgerShard: { index: 0 } },
    { ledgerShard: { index: 1.5 } },
    { ledgerShard: 'str' },
    null,
    'x',
    { ledgerShard: { index: 1, of: 2, total: 3 }, ledgerItems: [{ b: 1 }, { c: 1 }] },
  ])
  assert.deepEqual(got, { ledger: [{ b: 1 }, { c: 1 }, { a: 1 }], total: 5, shardsOf: 2, shardsSeen: 2, complete: false })
  // An index above the declared count raises the count: the shortfall reads loud, never complete.
  assert.deepEqual(assembleLedgerShards([{ ledgerShard: { index: 2, of: 1, total: 1 }, ledgerItems: [{ a: 1 }] }]),
    { ledger: [{ a: 1 }], total: 1, shardsOf: 2, shardsSeen: 1, complete: false })
})
