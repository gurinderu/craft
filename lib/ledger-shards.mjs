// The finding LEDGER, persisted in bounded shards so it survives the loss of the final record.
//
// The writer was the retired JS review engine; what stays is the reading side, for the shards its runs left in
// the store (lib/craft-log-run.mjs, lib/ledger-in-shards.mjs) and the payload measure record parts share.
//
// WHY THIS EXISTS. lib/loop-state.mjs made a lost record stop costing the KNOWLEDGE that a round
// happened. It did not make it stop costing the round's LEDGER — and the ledger is the re-review
// loop's actual memory: it is what the next round adjudicates against (still open / resolved /
// regressed), so without it every round re-discovers the same defects and re-verifies what was
// already dismissed. Measured on the live store: three consecutive review runs filed no record at
// all (a network error; a 196KB logger payload; and a 131-agent/87-minute run whose logger REFUSED,
// saying in so many words that it could not reproduce a ~170-entry ledger plus a 14-element
// dimensions array without risking truncation inside one tool call). Every one of those three lost
// exactly the ledger.
//
// THE FAILURE IS SIZE, AND THE SIZE IS THE PART THAT CROSSES A MODEL. A workflow script is
// sandboxed with no filesystem, so the only way anything reaches disk is an agent copying a heredoc.
// That copy is the fragile step, and its fragility scales with the payload: at ~200KB the model
// either truncates silently (measured once: `findings: 111` filed with `dimensions: []`) or, on the
// better day, refuses. So MOVING the same 100KB into a checkpoint would reproduce the same failure
// one phase earlier. What has to shrink is not the total but the volume per tool call.
//
// THE DEVICE. The ledger is cut into shards of at most LEDGER_SHARD_MAX_BYTES of JSON and each
// shard is written as its own phase checkpoint — one small, independent, already-proven write per
// call. The checkpoint path is the one that survived: all three lost runs left their phase
// checkpoints intact, and `~/.craft/runs/.partial` carries dozens of directories that kept them.
// Bounding by BYTES rather than by entry count is deliberate: a `why` field runs to 500 characters
// and entry sizes differ by an order of magnitude, so a fixed entry count re-admits the unbounded
// payload it was supposed to remove. The bytes counted are the ones the PROMPT carries — see
// `payloadBytes`; counting the compact form understated the real step by up to 1.7x.
//
// A PARTIAL CARRY MUST NOT READ AS A FULL ONE. Shards are independent writes, so some can land and
// others not — and a ledger that lost a third of its entries, presented as complete, is exactly the
// defect this whole store exists to catch: incomplete served as complete. So every shard declares
// `of` (how many there are) and `total` (how many entries the round had). The reader assembles what
// is present and reports the declared total ALONGSIDE it; the engine's existing loud path does the
// rest — `ledgerTruncated` in src/review.js fires when the authoritative count and the array
// length disagree, which forces a full base...HEAD re-scan and logs the break. Nothing new has to
// be rendered: a shortfall of shards is the same fact as a truncated array, and is reported by the
// same words.

// MEASURE WHAT IS ACTUALLY COPIED, not the compact form. The checkpoint payload reaches the agent
// as `JSON.stringify(payload, null, 2)` (lib/run-logging.mjs), so an entry sitting in `ledgerItems`
// is pretty-printed at depth two: every one of its own lines gains four spaces. Compact bytes
// therefore understate the real payload by 1.2x on long `why` fields and up to 1.7x on short
// entries carrying a `sources` array — a nested array under pretty-print spreads one line per
// element. Three independent measurements agree on the understatement and DISAGREE on whether any
// shape crosses the 24KB line at which the write path stops trusting the cheap model: sweeps put
// short entries with three sources at 24859B (over it) and at 22426B (under it, ratio 1.57), and a
// cold read reported 14265B compact becoming 17314B. So the ratio is established and the crossing
// is fixture-dependent — no run has been observed crossing it. The bound itself does not move; it
// never had to. The measure was simply not measuring the thing that is paid for.
// `measure` sizes the pretty text: its length here; a record's parts pass a UTF-8 byte count (lib/record-parts.mjs).
/**
 * @param {unknown} item
 * @param {(text: string) => number} [measure]
 * @returns {number}
 */
export function payloadBytes(item, measure = text => text.length) {
  const pretty = JSON.stringify(item, null, 2)
  if (typeof pretty !== 'string') return 2
  // +4 per line for the two levels of nesting, +2 for the separating comma and newline.
  return measure(pretty) + pretty.split('\n').length * 4 + 2
}

// Reassemble the shards a surviving checkpoint directory kept. `phases` is `readCheckpoints(dir)`.
//
// Returns:
//   ledger     — the entries recovered, in shard order
//   total      — the entry count the round DECLARED (0 when the directory carries no shards at all)
//   shardsOf   — how many shards the round said it wrote (0 when none)
//   shardsSeen — how many distinct shard indexes were found
//   complete   — every declared shard present AND the recovered count matches the declared total
//
// A directory written before this existed carries no `ledgerShard` phase at all: it comes back
// `{ledger: [], total: 0, shardsOf: 0, complete: false}`, which is indistinguishable from the
// pre-existing "no ledger survived" answer — so every `.partial` already in the store keeps reading
// exactly as it did, with no migration and no operator action.
/**
 * @param {unknown} phases
 * @returns {{ ledger: object[], total: number, shardsOf: number, shardsSeen: number, complete: boolean }}
 */
export function assembleLedgerShards(phases) {
  /** @type {Map<number, object[]>} */
  const byIndex = new Map()
  let of = 0
  let total = 0
  for (const p of (Array.isArray(phases) ? phases : [])) {
    const shard = readLedgerShard(p)
    if (!shard) continue
    // The largest declaration wins. A run can only ever write ONE set of shards, so a disagreement
    // means a slice was written by a different build or is corrupt; taking the maximum errs toward
    // reporting a shortfall, which is the loud direction.
    of = Math.max(of, shard.of, shard.index)
    total = Math.max(total, shard.total)
    // First writer of an index wins: a duplicate index cannot be reconciled, and counting both
    // would inflate the recovered count until it matched `total` by accident.
    if (byIndex.has(shard.index)) continue
    byIndex.set(shard.index, shard.items())
  }
  if (!byIndex.size) return { ledger: [], total: 0, shardsOf: 0, shardsSeen: 0, complete: false }
  const ledger = [...byIndex.keys()].sort((a, b) => a - b).flatMap(k => /** @type {object[]} */ (byIndex.get(k)))
  const allPresent = of > 0 && byIndex.size === of && [...byIndex.keys()].every(k => k <= of)
  return {
    ledger,
    // Never below what we actually hold: a corrupt `total` smaller than the recovered array would
    // otherwise make a complete ledger look over-full and land in no branch at all.
    total: Math.max(total, ledger.length),
    shardsOf: of,
    shardsSeen: byIndex.size,
    complete: allPresent && total === ledger.length,
  }
}

// One checkpoint phase read as a ledger shard: its index (an integer from 1), its declared shard count
// and round total (0 when absent or not a number), and its object entries (read on demand); null when
// the phase is not a shard.
/**
 * @param {unknown} p
 * @returns {{ index: number, of: number, total: number, items: () => object[] } | null}
 */
function readLedgerShard(p) {
  const phase = /** @type {{ ledgerShard?: unknown, ledgerItems?: unknown }} */ (p && typeof p === 'object' ? p : {})
  const s = /** @type {{ index?: unknown, of?: unknown, total?: unknown } | null | undefined} */ (phase.ledgerShard)
  if (!s || typeof s !== 'object') return null
  const index = Number(s.index)
  if (!Number.isInteger(index) || index < 1) return null
  const items = phase.ledgerItems
  return {
    index,
    of: Number(s.of) || 0,
    total: Number(s.total) || 0,
    items: () => Array.isArray(items) ? items.filter((/** @type {object} */ x) => x && typeof x === 'object') : [],
  }
}
