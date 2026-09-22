// The round chain as LOOP STATE, kept apart from the telemetry it used to ride on.
//
// WHY THIS EXISTS. `~/.craft/runs` serves two things whose tolerance for loss is opposite. As
// TELEMETRY (what a run cost, what each lens yielded, the refutation share) a lost record is a
// blemish: the statistics get thinner. As the re-review LOOP'S STATE (the finding ledger, the round
// number, the tie to a branch) a lost record breaks the chain — the next round re-opens what is
// already standing on re-verification — and it breaks it SILENTLY: `found:false` renders as a first
// review, indistinguishable from a genuine one.
//
// Silence is the defect, not the loss. The loss is measured and ordinary: two consecutive runs left
// no record at all, one on a network error and one on a 196KB logger payload, and `~/.craft/runs`
// carries 57 unfinalized `.partial` directories at the time of writing — every one of them a round
// that happened and filed nothing.
//
// Two rules follow, and this module is only those two rules:
//
//  1. WHAT SURVIVED STILL COUNTS. A run writes its final record once, at the end, through a model —
//     the fragile path. It writes phase checkpoints as it goes, small and directly — the path that
//     survived in all 57 cases. So a chain is read from the checkpoints too, not from the record
//     alone: a lost record costs the round's LEDGER, it must not cost the knowledge that the round
//     happened.
//  2. A BROKEN CHAIN IS NEVER A FIRST ROUND. Whenever anything PROVES a round happened — an index
//     row whose detail file is corrupt or gone, a surviving checkpoint directory — the answer is a
//     DEGRADED round (its number, its head, an empty ledger), never `found:false`. The engine
//     already has the loud path for that shape: an empty ledger beside a non-zero prior finding
//     count is what `ledgerDegraded` in workflows/review.js reads, and it logs the break and forces
//     a full base...HEAD re-scan. Reporting `found:false` instead is what routes the same facts into
//     "First review for this branch".
//
// This module holds the DECISION only, so it can be executed in a test. The store walk that feeds
// it lives in craft-log-run.mjs beside the other readers.

// An index row that names a round but whose detail record could not be materialized PROVES the round
// happened — the record is corrupt, removed or truncated, not absent. Distinct from `ancestry-rejected`
// (a rebase genuinely took that history away) and `no-candidate-rows` (nothing was ever reviewed).
export const ROUND_PROVING_REJECTIONS = ['detail-unreadable', 'partial-only']

// The two proving rejections are NOT the same kind, and merging them cost the loudness this module
// exists for. What separates them is whose head the round carries.
//
//   detail-unreadable — the index row belongs to a round that FINISHED; only its detail file is
//                       damaged. Its head is a completed head, so an incremental delta off it is
//                       legitimate and the engine may take it.
//   partial-only      — the record is a run that STOPPED. Its head is where the run halted, and the
//                       operator's ordinary next move after a stall is to re-run on the SAME commit
//                       before any fix. Then head...HEAD is EMPTY and the run reads its own stopping
//                       point as a full incremental round: zero lenses over the diff, reported as an
//                       ordinary re-review. Worse than trunk, which answered "no prior round" here
//                       and therefore re-scanned base...HEAD in full.
//
// So a stopped run must carry the flag the engine already reads as "do not diff off this head"
// (realm @nick/craft, node #76).
export const STOPPED_RUN_REJECTIONS = ['partial-only']

export function headFromStoppedRun(reason) {
  return STOPPED_RUN_REJECTIONS.includes(String(reason || ''))
}

export function provesRound(reason) {
  return ROUND_PROVING_REJECTIONS.includes(String(reason || ''))
}

function num(v) {
  const n = Number(v)
  return Number.isFinite(n) ? Math.trunc(n) : 0
}

// Reconcile the three things that can know about this chain into one answer.
//
//   complete   — the round findPriorRound materialized from the index in full (ledger and all), or null
//   completeAt — that round's timestamp in ms, kept OUT of `complete` itself: the object is returned
//                verbatim to the workflow, whose schema is `additionalProperties: false`
//   proven   — {round, head, findingsTotal} of a row that proves a round happened but could not be
//              materialized, or null
//   evidence — {at, head, findingsTotal} of the newest surviving checkpoint directory for this chain
//              whose head this caller has already ancestry-checked, or null
//
// Returns a prior-round shaped object, or null when nothing knows anything — the only case that may
// still render as a first review.
export function reconcileChain({ complete = null, completeAt = NaN, proven = null, evidence = null } = {}) {
  // A checkpoint directory NEWER than the newest complete round is a round that ran and filed no
  // record. Its number is the complete round's plus one — the dead run read the same chain we just
  // did and numbered itself the same way. Its ledger is gone, so we carry the newest ledger we DO
  // have; the finding count comes from the dead run's own checkpoints, which is what makes the loss
  // legible downstream rather than merely survivable.
  //
  // TRADE-OFF, stated plainly: nothing in the store tells a dead run's directory from a LIVE
  // neighbour's — a concurrent review of the same repository and branch (rust-audit's per-crate
  // fan-out is exactly that) leaves an indistinguishable one. Counting it costs a round number one
  // too high and a full re-scan; not counting it costs the silent chain break this file exists to
  // remove. The expensive direction is the safe one, so evidence counts.
  if (evidence && (!complete || num(evidence.at) > num(completeAt))) {
    // THE DEAD ROUND'S OWN LEDGER, when it sharded one into its checkpoints (lib/ledger-shards.mjs).
    // That is the whole point of the shards: the surviving directory now carries the round's memory,
    // not merely the fact of it, so the next round adjudicates against what the dead run actually
    // found instead of re-discovering it.
    //
    // WHEN IT SHARDED NOTHING THE LEDGER IS EMPTY, and that is a change of rule, not a shortcut.
    // The older behaviour carried the newest COMPLETE round's ledger here — someone else's memory,
    // attributed to this round. It cost the loudness this whole module exists for: an empty ledger
    // beside a non-zero prior count is the ONLY shape `ledgerDegraded` in workflows/review.js reads,
    // so borrowing a non-empty ledger made the degraded round report as a healthy one, with the
    // prior findings count taken from the DEAD run beside a ledger from an older round. Shards
    // narrow that path (an early death, or a directory written before shards existed) but do not
    // close it, so the rule closes it: a round carries its own ledger or none.
    //
    // `ledgerCount` is the AUTHORITATIVE count and is deliberately not recomputed from the array:
    // shards are independent writes, so some can land and others not, and the count the dead run
    // declared is the only thing that makes a shortfall visible. When it exceeds the array,
    // `ledgerTruncated` in workflows/review.js reads exactly that — a partial carry is reported by
    // the same loud words as a model-truncated one, and forces a full base...HEAD re-scan. A
    // complete carry has the two numbers agree and reads as a complete round, which it is.
    const sharded = Array.isArray(evidence.ledger) && evidence.ledger.length ? evidence.ledger : null
    const ledger = sharded || []
    return {
      found: true,
      round: num(complete?.round) + 1 || 1,
      head: String(evidence.head || complete?.head || ''),
      ledger,
      ledgerCount: sharded ? Math.max(num(evidence.ledgerTotal), sharded.length) : 0,
      priorFindings: num(evidence.findingsTotal) || num(complete?.priorFindings),
      // `journalSourced` is the flag the engine ALREADY reads as "this head belongs to a run that
      // stopped, it may equal the caller's current HEAD, so do not diff off it — re-scan the full
      // base...HEAD" (shouldFullRescan). That is this branch's situation exactly: the head comes
      // from a dead run's checkpoints, and the operator's ordinary next move is to re-run on the
      // same commit before any fix, which makes head...HEAD EMPTY. Left false, the round rendered
      // as an ordinary incremental re-review over an empty delta — a blind review reported as a
      // normal one, which is the failure the module header names. Its name says journal; its
      // meaning is "reconstructed from what a stopped run left behind", and checkpoints are that.
      journalSourced: true,
      // The fp basis is revision-scoped, so the recidivism/tombstone check compares stored fingerprints
      // to freshly computed ones ONLY within one engine revision. The complete branch has the record and
      // computes this (craft-log-run.mjs), but a checkpoint directory stamps no engine revision — the
      // engine never writes one, only the final-record script does — so an evidence-recovered round
      // CANNOT establish comparability. `=== true` forces it false (not omit): the guard then skips the
      // check across this recovery rather than comparing incomparable bases and missing a regression in
      // silence — the same failure the guard removes on the ordinary path, closed here too. Forward-
      // compatible: if a caller ever supplies it, it flows through.
      sameEngineRevision: evidence.sameEngineRevision === true,
      reason: '',
    }
  }
  if (complete) return complete
  if (proven) {
    // Shards recovered from the record itself, when `recover` already consumed the directory.
    const sharded = Array.isArray(proven.ledger) && proven.ledger.length ? proven.ledger : null
    return {
      found: true,
      round: num(proven.round) || 1,
      head: String(proven.head || ''),
      ledger: sharded || [],
      ledgerCount: sharded ? Math.max(num(proven.ledgerTotal), sharded.length) : 0,
      priorFindings: num(proven.findingsTotal),
      journalSourced: headFromStoppedRun(proven.reason),
      // As on the evidence branch: revision comparability, defaulted false when the caller could not
      // establish it. A partial-only recovery still has the record, so craft-log-run.mjs computes it
      // from `rec.engineRevision`; a detail-unreadable one has only the index row, which carries no
      // revision, so it arrives false. Either way the guard acts on the recovery path.
      sameEngineRevision: proven.sameEngineRevision === true,
      reason: '',
    }
  }
  return null
}
