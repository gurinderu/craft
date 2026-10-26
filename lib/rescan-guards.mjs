// When a re-review of the review engine (src/review.js) must re-scan the whole base...HEAD diff rather than the fix
// delta: the guards on the prior round the loader carried in.

/** @typedef {import('./review-schemas.mjs').PriorRoundAnswer} PriorRound  the loaded prior round (loader agent output) */

// A re-review scans lenses only over the fix delta (prevHead...HEAD) by default — cheap, but a defect
// in code an intermediate round did not touch is never re-scanned; only the carried ledger keeps it
// alive. Two pure guards close the resulting coverage holes (see the runtime use sites):
//   ledgerDegraded — the prior round reported findings but persisted NO ledger (an older craft run, or
//     one that failed to write one). The adjudicate track then has nothing to carry and the re-review
//     silently degrades to a near-first-pass. Detect it to warn AND force a full re-scan.
//   shouldFullRescan — every `fullEvery`-th re-review (and always when the ledger is degraded, or on a
//     first review) re-scans the FULL base...HEAD diff so an earlier miss in untouched code resurfaces.
//     fullEvery<=0 disables the periodic full scan (pure incremental).
//   ledgerTruncated — the ledger crosses an agent boundary as structured output. The loader script
//     prints an authoritative `ledgerCount` beside it; if the array that arrived is a different
//     length, entries were lost in transport and an 82-entry round would otherwise be carried as a
//     genuine 20-entry one. Degraded → full re-scan, same as a missing ledger.
/** @param {PriorRound | null} priorRoundIn */
export function ledgerTruncated(priorRoundIn) {
  if (!priorRoundIn) return false
  const count = Number(priorRoundIn['ledgerCount'])
  if (!Number.isFinite(count)) return false   // a record from before the count existed: nothing to check
  return count !== (Array.isArray(priorRoundIn['ledger']) ? priorRoundIn['ledger'].length : 0)
}

/** @param {PriorRound | null} priorRoundIn */
export function ledgerDegraded(priorRoundIn) {
  if (!priorRoundIn) return false
  if (ledgerTruncated(priorRoundIn)) return true
  const findings = Number(priorRoundIn['priorFindings'] || 0)
  const ledgerLen = Array.isArray(priorRoundIn['ledger']) ? priorRoundIn['ledger'].length : 0
  return findings > 0 && ledgerLen === 0
}

/** @param {{ priorRound: PriorRound | null, thisRound: number, fullEvery: number, degraded: boolean, journalSourced: boolean }} args */
export function shouldFullRescan({ priorRound: priorRoundIn, thisRound: thisRoundIn, fullEvery: fullEveryIn, degraded, journalSourced }) {
  if (!priorRoundIn) return true            // a first review is already a full base...HEAD scan
  if (degraded) return true               // nothing to carry — a delta-only scan would review almost nothing
  // Kept as its own condition rather than folded into `degraded`: the two are genuinely different
  // failures. `degraded` means the carried ledger is untrustworthy or missing; a journal-sourced
  // round's ledger is fine — the problem is its `head`, which is the commit the DEAD run stalled on.
  // The operator's natural move after a stall is to re-run on that SAME commit before making any
  // fix, so `priorRound.head` can equal the caller's current HEAD; a delta scan of head...HEAD would
  // then be empty rather than incremental, silently trading a full review for a blind one.
  if (journalSourced) return true
  const n = Number(fullEveryIn)
  if (!Number.isFinite(n) || n < 1) return false
  return Number(thisRoundIn) % n === 0
}
