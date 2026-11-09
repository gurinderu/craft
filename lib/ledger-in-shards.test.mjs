// The final record's ledger left to its shard checkpoints (lib/ledger-in-shards.mjs), read directly:
// the engine side's choice, the finalize side's rebuild, and the readers. Through the logger CLI:
// craft-log-run-ledger-in-shards.test.mjs.
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { ledgerFromShards, ledgerCountOf, leavesLedgerToShards } from './ledger-in-shards.mjs'
/** @param {number} index @param {number} of @param {number} total @param {object[]} items */
const shard = (index, of, total, items) => ({ ledgerShard: { index, of, total }, ledgerItems: items })

test('finalize side: a record with a ledger, or with no declaration, comes back as it came', () => {
  const withLedger = { ledger: [{ id: 'x' }], ledgerInShards: { of: 1, total: 1 } }
  assert.deepEqual(ledgerFromShards(withLedger, [shard(1, 1, 1, [{ id: 'y' }])], ''), { record: withLedger, warning: '' })
  assert.deepEqual(ledgerFromShards({ round: 1 }, [], ''), { record: { round: 1 }, warning: '' })
})

test('finalize side: the last written set wins over an earlier one under the same declaration', () => {
  const earlier = [shard(1, 2, 2, [{ id: 'old1' }]), shard(2, 2, 2, [{ id: 'old2' }])]
  const later = [shard(1, 2, 2, [{ id: 'new1' }]), shard(2, 2, 2, [{ id: 'new2' }])]
  const got = ledgerFromShards({ ledgerInShards: { of: 2, total: 2 } }, [...earlier, ...later], '')
  assert.deepEqual(got, { record: { ledger: [{ id: 'new1' }, { id: 'new2' }] }, warning: '' })
})

test('finalize side: a short set is filed with what it has, the declaration kept with the count seen, and a warning', () => {
  const got = ledgerFromShards({ ledgerInShards: { of: 2, total: 3 } }, [shard(1, 2, 3, [{ id: 'a' }, { id: 'b' }])], '')
  assert.deepEqual(got.record, { ledger: [{ id: 'a' }, { id: 'b' }], ledgerInShards: { of: 2, total: 3, seen: 1 } })
  assert.equal(got.warning, 'craft-log-run WARNING: the ledger was declared in 2 shard(s) of 3 entr(ies), 1 shard(s) with 2 entr(ies) found — record written with the short ledger, which the next round reads as truncated')
})

test('finalize side: a set whose indices outrun the declared count is short, though it holds every entry', () => {
  const phases = [shard(1, 2, 3, [{ id: 'a' }]), shard(2, 2, 3, [{ id: 'b' }]), shard(3, 2, 3, [{ id: 'c' }])]
  const got = ledgerFromShards({ ledgerInShards: { of: 2, total: 3 } }, phases, '')
  assert.deepEqual(got.record, { ledger: [{ id: 'a' }, { id: 'b' }, { id: 'c' }], ledgerInShards: { of: 2, total: 3, seen: 3 } })
  assert.match(got.warning, /3 shard\(s\) with 3 entr\(ies\) found/)
})

test('ledgerCountOf: the held length, or a larger declared total', () => {
  assert.equal(ledgerCountOf({ ledgerInShards: { total: 7 } }, 2), 7)
  assert.equal(ledgerCountOf({ ledgerInShards: { total: 1 } }, 2), 2)
  assert.equal(ledgerCountOf({ ledgerInShards: { total: 'x' } }, 2), 2)
  assert.equal(ledgerCountOf({ ledgerInShards: null }, 3), 3)
  assert.equal(ledgerCountOf({}, 4), 4)
})

test('leavesLedgerToShards: only a declaration object with no ledger array', () => {
  assert.equal(leavesLedgerToShards({ ledgerInShards: { of: 1, total: 1 } }), true)
  assert.equal(leavesLedgerToShards({ ledger: [], ledgerInShards: { of: 1, total: 1 } }), false)
  assert.equal(leavesLedgerToShards({ ledgerInShards: null }), false)
  assert.equal(leavesLedgerToShards({ ledgerInShards: 3 }), false)
  assert.equal(leavesLedgerToShards({}), false)
})
