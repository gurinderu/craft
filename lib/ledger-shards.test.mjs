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
import { findPriorRound, partialChainEvidence, checkpointDir, writeCheckpoint } from './craft-log-run.mjs'

/** @typedef {{ ledgerShard: { index: number, of: number, total: number }, ledgerItems: unknown[] }} Shard */
/** @typedef {Record<string, unknown>} Entry */

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
