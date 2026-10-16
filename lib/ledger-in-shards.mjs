// The final record's ledger, left to the shard checkpoints that already carry it (realm @nick/craft,
// node #245; risk #94).
//
// The engine persists the ledger in bounded shards before the record (lib/ledger-shards.mjs), and the
// final record used to carry the whole ledger again, in the ONE heredoc a logger agent copies. That
// copy is what kept getting interrupted — the lost records were the ones with the largest ledgers,
// while every one of their shards had landed. So when every shard landed in the run's own directory,
// the record carries only a declaration of what the shards hold, and finalize rebuilds the ledger from
// them before filing: the stored record keeps its `ledger` array and nothing downstream changes.
//
// A short or unprovable set is filed with what it has AND the declared total, which the prior-round
// reader reports as `ledgerCount` — a truncated ledger to the next round, never a short round.

import { assembleLedgerShards } from './ledger-shards.mjs'

// The engine side: the record's ledger fields. Only the declaration when every shard landed in the
// run's own directory and the shards together hold every entry (a ledger past the shard cap is
// carried whole, as before); the whole ledger otherwise.
/**
 * @param {unknown[]} ledger
 * @param {{ ledgerShard: { of: number, total: number }, ledgerItems: unknown[] }[]} shards  shardLedger(ledger)
 * @param {boolean} landed  every shard checkpoint landed in the directory the run asked for, never adopted
 * @returns {{ ledger: unknown[] } | { ledgerInShards: { of: number, total: number } }}
 */
export function ledgerRecordFields(ledger, shards, landed) {
  const first = shards[0]
  const carried = shards.reduce((n, s) => n + s.ledgerItems.length, 0)
  if (!landed || !first || carried !== ledger.length) return { ledger }
  return { ledgerInShards: { of: first.ledgerShard.of, total: first.ledgerShard.total } }
}

// The finalize side: the record to file. A record that carries a ledger, or declares none in shards,
// is returned as it came. Otherwise the ledger is assembled from the shards matching the declaration
// — only when `unusable` is '' (the directory is present, read, and proven this run's own) — the LAST written set
// winning, since this run's shards are the last thing written before its finalize. Complete: the
// declaration is dropped. Short: it stays, with how many shards were seen, and a warning is returned.
/**
 * @param {Record<string, unknown>} record
 * @param {unknown[]} phases  the run directory's checkpoints, in write order
 * @param {string} unusable  why the directory cannot supply the shards, '' when it can
 * @returns {{ record: Record<string, unknown>, warning: string }}
 */
export function ledgerFromShards(record, phases, unusable) {
  const decl = declaredShards(record)
  if (!decl) return { record, warning: '' }
  const rest = { ...record }
  delete rest['ledgerInShards']
  const got = assembleLedgerShards(unusable ? [] : ownShards(phases, decl))
  if (got.complete && got.shardsOf === decl.of && got.total === decl.total) return { record: { ...rest, ledger: got.ledger }, warning: '' }
  const why = unusable ? `but ${unusable}, so the ledger could not be rebuilt` : `${got.shardsSeen} shard(s) with ${got.ledger.length} entr(ies) found`
  return {
    record: { ...rest, ledger: got.ledger, ledgerInShards: { ...decl, seen: got.shardsSeen } },
    warning: `craft-log-run WARNING: the ledger was declared in ${decl.of} shard(s) of ${decl.total} entr(ies), ${why} — record written with the short ledger, which the next round reads as truncated`,
  }
}

// The count the prior-round reader reports beside a stored ledger: its length, or the total a short
// shard set declared when that is larger.
/** @param {Record<string, unknown>} record @param {number} held @returns {number} */
export function ledgerCountOf(record, held) {
  const d = /** @type {{ total?: unknown } | null | undefined} */ (record['ledgerInShards'])
  return Math.max(held, d && typeof d === 'object' ? Number(d.total) || 0 : 0)
}

/** @param {Record<string, unknown>} record @returns {{ of: number, total: number } | null} */
function declaredShards(record) {
  const d = /** @type {{ of?: unknown, total?: unknown } | null | undefined} */ (record['ledgerInShards'])
  if (Array.isArray(record['ledger']) || !d || typeof d !== 'object') return null
  return { of: Number(d.of) || 0, total: Number(d.total) || 0 }
}

// The shard phases written under this declaration, newest first: assembleLedgerShards keeps the first
// writer of an index, so a set left by an earlier write into the same directory loses to this run's.
/** @param {unknown[]} phases @param {{ of: number, total: number }} decl @returns {unknown[]} */
function ownShards(phases, decl) {
  return phases.filter(p => {
    const s = /** @type {{ ledgerShard?: { of?: unknown, total?: unknown } } | null} */ (p && typeof p === 'object' ? p : null)?.ledgerShard
    return !!s && Number(s.of) === decl.of && Number(s.total) === decl.total
  }).reverse()
}
