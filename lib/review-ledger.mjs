// The verdict the record carries and the ledger round N+1 reads (src/review.js, Synthesize phase): the verdict,
// the floor premise re-read, the tombstones, the ledger persisted in shards, then the run record.
import { toolIdentity } from './prior-decision-match.mjs'
import { verdictSuffix } from './review-coverage.mjs'
import { honestVerdict } from './honest-verdict.mjs'
import { summarizeFindings, refuteRate, fingerprint, rereviewVerdict } from './run-record.mjs'
import { LEDGER_SHARD_PHASE, shardLedger, pruneTombstones, tombstoneBudget } from './ledger-shards.mjs'
import { ledgerRecordFields } from './ledger-in-shards.mjs'
import { toLedgerEntry } from './review-ledger-entry.mjs'

/**
 * @typedef {import('./review-schemas.mjs').Finding} Finding
 * @typedef {import('./review-run.mjs').ReviewRun} ReviewRun
 */
/** @typedef {import('./review-run.mjs').ReviewState} ReviewState */

/**
 * The record verdict and whether the verification floor premise held, after the ledger and the record were written.
 * @param {ReviewRun} reviewRun
 * @param {Pick<ReviewState, 'tierLists' | 'dropped' | 'priorRejected' | 'priorRejectedLive' | 'isRereview' | 'adjudicated' | 'savedByFloor' | 'notRun' | 'thisRound' | 'priorFpComparable' | 'priorTombstones' | 'priorDisposition' | 'branch' | 'head' | 'reviewRecord' | 'coverageNotes' | 'results' | 'thinned' | 'sortingRecord' | 'contradictionsRecord'>} state
 */
export async function ledgerPhase(reviewRun, { tierLists, dropped, priorRejected, priorRejectedLive, isRereview, adjudicated, savedByFloor, notRun, thisRound, priorFpComparable, priorTombstones, priorDisposition, branch, head, reviewRecord, coverageNotes, results, thinned, sortingRecord, contradictionsRecord }) {
const { isMaintainability, finalVerdict, strict, limitStop, checkpoint, logRun } = reviewRun
const { log: logLine } = reviewRun.sb
const { confirmed, suspected, unverified } = tierLists
const allReviewFindings = confirmed.concat(suspected, unverified)
// The verification denominator: what verification ACTUALLY judged. `unverified` is deliberately
// absent — including it once made refuteRate incomparable across runs (on one measured run 118 of
// 215 findings were Low/Info, so the denominator was more than double the 89 verdicts really cast).
const totalVerified = confirmed.length + suspected.length + dropped + priorRejected.filter(f => f.priorTier !== 'unverified').length - priorRejectedLive
/** The verdict the record carries: the re-review tracks or the confirmed set, escalated by strict maintainability. */
function decideRecordVerdict() {
  let decided = isRereview
    ? rereviewVerdict({ stillOpen: adjudicated.stillOpen, regressed: adjudicated.regressed, neu: confirmed })
    : finalVerdict(confirmed)
  // Strict-mode maintainability escalation applies to a re-review too (finalVerdict already covers the
  // first-pass path): a Confirmed Medium+ maintainability finding among the live re-review set blocks.
  if (isRereview && strict && [...adjudicated.stillOpen, ...adjudicated.regressed, ...confirmed]
    .some(f => isMaintainability(f) && (f.severity === 'Critical' || f.severity === 'High' || f.severity === 'Medium'))) {
    decided = 'Block'
  }
  return decided
}
const recordVerdict = decideRecordVerdict()
// THE PREMISE OF THE SAVING, CHECKED AGAINST THE VERDICT THAT ACTUALLY CAME OUT. Skipping a Medium
// is legitimate only while "the verdict is already Block" stays true, and that is a claim about a
// moment, not an invariant: the floor is raised during Verify, and a confirmed finding can still
// leave the verdict afterwards — on a re-review `absorbAcross` folds it into a carried (dismissed)
// prior, and carried priors are deliberately excluded from `rereviewVerdict`. The Critical the
// saving rested on then vanishes from the verdict while the unverified Mediums remain unverified,
// and one of them could have been the difference between Approve and Warning.
// So the premise is RE-READ here rather than trusted: if the run did not end at Block, the skip was
// a genuine coverage hole after all, and it converts into exactly what a coverage hole is — a
// `notRun` entry, which a re-run can and should fix. This is the one case where the saving and the
// failure are the same event, told apart only by an outcome that is not known when the skip is made.
const floorPremiseHeld = !savedByFloor.length || recordVerdict === 'Block'
function reportRevokedPremise() {
  if (!floorPremiseHeld) {
    notRun.push(...savedByFloor.map(n => `${n} — AND THE PREMISE DID NOT HOLD: the run ended at ${recordVerdict}, not Block, so the saving rested on a confirmed finding that did not reach the verdict; re-run to check them`))
    logLine(`⚠️ ${savedByFloor.length} verification(s) were skipped because the verdict was already Block, but the run ended at ${recordVerdict} — the skipped findings are reported as a coverage hole, not as a saving`)
  }
}
reportRevokedPremise()
// A usage limit reached after the lens phase (verification, synthesis) still leads notRun before the record.
function noteLateLimit() {
  if (limitStop.seen() && !notRun.includes(limitStop.note())) notRun.unshift(limitStop.note())
}
noteLateLimit()
// Persist the ledger so round N+1 can find round N. On a re-review it grows by FOUR paths, not the
// three that are obvious: (1) the new delta findings; (2) still-open/regressed priors, as 'open';
// (3) dismissed priors still carried, with their disposition; and (4) — easy to miss because it
// enters through (1) — a NEW finding whose only carrier RETIRED this round. partitionAbsorbed keeps
// such a finding rather than absorbing it into a host that will not be persisted, so on a full
// re-scan a dismissal can retire and its own re-discovery re-enter the very same ledger as 'open',
// stripped of the author's disposition. That is deliberate and its cost is argued at the retirement
// comment above (losing a label beats losing a defect) — but it is a path, and an enumeration that
// omits it reads as a guarantee it does not make.
// `resolved` and `retired` priors do not re-enter as LIVE rows — they have been answered and cost no
// further adjudication — but neither do they vanish: each leaves a `disposition:'closed'` tombstone
// (below) so a later round can tell its return from a novelty. Without the carry-forward the ledger
// would otherwise hold only this round's delta, and a finding open across 3+ rounds — or a dismissed
// one — would silently vanish after one hop.

// A tombstone for a resolved/retired prior: the same ledger shape, `disposition:'closed'`, but its
// `why` is a fixed ORIGIN+round marker rather than the original rationale — a tombstone's only job is
// an equality test (the recidivism check on load) plus telling a fixed defect that REGRESSED
// (`resolved`) from a dismissed one that was RE-RAISED (`dismissed`), so it carries the origin and
// the round it closed in, and no prose. The origin lives in `why` (not a new field) so it rides the
// existing ledger shape and the round-marker regex reads both forms unchanged.
// `fp` is RECOMPUTED under THIS round's basis, overriding the `f.fp || fingerprint(f)` toLedgerEntry
// would otherwise carry: a prior LIVE finding loaded from a ledger written under an earlier fingerprint
// basis still carries its stored old-basis `fp`, and if a tombstone minted from it kept that stale
// hash, a later same-basis round would key the recidivism check on the old basis (`t.fp`) while
// looking the returning defect up under the current one (`fingerprint(f)`) — the two never match and
// the regression is missed in silence, the exact class the fingerprint-basis guard removes, only shifted a round
// on. Minting every tombstone under the current basis closes it for BOTH paths (resolved and dismissed);
// an incomparable CARRIED tombstone is dropped at assembly below, never re-minted here.
const toTombstone = (/** @type {Finding} */ f, origin = 'resolved') => {
  // A tombstone's `why` is a fixed ORIGIN+round marker, not a shortened rationale, so it owes no
  // `whyRef` back-pointer — drop the one a carried source finding may bring in, keeping the row bare.
  const entry = toLedgerEntry(f, 'closed', f['tier'])
  delete entry.whyRef
  return { ...entry, fp: fingerprint(f), why: `${origin} in round ${thisRound}` }
}
// The tombstone set is bounded against the border that actually governs the persisted
// ledger: the single-call copy of the FINAL record refuses on the WHOLE ledger (~170 entries), live
// rows AND tombstones together — NOT on tombstones alone. So count the live rows this ledger will carry
// and hand pruneTombstones a `tombstoneBudget` that leaves room for them under that border. Without it
// the set grew monotonically — new tombstones plus every earlier one carried verbatim, a fresh same-fp
// row per recidivist cycle — and, sized against the far looser shard budget, could cross the copy-
// refusal border on tombstones-plus-live and invert the memory into a per-round full rescan. It is
// also DEDUPED by binding (newest per fingerprint and tool identity); the read side above already tolerates a tombstone it no
// longer remembers (it treats the finding as novel), so the cap evicting the oldest rounds is safe.
const liveLedgerCount = confirmed.length + suspected.length +
  unverified.filter(f => !f.ledgerDupOfUnverifiedPrior).length +
  adjudicated.stillOpen.length + adjudicated.regressed.length + adjudicated.carried.length + priorRejected.length
const tombstones = assembleTombstones()
function assembleTombstones() {
  return pruneTombstones([
    ...adjudicated.resolved.map(f => toTombstone(f, 'resolved')),
    ...adjudicated.retired.map(f => toTombstone(f, 'dismissed')),
    // Carried tombstones from an incomparable fingerprint basis are dropped, not carried forward under a
    // stale basis: a clean baseline after a basis change (or a reported loss when the basis verdict did
    // not arrive). This round's own tombstones are minted under the current basis (toTombstone recomputes
    // `fp`, so even a prior loaded under an old basis gets a current-basis hash) and kept regardless.
    ...(priorFpComparable ? priorTombstones : []),
  ], { max: tombstoneBudget(liveLedgerCount), identity: toolIdentity })
}
const reviewLedger = assembleLedger()
function assembleLedger() {
  return isRereview
    ? [
      ...confirmed.map(f => toLedgerEntry(f, 'open', 'confirmed')),
      ...suspected.map(f => toLedgerEntry(f, 'open', 'suspected')),
      // An unverified finding whose carrier is ITSELF an unverified prior writes no second row: see
      // `ledgerDupOfUnverifiedPrior` in lib/review-adjudicate.mjs for why that host and no other.
      ...unverified.filter(f => !f.ledgerDupOfUnverifiedPrior).map(f => toLedgerEntry(f, 'open', 'unverified')),
      ...adjudicated.stillOpen.map(f => toLedgerEntry(f, 'open')),
      ...adjudicated.regressed.map(f => toLedgerEntry(f, 'open')),
      // `adjudicated.resolved`/`adjudicated.retired` no longer leave the ledger silently: each becomes a
      // lightweight TOMBSTONE (`disposition:'closed'`) so a later round can tell the defect's RETURN
      // from a genuine novelty. It is not a live finding — the carve-out on load keeps it out of the
      // adjudicator — and it costs one bare row, not a re-adjudicated one. The set (this round's plus
      // the earlier ones carried forward) is deduped and capped above; each row keeps its own origin+
      // round marker, which is the round the REGRESSION / re-raised note reports.
      ...tombstones,
      ...adjudicated.carried.map(f => toLedgerEntry(f, f['disposition'])),
      ...priorRejected.map(f => toLedgerEntry(f, priorDisposition(f), f.priorTier)),
    ]
    : allReviewFindings.map(f => toLedgerEntry(f, 'open', f.tier || 'suspected')).concat(priorRejected.map(f => toLedgerEntry(f, priorDisposition(f), f.priorTier)))
}
// THE LEDGER IS PERSISTED BEFORE THE RECORD IS ATTEMPTED, in bounded shards, one small checkpoint
// per shard (lib/ledger-shards.mjs carries the measurement and the reasoning). The final record is
// written once, at the end, through a model copying the whole thing in one tool call — the step that
// lost three consecutive runs, the last of them a logger that REFUSED a ~170-entry ledger outright
// rather than risk truncating it. Checkpoints are the step that survived all three. So the ledger
// goes down that path first: if `logRun` below is lost, the next round still reads this round's
// findings out of `.partial` instead of starting over.
//
// Written HERE and not earlier because this is the first moment the ledger exists — it is the
// carry-forward, so it needs the adjudication of the prior round that only just finished.
//
// And once every shard has landed in the run's own directory, the record leaves the ledger to them:
// the one copy that kept being interrupted no longer carries the largest array, and finalize rebuilds
// it from the shards (realm @nick/craft, node #245). A directory that may have been adopted — a
// rejoin was armed — is not the run's own, so the record then carries the whole ledger as before.
async function persistLedgerShards() {
  const shards = shardLedger(reviewLedger)
  let landed = true
  for (const shard of shards) {
    landed = (await checkpoint(`${LEDGER_SHARD_PHASE}-${String(shard.ledgerShard.index).padStart(2, '0')}`, { branch, head, ...shard }, 'Synthesize')) && landed
  }
  return ledgerRecordFields(reviewLedger, shards, landed && !reviewRun.rejoinArmed)
}
const ledgerFields = await persistLedgerShards()
await logRun(reviewRecord({
  verdict: honestVerdict(recordVerdict + verdictSuffix({ notRun, coverageNotes, floorPremiseHeld }), notRun),
  savedByFloor,
  // Recorded as its own field, not inferred from the two lists: "the saving was legitimate" and
  // "the saving turned into a hole" are the question any later count of this economy has to ask
  // first, and deriving it from string shapes would break the moment a string is reworded.
  savedByFloorPremiseHeld: floorPremiseHeld,
  round: thisRound,
  findings: summarizeFindings(allReviewFindings),
  ...ledgerFields,
  // crateScope's contract and seam passes get rows of their own (realm @nick/craft, #327, #321); off, none.
  dimensions: results.flatMap(r => [...r['plan'].lenses, ...(r.crateLenses || [])].map((/** @type {string} */ l) => {
    const s = summarizeFindings(r['confirmed'].filter((/** @type {Finding} */ f) => (f['source'] || '') === l))
    const confirmedCount = r['confirmed'].filter((/** @type {Finding} */ f) => (f['source'] || '') === l).length
    const suspectedCount = r['suspected'].filter((/** @type {Finding} */ f) => (f['source'] || '') === l).length
    const unverifiedCount = (r['unverified'] || []).filter((/** @type {Finding} */ f) => (f['source'] || '') === l).length
    const refutedCount = (r['refuted'] || []).filter((/** @type {Finding} */ f) => (f['source'] || '') === l).length
    // `ran` distinguishes "executed and found nothing" from "never returned". Both otherwise render
    // as a 0-finding row, and the yield analysis would read a broken lens as a redundant one.
    // Absent `ranLenses` (a record written before this landed) → assume it ran, the old behaviour.
    const ran = r.ranLenses ? r.ranLenses.includes(l) : true
    return { dimension: `${r.profile.id}:${l}`, ran, verdict: '', findingCount: s.total, bySeverity: s.bySeverity, confirmedCount, suspectedCount, refutedCount, unverifiedCount }
  })),
  verification: { candidates: totalVerified, confirmed: confirmed.length, refuteRate: refuteRate(dropped, totalVerified), unverified: unverified.length, thinned },
  // The sorting before publication, with `comment` only (realm @nick/craft, node #270).
  sorting: sortingRecord(),
  // The findings going against memory, sorted to the defects before any doubt sign (realm @nick/craft, node #282).
  memoryContradictions: contradictionsRecord(),
  notRun,
}))
return { recordVerdict, floorPremiseHeld }
}
