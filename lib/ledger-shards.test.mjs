// The LEDGER must outlive the record it used to ride on — and a partial carry must never read as a
// full one.
//
// Written against the measured failure, not against the code. Three consecutive review runs filed no
// record: a network error, a 196KB logger payload, and a 131-agent/87-minute run whose logger refused
// outright, saying it could not reproduce a ~170-entry ledger plus a 14-element dimensions array
// without risking truncation inside one tool call. All three left their phase checkpoints intact and
// all three lost the ledger. So every case below asks: the record is gone — does the next round get
// the round's FINDINGS (not merely its number), and is a shortfall visible when one occurs?
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { shardLedger, assembleLedgerShards, pruneTombstones, tombstoneRound, LEDGER_SHARD_MAX_BYTES, LEDGER_SHARD_MAX_SHARDS, LEDGER_SHARD_PHASE, LEDGER_SHARD_TYPICAL_ENTRIES, LEDGER_TOMBSTONE_MAX } from './ledger-shards.mjs'
import { findPriorRound, partialChainEvidence, checkpointDir, writeCheckpoint, finalizeRun } from './craft-log-run.mjs'

function tempRepo(branch = 'feat/x') {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'craft-shard-repo-')))
  const g = a => execFileSync('git', a, { cwd: dir, stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf8' }).trim()
  g(['init', '-q', '-b', branch])
  g(['config', 'user.email', 't@t']); g(['config', 'user.name', 't'])
  fs.writeFileSync(path.join(dir, 'a'), '1'); g(['add', 'a']); g(['commit', '-qm', 'one'])
  return { dir, head: g(['rev-parse', '--short', 'HEAD']) }
}

function tmpStore() {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'craft-shard-store-')))
}

// A ledger entry the size the live runs actually produce: `why` is capped at 500 characters by the
// engine and most confirmed findings come close to it.
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

// ---- the size bound: what crosses a model in ONE step ------------------------------------------

test('REQUIREMENT: the volume crossing a model in one step is bounded — asserted by threshold, not by an exact number', () => {
  const shards = shardLedger(bigLedger)
  assert.ok(shards.length > 1, 'a 170-entry ledger does not fit in one step; if it did, the bound is not being applied')
  for (const s of shards) {
    // The PROMPT form, not the compact one: this is what crosses the model (lib/run-logging.mjs
    // serialises the payload with indentation). Measuring the compact form is what let a shard
    // reach 24859B in the prompt while the test read it as comfortably under the bound.
    const bytes = JSON.stringify(s, null, 2).length
    assert.ok(bytes <= LEDGER_SHARD_MAX_BYTES + 512,
      `shard ${s.ledgerShard.index} is ${bytes}B, over the per-step bound ${LEDGER_SHARD_MAX_BYTES}B (+512B of wrapper)`)
  }
  // The point of the whole device, stated as the comparison that motivated it: the payload that the
  // logger refused was the WHOLE ledger in one call. Each step is now an order of magnitude smaller.
  const whole = JSON.stringify(bigLedger, null, 2).length
  const worst = Math.max(...shards.map(s => JSON.stringify(s, null, 2).length))
  assert.ok(worst * 5 < whole, `the largest single step (${worst}B) is not a small fraction of the one-call payload (${whole}B)`)
  // And under the threshold at which `logRunDispatch` itself stops trusting the cheap model (24KB).
  assert.ok(worst < 24 * 1024, 'a step must stay under the size at which the write path already distrusts a model copy')
})

test('an entry larger than the bound gets a shard to itself rather than being split or dropped', () => {
  const huge = { ...entry(1), why: 'y'.repeat(LEDGER_SHARD_MAX_BYTES * 2) }
  const shards = shardLedger([entry(0), huge, entry(2)])
  assert.equal(shards.flatMap(s => s.ledgerItems).length, 3, 'nothing is dropped')
  assert.equal(shards.find(s => s.ledgerItems.some(x => x.fp === huge.fp)).ledgerItems.length, 1)
})

test('the shard count is capped, and the overflow is DECLARED rather than silently short', () => {
  const shards = shardLedger(bigLedger, { max: 200, maxShards: 3 })
  assert.equal(shards.length, 3)
  const carried = shards.flatMap(s => s.ledgerItems).length
  assert.ok(carried < bigLedger.length, 'the cap bit, as this case is built to make it')
  assert.equal(shards[0].ledgerShard.total, bigLedger.length,
    'the DECLARED total is the round\'s, not what was shipped — that is the only reason the drop is detectable')
  const back = assembleLedgerShards(shards)
  assert.equal(back.complete, false)
  assert.equal(back.total, bigLedger.length)
  assert.equal(back.ledger.length, carried)
})

test('an empty ledger writes no shards — an empty shard would claim the round found nothing', () => {
  assert.deepEqual(shardLedger([]), [])
  assert.deepEqual(shardLedger(null), [])
})

// ---- assembly and its honesty ------------------------------------------------------------------

test('a full set of shards round-trips and reads as COMPLETE', () => {
  const back = assembleLedgerShards(shardLedger(bigLedger))
  assert.equal(back.complete, true)
  assert.deepEqual(back.ledger, bigLedger)
  assert.equal(back.total, bigLedger.length)
  assert.equal(back.shardsSeen, back.shardsOf)
})

test('REQUIREMENT: a ledger carried PARTIALLY reads as partial, never as full', () => {
  const shards = shardLedger(bigLedger)
  assert.ok(shards.length >= 3)
  const landed = shards.filter((_, i) => i !== 1)          // one shard's write died
  const back = assembleLedgerShards(landed)
  assert.equal(back.complete, false, 'a missing shard must not read as a complete ledger')
  assert.ok(back.ledger.length > 0, 'and what did land is still carried — a partial ledger beats none')
  assert.ok(back.total > back.ledger.length,
    'the declared total exceeds the array: that inequality IS the signal review.js reads as a truncated ledger')
})

test('a duplicate shard index cannot inflate the recovered count into looking complete', () => {
  const shards = shardLedger(bigLedger)
  const back = assembleLedgerShards([shards[0], { ...shards[0] }])
  assert.equal(back.shardsSeen, 1)
  assert.equal(back.complete, false)
})

test('a corrupt total below what actually landed never reads as over-full', () => {
  const one = shardLedger([entry(0), entry(1)], { max: 1e6 })[0]
  const back = assembleLedgerShards([{ ...one, ledgerShard: { ...one.ledgerShard, total: 0 } }])
  assert.equal(back.total, 2)
  assert.equal(back.complete, false, 'a declaration we cannot believe is not a completeness claim')
})

test('BACK-COMPAT: phases carrying no shard at all assemble to the pre-existing empty answer', () => {
  const back = assembleLedgerShards([{ phase: 'rust-plan', branch: 'feat/x' }, { phase: 'rust-verify', findings: { total: 6 } }])
  assert.deepEqual(back, { ledger: [], total: 0, shardsOf: 0, shardsSeen: 0, complete: false })
  assert.deepEqual(assembleLedgerShards(null), { ledger: [], total: 0, shardsOf: 0, shardsSeen: 0, complete: false })
})

// ---- end to end: the record is lost and the next round still gets the findings -----------------

function deadRunWithShards(store, project, branch, head, ledger, { drop = [], now = '2026-07-11T00:00:00Z' } = {}) {
  const dir = checkpointDir({ kind: 'workflow', name: 'review' }, { store, project, now: new Date(now) })
  writeCheckpoint(dir, 'rust-plan', { branch, head }, { project })
  writeCheckpoint(dir, 'rust-verify', { branch, head, findings: { total: ledger.length } }, { project })
  shardLedger(ledger).forEach((shard, i) => {
    if (drop.includes(i)) return
    writeCheckpoint(dir, `${LEDGER_SHARD_PHASE}-${String(i + 1).padStart(2, '0')}`, { branch, head, ...shard }, { project })
  })
  return dir
}

test('REQUIREMENT: the final record is LOST and the next round gets the prior round\'s FINDINGS, not just their count', (t) => {
  const store = tmpStore()
  const { dir: project, head } = tempRepo('feat/x')
  t.after(() => { [store, project].forEach(d => fs.rmSync(d, { recursive: true, force: true })) })
  // No index, no detail file — the record never landed, exactly as in all three measured losses.
  deadRunWithShards(store, project, 'feat/x', head, bigLedger)

  const hit = findPriorRound({ store, project, branch: 'feat/x' })
  assert.equal(hit.found, true)
  assert.equal(hit.round, 1, 'nothing complete precedes it, so the dead round is round 1')
  assert.equal(hit.ledger.length, bigLedger.length, 'the round\'s findings survived the lost record')
  assert.equal(hit.ledgerCount, bigLedger.length, 'and the authoritative count agrees — this reads as a COMPLETE ledger')
  assert.equal(hit.ledger[0].fp, bigLedger[0].fp)
  assert.equal(hit.ledger[169].why, bigLedger[169].why, 'entries are carried whole, not summarized')
})

test('REQUIREMENT: a dead run\'s shards outrank the last COMPLETE round\'s stale ledger', (t) => {
  const store = tmpStore()
  const { dir: project, head } = tempRepo('feat/x')
  t.after(() => { [store, project].forEach(d => fs.rmSync(d, { recursive: true, force: true })) })
  const stale = [entry(900)]
  fs.writeFileSync(path.join(store, '2026-07-10T00-00-00Z-workflow-review.json'),
    JSON.stringify({ round: 2, head, ledger: stale, findings: { total: 1 } }))
  fs.writeFileSync(path.join(store, 'index.jsonl'),
    JSON.stringify({ ts: '2026-07-10T00-00-00Z', kind: 'workflow', name: 'review', project, branch: 'feat/x', head, round: 2, findingsTotal: 1 }) + '\n')
  deadRunWithShards(store, project, 'feat/x', head, bigLedger)

  const hit = findPriorRound({ store, project, branch: 'feat/x' })
  assert.equal(hit.round, 3)
  assert.equal(hit.ledger.length, bigLedger.length)
  assert.equal(hit.ledger[0].fp, bigLedger[0].fp, 'the DEAD round\'s ledger, not the older complete round\'s')
  assert.equal(hit.ledgerCount, bigLedger.length)
})

test('REQUIREMENT: a partially sharded dead run reaches the engine as a TRUNCATED ledger (the loud shape)', (t) => {
  const store = tmpStore()
  const { dir: project, head } = tempRepo('feat/x')
  t.after(() => { [store, project].forEach(d => fs.rmSync(d, { recursive: true, force: true })) })
  deadRunWithShards(store, project, 'feat/x', head, bigLedger, { drop: [1, 4] })

  const hit = findPriorRound({ store, project, branch: 'feat/x' })
  assert.equal(hit.found, true)
  assert.ok(hit.ledger.length > 0)
  assert.equal(hit.ledgerCount, bigLedger.length, 'the count stays the round\'s own, so it cannot pass as complete')
  // `ledgerTruncated` in workflows/review.js is literally `ledgerCount !== ledger.length`, and
  // `ledgerDegraded` forces a full base...HEAD re-scan off it. Reproduced here rather than imported:
  // the engine is a workflow script and cannot be imported (see check-workflows).
  assert.notEqual(hit.ledgerCount, hit.ledger.length, 'this inequality is what the engine reads as a degraded round')
})

test('BACK-COMPAT: a dead run with NO shards still reads exactly as it did before this existed', (t) => {
  const store = tmpStore()
  const { dir: project, head } = tempRepo('feat/x')
  t.after(() => { [store, project].forEach(d => fs.rmSync(d, { recursive: true, force: true })) })
  // Shape of the 2026-09-18 leftover in the live store: three checkpoints, no ledger of any kind.
  const dir = checkpointDir({ kind: 'workflow', name: 'review' }, { store, project, now: new Date('2026-07-11T00:00:00Z') })
  writeCheckpoint(dir, 'rust-plan', { branch: 'feat/x', head }, { project })
  writeCheckpoint(dir, 'rust-lenses', { branch: 'feat/x', head }, { project })
  writeCheckpoint(dir, 'rust-verify', { branch: 'feat/x', head, findings: { total: 86 } }, { project })

  const [ev] = partialChainEvidence({ store, project, branch: 'feat/x' })
  assert.equal(ev.findingsTotal, 86)
  assert.deepEqual(ev.ledger, [], 'no shards, no ledger — and no crash')
  assert.equal(ev.ledgerTotal, 0)
  const hit = findPriorRound({ store, project, branch: 'feat/x' })
  assert.equal(hit.found, true, 'the round still counts')
  assert.equal(hit.priorFindings, 86)
  assert.deepEqual(hit.ledger, [], 'and the pre-existing degraded shape is unchanged')
  assert.equal(hit.ledgerCount, 0)
})

test('a finalized record does NOT carry the ledger twice — the shards are folded OUT', (t) => {
  const store = tmpStore()
  const { dir: project, head } = tempRepo('feat/x')
  t.after(() => { [store, project].forEach(d => fs.rmSync(d, { recursive: true, force: true })) })
  const dir = deadRunWithShards(store, project, 'feat/x', head, bigLedger)
  const { file } = finalizeRun({ kind: 'workflow', name: 'review', round: 1, ledger: bigLedger, findings: { total: bigLedger.length } },
    { store, project, dir, workdir: project })
  const rec = JSON.parse(fs.readFileSync(file, 'utf8'))
  assert.equal(rec.ledger.length, bigLedger.length, 'the record keeps its own ledger')
  assert.ok(Array.isArray(rec.phases) && rec.phases.length, 'the ordinary phases are still folded in')
  assert.equal(rec.phases.filter(p => p.ledgerShard).length, 0, 'but not the shards — that would store the ledger twice')
})

// ---- the engine's call site --------------------------------------------------------------------
// workflows/review.js cannot be imported (top-level export + await + return; see
// lib/check-workflows.mjs), so this is a string match. It catches a DELETION of the call, not a
// defect in it — stated plainly rather than left to read as coverage. What the call does is covered
// by the cases above, against the extracted functions the fence pastes in verbatim.
test('TRIPWIRE: review.js still shards its ledger into checkpoints BEFORE attempting the record', () => {
  const src = fs.readFileSync(new URL('../workflows/review.js', import.meta.url), 'utf8')
  const shardAt = src.indexOf('for (const shard of shardLedger(reviewLedger))')
  const logAt = src.lastIndexOf('await logRun(reviewRecord({')      // the two earlier calls file empty-ledger stubs
  assert.ok(shardAt > 0, 'the shard loop is gone from review.js')
  assert.ok(logAt > 0)
  assert.ok(shardAt < logAt, 'the shards must be written BEFORE the fragile record write, or they buy nothing')
  assert.ok(src.includes(`${LEDGER_SHARD_PHASE}-`), 'the shard phase prefix must reach the checkpoint name')
})

test('the shard cap and byte bound are what this module says they are', () => {
  assert.equal(LEDGER_SHARD_MAX_BYTES, 14336)
  assert.equal(LEDGER_SHARD_MAX_SHARDS, 20)
})

// ---- the tombstone bound: the memory cannot invert into a per-round rescan --------------------

test('LEDGER_TOMBSTONE_MAX is DERIVED from the shard budget, not a free number', () => {
  assert.equal(LEDGER_TOMBSTONE_MAX, Math.floor(LEDGER_SHARD_MAX_SHARDS / 2) * LEDGER_SHARD_TYPICAL_ENTRIES,
    'the cap is half the shard budget in rows, so it moves with the budget it protects')
})

test('pruneTombstones dedups by fp, keeping the NEWEST round per fp', () => {
  const out = pruneTombstones([
    { fp: 'a', why: 'resolved in round 1' },
    { fp: 'a', why: 'resolved in round 3' },
    { fp: 'a', why: 'resolved in round 2' },
    { fp: 'b', why: 'dismissed in round 1' },
  ])
  assert.equal(out.length, 2, 'one row per fp — a recidivist does not multiply rows')
  assert.match(out.find(t => t.fp === 'a').why, /round 3/, 'the survivor for a repeated fp is its newest round')
})

test('pruneTombstones caps the set at max, evicting the OLDEST rounds first', () => {
  const many = Array.from({ length: 5 }, (_, i) => ({ fp: `fp${i}`, why: `resolved in round ${i + 1}` }))
  const out = pruneTombstones(many, { max: 3 })
  assert.equal(out.length, 3, 'the set is bounded so tombstones cannot fill the shard budget by themselves')
  assert.deepEqual(out.map(tombstoneRound).sort((a, b) => a - b), [3, 4, 5], 'the three newest rounds are kept; rounds 1 and 2 are evicted')
})

test('pruneTombstones keeps fp-less rows unmerged but still under the count cap', () => {
  const out = pruneTombstones([
    { why: 'resolved in round 1' },
    { why: 'resolved in round 2' },
    { fp: 'a', why: 'resolved in round 3' },
  ], { max: 10 })
  assert.equal(out.length, 3, 'rows with no identity are not merged into one another')
})

test('tombstoneRound reads the round from the why marker, with the round field as a fallback', () => {
  assert.equal(tombstoneRound({ why: 'dismissed in round 7' }), 7)
  assert.equal(tombstoneRound({ why: 'no marker here', round: 4 }), 4)
  assert.equal(tombstoneRound({ why: '', round: 'x' }), 0)
})
