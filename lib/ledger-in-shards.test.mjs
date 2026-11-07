// The final record's ledger left to its shard checkpoints (lib/ledger-in-shards.mjs), read directly:
// the engine side's choice, the finalize side's rebuild, and the readers. Through the logger CLI:
// craft-log-run-ledger-in-shards.test.mjs.
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { ledgerRecordFields, ledgerFromShards, ledgerCountOf, leavesLedgerToShards } from './ledger-in-shards.mjs'
import { shardLedger } from './ledger-shards.mjs'

const LEDGER = [{ id: 'a' }, { id: 'b' }, { id: 'c' }]
const SHARDS = shardLedger(LEDGER, { max: 30 })
/** @param {number} index @param {number} of @param {number} total @param {object[]} items */
const shard = (index, of, total, items) => ({ ledgerShard: { index, of, total }, ledgerItems: items })

test('engine side: the declaration only when every shard landed and they hold every entry', () => {
  assert.ok(SHARDS.length > 1, 'the fixture spans several shards')
  assert.deepEqual(ledgerRecordFields(LEDGER, SHARDS, true), { ledgerInShards: { of: SHARDS.length, total: 3 } })
  assert.deepEqual(ledgerRecordFields(LEDGER, SHARDS, false), { ledger: LEDGER }, 'not landed')
  assert.deepEqual(ledgerRecordFields(LEDGER, [], true), { ledger: LEDGER }, 'no shards')
  assert.deepEqual(ledgerRecordFields(LEDGER, SHARDS.slice(1), true), { ledger: LEDGER }, 'shards short of the ledger')
  assert.deepEqual(ledgerRecordFields([], [shard(1, 1, 0, [])], true), { ledgerInShards: { of: 1, total: 0 } }, 'zero carried of zero')
  assert.deepEqual(ledgerRecordFields([], SHARDS, true), { ledger: [] }, 'shards carrying more than the ledger')
})

test('finalize side: a record with a ledger, or with no declaration, comes back as it came', () => {
  const withLedger = { ledger: [{ id: 'x' }], ledgerInShards: { of: 1, total: 1 } }
  assert.deepEqual(ledgerFromShards(withLedger, [shard(1, 1, 1, [{ id: 'y' }])], ''), { record: withLedger, warning: '' })
  assert.deepEqual(ledgerFromShards({ round: 1 }, [], ''), { record: { round: 1 }, warning: '' })
})

test('finalize side: a complete set rebuilds the ledger and drops the declaration', () => {
  const phases = [{ phase: 'scan' }, null, 'text', ...SHARDS, shard(1, 9, 3, [{ id: 'stray' }]), shard(1, SHARDS.length, 99, [{ id: 'stray' }])]
  assert.deepEqual(ledgerFromShards({ round: 2, ledgerInShards: { of: SHARDS.length, total: 3 } }, phases, ''), { record: { round: 2, ledger: LEDGER }, warning: '' })
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

test('finalize side: an unusable directory supplies no shards, and says why', () => {
  const got = ledgerFromShards({ ledgerInShards: { of: SHARDS.length, total: 3 } }, SHARDS, 'the run directory is missing')
  assert.deepEqual(got.record, { ledger: [], ledgerInShards: { of: SHARDS.length, total: 3, seen: 0 } })
  assert.equal(got.warning, `craft-log-run WARNING: the ledger was declared in ${SHARDS.length} shard(s) of 3 entr(ies), but the run directory is missing, so the ledger could not be rebuilt — record written with the short ledger, which the next round reads as truncated`)
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
