// Whether this round may compare fingerprints with the prior one, and what the lenses diff against
// (src/review.js, Scout phase): the round number, the fingerprint-basis verdict and the re-scan guards.
import { basisVerdictFromRevisions } from './run-record.mjs'
import { flattenField } from './prompt-fields.mjs'
import { ledgerDegraded, shouldFullRescan } from './rescan-guards.mjs'

/**
 * @typedef {import('./review-schemas.mjs').PriorRoundAnswer} PriorRound
 * @typedef {import('./review-run.mjs').ReviewRun} ReviewRun
 */

/**
 * The round's basis and lens scope.
 * @param {ReviewRun} reviewRun @param {{ priorRound: PriorRound | null, baseRef: string }} prior  the prior round and the diff base
 */
export function priorBasisPhase(reviewRun, { priorRound, baseRef }) {
const { fullEvery } = reviewRun
const { log: logLine } = reviewRun.sb
// Re-review coverage guards (see ledgerDegraded / shouldFullRescan). thisRound is the round number we
// are about to record; reused for the record below.
//
// CONCURRENCY ASSUMPTION, STATED RATHER THAN LOCKED. Deriving the round is a read-modify-append on the
// shared per-(project,branch) store with no lock: this run read the latest prior round above and will
// append round `thisRound`. It assumes no OTHER non-nested review of this same (project,branch) is
// advancing the chain at the same time. The engine's own only source of same-branch concurrency —
// `rust-audit`'s per-crate fan-out — is already excluded from the chain on both ends (`nested` rows are
// skipped as candidates in selectPriorRounds and as readers above), so what remains is an EXTERNAL act:
// two top-level reviews of one branch dispatched at once. That is outside the engine's serialization
// contract, and deliberately not guarded here — a per-branch lock is disproportionate to the cost. If
// it does happen, both compute the same `thisRound` and both append; selection then takes the later ts
// and the loser's ledger is orphaned. Live findings recover on the next full rescan; the one casualty
// with no recovery path is the loser's monotonic tombstone set. This is an accepted, bounded loss, not
// corruption — recorded here so the next reader meets the assumption before the store, not after.
const thisRound = roundNumber()
function roundNumber() {
  return priorRound ? (priorRound['round'] || 1) + 1 : 1
}
// The prior round's finding fingerprints are comparable to this round's
// only when both were fingerprinted under the same basis (FP_BASIS_SINCE in lib/run-record.mjs — a
// separate question from the engine revision, so a telemetry-only bump keeps it; realm @nick/craft
// #108). The ENGINE decides it (below) from the raw revisions the loader hands over; the loader's own
// `sameFpBasis` is only the fallback for a loader older than that field. Only an explicit "same basis"
// is comparable; anything that is not established fails closed. When it is a known different basis —
// the first re-review after a fingerprint-basis change — the tombstone recidivism check is skipped for
// that one transition rather than comparing hashes across incompatible bases and missing a regression
// silently (see the recidivism block and the tombstone assembly; the memory rebuilds from this round on).
// The basis verdict is decided HERE, by the engine that computes the fingerprints, with the table
// of lib/run-record.mjs (realm @nick/craft #111): from the raw revisions the loader hands over. A loader that
// predates that field still sends its own verdict, and that is used then.
// The relayed array crosses a model; the loader prints the same list as a string next to it
// (`priorFpRevisionsCheck`). The engine trusts the array only when the two still match — an invented []
// or a truncated or swapped list does not — and otherwise fails closed, reporting a transport loss
// (priorBasisMismatch). When the array arrived intact, THIS engine's table decides, whatever the
// logger's own table said (realm @nick/craft #111).
const relayedVerdict = relayedVerdictOf()
function relayedVerdictOf() {
  return priorRound && typeof priorRound['sameFpBasis'] === 'boolean'
    ? { sameFpBasis: priorRound['sameFpBasis'], fpBasisKnown: priorRound['fpBasisKnown'] } : null
}
const relayedRevisions = relayedRevisionsOf()
function relayedRevisionsOf() {
  return priorRound && Array.isArray(priorRound['priorFpRevisions']) ? priorRound['priorFpRevisions'] : null
}
const relayedCheck = relayedCheckOf()
function relayedCheckOf() {
  return priorRound && typeof priorRound['priorFpRevisionsCheck'] === 'string' ? priorRound['priorFpRevisionsCheck'] : null
}
// A new loader prints BOTH fields on every path; an older one prints neither. So: an array whose check
// no longer matches, or a check with no array, is a transport loss. An EMPTY array whose '' check the
// relay dropped is not — that is an honest "nothing established", and the absent check reads as ''.
const priorBasisMismatch = basisMismatchOf()
function basisMismatchOf() {
  return !!priorRound && (relayedRevisions
    ? (relayedCheck ?? (relayedRevisions.length ? null : '')) !== relayedRevisions.join(',')
    : relayedCheck !== null)
}
const engineFromRevisions = engineBasisOf()
function engineBasisOf() {
  return !priorBasisMismatch && relayedRevisions ? basisVerdictFromRevisions(relayedRevisions) : null
}
// Where the engine's verdict departs from the logger's own, the engine wins (it computes the
// fingerprints) — said in the log and on the record, so skew between the two tables can be counted.
const basisOverridesLogger = basisOverridesLoggerOf()
function basisOverridesLoggerOf() {
  return !!(engineFromRevisions && relayedVerdict
    && (engineFromRevisions.sameFpBasis !== relayedVerdict.sameFpBasis || engineFromRevisions.fpBasisKnown !== relayedVerdict.fpBasisKnown))
}
function logBasisRelay() {
  if (priorBasisMismatch) logLine(`⚠️ prior-round revisions arrived altered (list ${JSON.stringify(relayedRevisions)}, check ${JSON.stringify(relayedCheck)}) — the fingerprint basis is treated as unknown`)
  if (basisOverridesLogger) logLine(`Re-review: this engine's fingerprint-basis verdict on revisions ${JSON.stringify(relayedRevisions)} (${JSON.stringify(engineFromRevisions)}) overrides the logger's (${JSON.stringify(relayedVerdict)}) — their tables differ`)
}
logBasisRelay()
const priorBasis = priorBasisOf()
function priorBasisOf() {
  return !priorRound ? null
    : priorBasisMismatch ? { sameFpBasis: false, fpBasisKnown: false }
      : engineFromRevisions || relayedVerdict
}
const priorFpComparable = fpComparableOf()
function fpComparableOf() {
  return priorBasis ? priorBasis.sameFpBasis === true : false
}
// What the basis verdict actually was, and how many carried tombstones it cost — on the run record, so
// whether a revision bump kept every loop's memory (realm @nick/craft #108) is measurable from the
// store rather than only readable in one run's log. Set where the tombstones are dropped.
// 'unknown' is a verdict of its own: the loader answered "not comparable" without establishing that
// the prior's basis is a KNOWN different one (a recovered round whose checkpoints do not attest to one
// known basis, an unreadable round, a record it cannot place, or an answer whose fpBasisKnown was not
// carried) — not a basis change, and reported as lost memory
// (realm @nick/craft #110). Only an explicit fpBasisKnown: true makes "not comparable" a basis change.
const priorBasisVerdict = basisVerdictOf()
function basisVerdictOf() {
  return !priorBasis ? 'absent'
    : (priorBasis.sameFpBasis === false && priorBasis.fpBasisKnown !== true) ? 'unknown'
      : priorBasis.sameFpBasis
}
const priorLedgerDegraded = ledgerDegraded(priorRound)
function warnLedgerDegraded() {
  if (priorLedgerDegraded) {
    logLine(`⚠️ Re-review DEGRADED: prior round ${/** @type {PriorRound} */ (priorRound)['round']} reported ${/** @type {PriorRound} */ (priorRound)['priorFindings']} finding(s) but persisted NO ledger — the adjudicate track has nothing to carry or re-verify. Forcing a full base...HEAD re-scan this round; if results still look thin, re-run with {fresh:true}.`)
  }
}
warnLedgerDegraded()
// Distinct from `priorLedgerDegraded`: the ledger itself is fine here, but a journal-reconstructed
// round's `head` is the commit the DEAD run stalled on, which the operator typically re-runs against
// BEFORE making any fix — so it can equal the current HEAD and a delta scan would review nothing.
const priorRoundJournalSourced = journalSourcedOf()
function journalSourcedOf() {
  return Boolean(priorRound?.['journalSourced'])
}
function warnJournalSourced() {
  if (priorRoundJournalSourced) {
    logLine(`⚠️ Re-review round reconstructed from what a STOPPED run left behind (its journal, or its surviving phase checkpoints): prior round ${/** @type {PriorRound} */ (priorRound)['round']}'s head ${flattenField(/** @type {PriorRound} */ (priorRound)['head'])} is where that run stopped, not a completed round's head — it may equal this run's HEAD if no fix landed yet. Forcing a full base...HEAD re-scan this round rather than risk an empty head...HEAD diff.`)
  }
}
warnJournalSourced()
const fullRescan = shouldFullRescan({ priorRound, thisRound, fullEvery, degraded: priorLedgerDegraded, journalSourced: priorRoundJournalSourced })
// On a re-review the lenses look only at the fix commits (prevHead...HEAD) — cheap, and it catches
// regressions the fixes introduced. But every `fullEvery`-th round (and whenever the prior ledger is
// degraded, or the prior round came from a stalled run's journal) we widen back to the FULL
// base...HEAD diff so a defect an earlier round missed in code it never touched is re-discovered.
// `fresh` (priorRound=null) always keeps the full base...HEAD scan.
const lensBase = lensScope()
// The base the lenses diff against, logged on a re-review with whether this round is a full re-scan.
function lensScope() {
  const scopeBase = (priorRound && !fullRescan) ? priorRound.head : baseRef
  if (priorRound) {
    logLine(`Re-review round ${thisRound} lens scope: ${fullRescan
      ? `FULL base...HEAD re-scan (fullEvery=${fullEvery}${priorLedgerDegraded ? ', ledger degraded' : ''}${priorRoundJournalSourced ? ', prior round journal-sourced' : ''}) — earlier misses in untouched code are re-checked`
      : `incremental delta ${flattenField(priorRound['head'])}...HEAD (fix commits only)`}`)
  }
  return scopeBase
}
return { thisRound, priorBasisMismatch, basisOverridesLogger, priorFpComparable, priorBasisVerdict, priorLedgerDegraded, priorRoundJournalSourced, fullRescan, lensBase }
}
