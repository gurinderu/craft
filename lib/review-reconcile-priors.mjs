// A re-review's new findings against the prior round (src/review.js, Adjudicate phase): absorbed into the live
// prior they repeat, unverified ones marked where a prior tracks them, and returning defects flagged against tombstones.
import { toolDistinct } from './prior-decision-match.mjs'
import { absorbAcross, markTrackedUnverified } from './review-adjudicate.mjs'
import { fingerprint, matchesPrior } from './run-record.mjs'
import { tombstoneRound } from './ledger-shards.mjs'

/**
 * @typedef {import('./review-schemas.mjs').Finding} Finding
 * @typedef {import('./review-schemas.mjs').LedgerAnswer} LedgerAnswer
 * @typedef {import('./review-run.mjs').ReviewRun} ReviewRun
 */
/** @typedef {import('./review-run.mjs').ReviewState} ReviewState */

/**
 * The tiers after absorption and tracking, and how many carried tombstones an incomparable basis dropped.
 * @param {ReviewRun} reviewRun
 * @param {Pick<ReviewState, 'tierLists' | 'priorBasisMismatch' | 'priorRound' | 'priorTombstones' | 'priorBasisVerdict' | 'adjudicated' | 'priorFpComparable'>} state
 */
export function reconcilePhase(reviewRun, { tierLists, priorBasisMismatch, priorRound, priorTombstones, priorBasisVerdict, adjudicated, priorFpComparable }) {
const { log: logLine } = reviewRun.sb
let { confirmed, suspected, unverified } = tierLists
let tombstonesDroppedForBasis = 0
// On a re-review, lenses can re-surface a finding that is already tracked on the adjudicate track —
// always on a full re-scan (the lenses saw the whole diff), and even on the delta path when a fix
// commit touches a still-open site. A new finding already carried by a still-LIVE prior
// (still-open/regressed/carried/retired) is ABSORBED into that prior rather than listed separately,
// so it is not double-counted in the report or appended to the persisted ledger — the append is what
// made the carried set, and therefore the per-round adjudicator bill, grow every round.
// ABSORBED IS NOT DISCARDED: the finding is recorded onto its host's `why` (absorbInto), a persisted
// ledger field, so it outlives the round the host RESOLVES and leaves the ledger — the failure mode
// the old comment named as future and which was in fact already live. The match is file+ruleId
// (findCarrier); the reasoning for that coarseness is in lib/review-adjudicate.mjs. matchesPrior is
// the fallback for a finding with no ruleId to key on.
// Do NOT dedup against RESOLVED priors: a new finding matching a resolved one is a regression signal
// and must survive.
/** The judged tracks' findings absorbed into the still-live priors they repeat. @param {Finding[]} livePriors @param {Set<Finding>} retired */
function absorbIntoLivePriors(livePriors, retired) {
  // A RETIRED host absorbs NOTHING — it is not persisted, so a clause on it would leave the
  // absorbed report in no report and no ledger. partitionAbsorbed keeps those findings instead;
  // the reasoning (and why the granularity mismatch makes this the loss class the design set out
  // to close) is in lib/review-adjudicate.mjs.
  // ONE threaded accumulation across both tracks, not two independent ones: the tracks share
  // hosts (the carrier key is file+ruleId, orthogonal to the confirmed/suspected split), and two
  // independent partitions would each compute their clause from the same un-absorbed `host.why`,
  // so applying them afterwards would drop one report entirely — into no track, no host and no
  // ledger. absorbAcross returns the cumulative `updates`; it is applied once.
  // ONLY the JUDGED tracks are absorbed. An unverified finding may not be written onto a prior's
  // `why`: that clause tells the next adjudicator that "resolved" requires the absorbed report to
  // be gone, which lets something nothing ever checked hold a prior open and gate the re-review
  // verdict — the exact substitution the unverified tier exists to end, and it carries a dead
  // verifier's Critical/High, not just an unpaid-for Low. It is marked in place instead
  // (markTrackedUnverified), so it neither disappears into the prior nor gates anything.
  const { runs, updates, absorbed, keptAtRetired } = absorbAcross([confirmed, suspected], livePriors, retired, matchesPrior)
  for (const [host, why] of updates) host.why = why
  // Two lists in, two runs out — absorbAcross returns one run per list, in order.
  confirmed = /** @type {(typeof runs)[number]} */ (runs[0]).kept
  suspected = /** @type {(typeof runs)[number]} */ (runs[1]).kept
  if (absorbed) logLine(`Re-review: absorbed ${absorbed} new finding(s) into a still-live prior at the same file+rule — recorded on the prior's why (and delivered to next round's adjudicator as its own prompt lines) so they outlive it, not listed twice`)
  if (keptAtRetired) logLine(`Re-review: ${keptAtRetired} new finding(s) matched a prior that RETIRED this round — kept as findings rather than absorbed into a host that does not reach the next ledger`)
}
/** Unverified findings at a site a live prior tracks: marked, or collapsed onto an unverified prior. @param {Finding[]} trackingHosts @param {Set<Finding>} retired @param {Finding[]} carriedUnverified */
function trackUnverifiedAtPriors(trackingHosts, retired, carriedUnverified) {
  const tracked = markTrackedUnverified(unverified.filter(f => !f.carriedUnverified), trackingHosts, retired, matchesPrior)
  unverified = tracked.kept.concat(carriedUnverified)
  // A COLLAPSED ROW IS NOT A DISCARDED FINDING. The carrier key is file+ruleId, coarser than a
  // site, so the row dropped from the ledger can be a genuinely distinct defect on another line.
  // Its site is written onto the host through the same bounded clause absorption uses; the reason
  // this is not the obligation absorption was refused for is in lib/review-adjudicate.mjs.
  // WHAT "BOUNDED" MEANS HERE, EXACTLY: the bound is ABSORBED_MAX and it is GLOBAL, not per round.
  // At most three sites are ever NAMED on one host's `why`; a fourth and every later one — in this
  // round or any later one — is traded for the overflow counter, so its line, title and rationale
  // do not reach the next ledger. That is not a lost finding: it is in THIS round's report, the
  // counter keeps "more than one defect sits here" true, and the lenses re-raise the site next
  // round. It is a loss of detail, and the cap is deliberate (absorbInto's clause is re-interpolated
  // into every later prompt) — but it is a cap, so do not read the clause as a per-site record.
  // OPEN, AND DELIBERATELY NOT CLOSED HERE: an unverified row has no exit from the ledger, so its
  // `why` still accretes across rounds through the per-round NOT_VERIFIED suffixes, which have no
  // cap of their own. The growth is of one persistent field, and bounding it is its own work.
  for (const [host, why] of tracked.updates) host.why = why
  if (tracked.marked) logLine(`Re-review: ${tracked.marked} unverified finding(s) sit at a site a still-live prior already tracks — noted on each, NOT absorbed into the prior: nothing checked them, so they may not hold it open`)
  if (tracked.collapsed) logLine(`Re-review: ${tracked.collapsed} unverified finding(s) sit at a site an equally UNVERIFIED prior already holds in the ledger — shown in this round's report but not persisted as a second ledger row, so an unchecked site does not gain a row per round`)
}
/** Why the prior round's fingerprint basis could not be established, as the lost-memory note names it. */
function unknownBasisWhy() {
  return priorBasisMismatch
      ? 'the revisions the loader printed did not survive transport intact (the list no longer matches its own check string) — a transport or version-skew loss'
      : (Array.isArray(priorRound?.['priorFpRevisions']) || typeof priorRound?.['fpBasisKnown'] === 'boolean')
      ? 'it was recovered from a stopped run whose checkpoints do not attest to one basis, its record could not be read, or it was written by an engine this one cannot place (no engine revision, or a newer one: a downgrade, or two installs sharing one store)'
      : 'the loader\'s answer did not say whether the basis was known (a relay that dropped the field, or a logger older than it) — a transport or version-skew loss'
}
/** The recidivism check skipped: the prior's fingerprints are not comparable, so its tombstones are dropped (and said so). */
function dropTombstonesForBasis() {
  // The prior round's fingerprints are not established as comparable to this round's freshly computed
  // ones (a different basis, a different engine, or a basis that could not be established). Skip the
  // check rather than comparing incompatible hashes and missing a regression in silence — the exact
  // silent miss this guard exists to remove. The tombstones minted from THIS round on are all under
  // the current basis (the incomparable carried ones are dropped at assembly), so the memory rebuilds
  // from here; the cost is recorded on the run record (reReview.tombstonesDropped).
  tombstonesDroppedForBasis = priorTombstones.length
  if (priorBasisVerdict === 'absent') {
    // The answer carried no basis verdict at all — the loader printed none (a logger of another craft
    // version) or the relay dropped it; the schema leaves it optional precisely so this stays visible
    // rather than being filled with a guessed boolean. It is a LOSS of re-review memory (the carried
    // tombstones are dropped for good), so it is stated where lost memory is stated, above the verdict.
    const note = `The prior round's answer carried no fingerprint-basis verdict (sameFpBasis), so its ${priorTombstones.length} resolved/dismissed finding(s) were not compared against this round and are no longer remembered. This is a transport or version-skew loss, not a fingerprint-basis change.`
    reviewRun.reReviewMemoryNote = reviewRun.reReviewMemoryNote ? `${reviewRun.reReviewMemoryNote}\n${note}` : note
    logLine(`⚠️ ${note}`)
  } else if (priorBasisVerdict === 'unknown') {
    // A round recovered from a stopped run whose checkpoints do not attest to one known basis, read
    // from an unreadable record, or written by an engine this one cannot place (no revision, or a newer
    // one) cannot establish the basis its tombstones were minted under. (A recovered round whose
    // checkpoints DO attest to one is decided like any other — realm @nick/craft #112.) Comparing anyway is the silent miss the guard exists
    // to prevent, so they are still dropped — but that is lost memory, and it is said so.
    // When the answer carried neither the raw revisions nor fpBasisKnown, the loader may well have known the basis —
    // the relay dropped the field, or a logger older than it answered — so the cause named is that.
    const why = unknownBasisWhy()
    const note = `The fingerprint basis of the prior round could not be established — ${why} — so its ${priorTombstones.length} resolved/dismissed finding(s) were not compared against this round and are no longer remembered.`
    reviewRun.reReviewMemoryNote = reviewRun.reReviewMemoryNote ? `${reviewRun.reReviewMemoryNote}\n${note}` : note
    logLine(`⚠️ ${note}`)
  } else {
    logLine('Re-review: the prior round was fingerprinted under a different, known basis — so the recidivism check is skipped and its ' + priorTombstones.length + ' carried tombstone(s) are dropped; the memory rebuilds from this round on (expected once, right after an upgrade that changed the basis)')
  }
}
/**
 * The tombstone a fresh finding returns among its fingerprint's: the newest one its tool does not tell
 * apart (toolDistinct — another deadnix binding, another lint), a later one winning a tie; undefined when none.
 * @param {LedgerAnswer[]} tombs @param {Finding} f @returns {LedgerAnswer | undefined}
 */
function returnedTombstone(tombs, f) {
  return tombs.filter(t => !toolDistinct(f, t)).reduce((/** @type {LedgerAnswer | undefined} */ best, t) => !best || tombstoneRound(t) >= tombstoneRound(best) ? t : best, undefined)
}
/** Fresh findings matching a prior tombstone: annotated as a regression or a re-raised dismissal. */
function flagReturningDefects() {
  // Every keyed tombstone of a fingerprint, not one: deadnix seeds carry no symbol, so one fingerprint holds
  // every binding of a file, and the binding a fresh finding returns is picked by toolDistinct below
  // (realm @nick/craft, vimarsha #242; rule #238).
  /** @type {Map<string, LedgerAnswer[]>} */
  const tombstonesByFp = new Map()
  for (const t of priorTombstones) {
    const fp = t.fp || fingerprint(t)
    if (t.ruleId) tombstonesByFp.set(fp, [...(tombstonesByFp.get(fp) || []), t])
  }
  let regressions = 0
  let reraised = 0
  const flagRegression = (/** @type {Finding} */ f) => {
    if (!f['ruleId']) return
    const hit = returnedTombstone(tombstonesByFp.get(fingerprint(f)) || [], f)
    if (!hit) return
    const why = String(hit.why || '')
    const m = /round (\d+)/.exec(why)
    // A LEDGER_ITEM carries no round, so this falls through to '?' unless a ledger extra supplies one.
    const r = m ? m[1] : (/** @type {{ round?: unknown }} */ (hit).round || '?')
    if (/^dismissed /.test(why)) {
      f['why'] = `${f['why']} NOTE: a defect the author dismissed in round ${r} has been re-raised.`
      reraised++
    } else {
      f['why'] = `${f['why']} REGRESSION: this exact defect was resolved in round ${r} and has reappeared.`
      regressions++
    }
  }
  confirmed.forEach(flagRegression)
  suspected.forEach(flagRegression)
  unverified.filter(f => !f.carriedUnverified).forEach(flagRegression)
  if (regressions) logLine(`Re-review: ${regressions} fresh finding(s) match a defect RESOLVED in an earlier round — annotated as REGRESSION in the report; the verdict still counts each by its severity`)
  if (reraised) logLine(`Re-review: ${reraised} fresh finding(s) match a defect the author DISMISSED in an earlier round — annotated as re-raised, not a regression; the verdict still counts each by its severity`)
}
// Absorption, unverified tracking and the recidivism check against the prior round's ledger.
function reconcileWithPriors() {
  if (priorRound) {
    const livePriors = [...adjudicated.stillOpen, ...adjudicated.regressed, ...adjudicated.carried, ...adjudicated.retired]
    // A RETIRED host absorbs NOTHING and tracks nothing — hoisted because BOTH passes below need it.
    const retired = new Set(adjudicated.retired)
    // Priors carrying the unverified tier were never adjudicated, so they are absent from `livePriors`
    // — they were carried straight into THIS round's `unverified` list instead. They are nonetheless
    // still-live rows of the next ledger, and they are precisely the hosts that matter for a site that
    // stays unchecked round after round, which is why the tracking pass takes them too.
    const carriedUnverified = unverified.filter(f => f.carriedUnverified)
    if (livePriors.length) absorbIntoLivePriors(livePriors, retired)
    // The tracking pass runs on its OWN guard, not inside the absorption one: a round whose only live
    // prior carries the unverified tier has an EMPTY `livePriors` (nothing was adjudicated) and is
    // exactly the round where a site accretes a second unchecked row. And that is only the EMPTY case:
    // a site can hold a live judged prior AND a carried unverified one at the same file+rule, and the
    // judged one comes first in this array. The collapse must not depend on that — markTrackedUnverified
    // picks its host BY TIER, not by this order (see lib/review-adjudicate.mjs); the order here is only
    // the fallback for a finding no unverified host tracks.
    const trackingHosts = [...livePriors, ...carriedUnverified]
    if (trackingHosts.length) trackUnverifiedAtPriors(trackingHosts, retired, carriedUnverified)
    // RECIDIVISM. A freshly discovered finding whose fingerprint matches a prior tombstone has RETURNED,
    // and the two tombstone ORIGINS mean different things. A `resolved` tombstone is a defect that was
    // actually fixed, so a match is a REGRESSION — the fix came undone. A `dismissed` tombstone is a
    // prior the AUTHOR rejected/justified and whose carry-check found the code around it UNCHANGED
    // (retirement): the engine's own separate `reopened` path already handles the code-CHANGED case, so
    // a match here is not a regression at all — nothing was fixed and nothing broke — it is the same
    // dismissed defect being re-raised, and it is labelled as exactly that. Exact fingerprint match
    // only, and only for a finding that carries a ruleId: an ad-hoc finding has no stable identity, so
    // it gets no tombstone check rather than a fuzzy one (fuzzy title matching was measured at 2/59
    // recall). This is a HUMAN-FACING annotation on `why` only: it neither moves the finding between
    // tiers nor changes the verdict, which still counts each returning finding by its own severity
    // exactly as a novel one (whether a regression should escalate the verdict is a separate decision,
    // deliberately not taken here). All three live tiers are scanned — confirmed, suspected AND
    // unverified — because the unverified tier is precisely where a returning defect lands when its
    // verifier died or was floor-skipped, which is the run where the "it came back" signal matters most;
    // carried-unverified priors are excluded, as they are not freshly discovered.
    if (priorTombstones.length && !priorFpComparable) dropTombstonesForBasis()
    else if (priorTombstones.length) flagReturningDefects()
  }
}
reconcileWithPriors()
return { confirmed, suspected, unverified, tombstonesDroppedForBasis }
}
