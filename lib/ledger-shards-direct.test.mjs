// Direct tests of lib/ledger-shards.mjs at the edges ledger-shards.test.mjs leaves open: the
// phase-name prefix, an unserialisable payload, a multi-digit round marker, order below the
// tombstone cap, and malformed shard declarations in a recovered checkpoint directory.
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { LEDGER_SHARD_PHASE, payloadBytes, tombstoneRound, pruneTombstones, assembleLedgerShards } from './ledger-shards.mjs'

test('the shard phases are named ledger-NN', () => {
  assert.equal(LEDGER_SHARD_PHASE, 'ledger')
})

test('payloadBytes of a value JSON cannot serialise is the size of an empty slot', () => {
  assert.equal(payloadBytes(undefined), 2)
})

test('tombstoneRound reads a multi-digit round marker', () => {
  assert.equal(tombstoneRound({ why: 'resolved in round 12', round: 3 }), 12)
})

test('pruneTombstones keeps insertion order when the set fits the cap, up to exactly the cap', () => {
  const rows = [{ fp: 'a', round: 1 }, { fp: 'b', round: 2 }]
  assert.deepEqual(pruneTombstones(rows, { max: 5 }), rows)
  assert.deepEqual(pruneTombstones(rows, { max: 2 }), rows)
  assert.deepEqual(pruneTombstones(rows, { max: 1 }), [rows[1]])
})

test('assembleLedgerShards skips a null shard declaration rather than throwing', () => {
  const out = assembleLedgerShards([{ ledgerShard: null }, { ledgerShard: { index: 1, of: 1, total: 1 }, ledgerItems: [{ id: 1 }] }])
  assert.deepEqual(out, { ledger: [{ id: 1 }], total: 1, shardsOf: 1, shardsSeen: 1, complete: true })
})

test('assembleLedgerShards takes a missing shard count as unknown, and a declared one over the index', () => {
  const noOf = assembleLedgerShards([{ ledgerShard: { index: 1, total: 1 }, ledgerItems: [{ id: 1 }] }])
  assert.equal(noOf.shardsOf, 1)
  const ofTwo = assembleLedgerShards([{ ledgerShard: { index: 1, of: 2, total: 2 }, ledgerItems: [{ id: 1 }] }])
  assert.deepEqual([ofTwo.shardsOf, ofTwo.complete], [2, false])
})
