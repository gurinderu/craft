// The adjudicate track of a re-review (src/review.js, Adjudicate phase): every prior-round finding's fate this
// round — carried, retired, still open, regressed or resolved, a resolved Critical/High attacked by a red team.
import { reraisedBySeverity } from './prior-decisions.mjs'
import { deferralOn } from './ledger-deferral.mjs'
import { deferralReleased } from './prior-decision-apply.mjs'
import { canonicalSeverity } from './review-coverage.mjs'
import { sanitizeAttack, baseWhy, isHighSeverity, classifyRedTeam, adjudicateOne, shouldRedTeam, withoutAbsorbed, absorbedPromptBlock, redTeamInvariant } from './review-adjudicate.mjs'
import { shq } from './run-logging.mjs'
import { CHANGED_SCHEMA, ADJUDICATE_SCHEMA, ATTACK_SCHEMA } from './review-schemas.mjs'
import { flattenField, promptFields } from './prompt-fields.mjs'
import { CULL_MODEL } from './review-verify-pool.mjs'

/**
 * @typedef {import('./review-schemas.mjs').Finding} Finding
 * @typedef {import('./review-profiles.mjs').Profile} Profile
 * @typedef {import('./review-schemas.mjs').PriorRoundAnswer} PriorRound
 * @typedef {import('./review-schemas.mjs').LedgerAnswer} LedgerAnswer
 * @typedef {import('./review-schemas.mjs').AdjudicateAnswer} AdjudicateAnswer
 * @typedef {import('./review-run.mjs').ReviewRun} ReviewRun
 */
/** @typedef {import('./review-run.mjs').ReviewState} ReviewState */

/**
 * The prior round's findings adjudicated, its tombstones, and this round's unverified track with the unverified priors carried in.
 * @param {ReviewRun} reviewRun
 * @param {Pick<ReviewState, 'tierLists' | 'priorRound' | 'results' | 'active'>} state
 */
export async function adjudicatePhase(reviewRun, { tierLists, priorRound, results, active }) {
const { ragent } = reviewRun
const { log: logLine, parallel: runParallel, phase: enterPhase } = reviewRun.sb
let { unverified } = tierLists
// ---- Adjudicate track (re-review only) ----
// For each prior-round finding, decide its fate this round. Settled priors (isSettledPrior) are carried
// (not re-raised) unless the code around them changed; open/confirmed priors, and a Critical/High
// deferred one, get a targeted "is it still here?" check against the current tree.
// `retired` is the carried track's EXIT: a dismissed prior whose carry-check reported the code
// around it unchanged has had its one confirmation and leaves the ledger. It still lives here for
// the rest of THIS round — it suppresses a lens re-discovery (below) and renders in the report's
// carried section — but it is not re-persisted, so it never costs another carry agent.
/** @type {{ resolved: Finding[], stillOpen: Finding[], regressed: Finding[], carried: Finding[], retired: Finding[] }} */
const adjudicated = { resolved: [], stillOpen: [], regressed: [], carried: [], retired: [] }
// Tombstones: resolved/retired priors from EARLIER rounds, kept only as a recidivism check (a fresh
// finding matching one is a regression, not a novelty). Filled on load below and read again at the
// absorption pass — declared out here so both see it. It rides the persisted ledger like any row, so
// a lost tombstone is caught by the same ledgerCount check every other row is.
/** @type {LedgerAnswer[]} */
const priorTombstones = []
/** Priors carrying the unverified tier re-enter this round's unverified track. @param {Finding[]} priorUnverified @param {PriorRound} priorRoundIn */
function carryUnverifiedPriors(priorUnverified, priorRoundIn) {
  if (priorUnverified.length) {
    logLine(`${priorUnverified.length} prior finding(s) carry the unverified tier — never checked against the code, so nothing to adjudicate: carried forward as unverified rather than promoted to still-open`)
    unverified = unverified.concat(priorUnverified.map((/** @type {Finding} */ f) => ({
      ...f,
      fix: f['fix'] || 'verify it first — nothing has checked this claim against the code',
      blastRadius: f['blastRadius'] || '',
      tier: 'unverified',
      // Flagged so the tracking pass below can use these as HOSTS. They are not in `livePriors` —
      // they were never adjudicated — so without the flag a fresh unverified re-discovery of the
      // same site is neither marked nor collapsed, and the site gains a ledger row every round.
      carriedUnverified: true,
      why: `${baseWhy(f['why'])} (STILL NOT VERIFIED: carried from round ${priorRoundIn['round']}, where no verifier judged it; nothing has checked it against the code since)`,
    })))
  }
}
// THE ONE RULE for a settled prior — the carry track's entry. A dismissal (rejected/justified) is the
// author's; a `deferred` row is a finding set aside as Known and deferred (realm @nick/craft, node #204),
// settled for the chain like a dismissal so it stays out of the verdict — except Critical/High, which no
// prior record sets aside, and except a deferral a record in hand (recalled or passed) releases by an
// explicit `supersedes:` / `answers:` link to its question; its question's absence never releases it
// (deferralReleased). The deferral is the row's structured `deferral` field; a `deferred` row without one
// has no question behind it (none was written, or the write was refused), so nothing holds it.
// Released, it is an ordinary prior: adjudicated, counted while its defect is present.
/** @param {Finding} f */
function deferralHeld(f) {
  const deferral = deferralOn(f['deferral'])
  if (!deferral) {
    logLine(`Re-review: ${f['file']}:${f['line']} is marked deferred but carries no question's deferral — adjudicated like any prior`)
    return false
  }
  if (reraisedBySeverity(f['severity'])) return false
  if (!deferralReleased(deferral, reviewRun.priorDecisionsIn.decisions)) return true
  logLine(`Re-review: the deferral on ${f['file']}:${f['line']} no longer holds — a record supersedes or answers its question ${deferral.id} — adjudicated like any prior`)
  return false
}
/** @param {Finding} f */
function isSettledPrior(f) {
  const d = f['disposition']
  return d === 'rejected' || d === 'justified' || (d === 'deferred' && deferralHeld(f))
}
/** Carried deferred priors, for the Known and deferred section. */
const carriedDeferred = () => adjudicated.carried.filter(f => f['disposition'] === 'deferred').map(f => ({ ...f, priorKind: 'question' }))
// The adjudicate track, on a re-review with a prior ledger.
async function adjudicatePriors() {
  if (priorRound?.['ledger']?.length) {
    enterPhase('Adjudicate')
    // Canonicalize prior severity ONCE, at the load boundary, BEFORE splitting/adjudicating/carrying:
    // LEDGER_ITEM.severity has no enum, so a drifted `critical`/`CRITICAL` prior would trip the
    // case-insensitive gates (isHighSeverity in classifyRedTeam / the red-team gate) yet be bucketed as
    // 0 Critical/0 High by countBySeverity (exact-case) — a fail-open re-review Approve over a
    // still-broken Critical fix. Mapping through canonicalSeverity here means adjudicateOne's
    // `located = {...f}` and EVERY downstream verdict/count (countBySeverity, rereviewVerdict, the strict
    // escalation) and the re-persisted ledger all see canonical severity for priors.
    const priorLedgerAll = priorRound['ledger'].map(f => ({ ...f, severity: canonicalSeverity(f['severity']) }))
    // TOMBSTONES ARE CARVED OUT BEFORE THE SPLIT. A `disposition:'closed'` row is a resolved/retired
    // prior kept only so a later round can recognise the defect's return — it is already answered.
    // Left in the pool it would fall into `toCheck` below and be sent to the adjudicator, spending an
    // agent to ask whether a closed defect is "still present" at a site where nothing remains to judge.
    // So it is pulled here and never enters the unverified/settled/toCheck partitions.
    priorTombstones.push(...priorLedgerAll.filter((/** @type {Finding} */ f) => f['disposition'] === 'closed'))
    const priorLive = priorLedgerAll.filter((/** @type {Finding} */ f) => f['disposition'] !== 'closed')
    // THE UNVERIFIED TIER SURVIVES THE ROUND BOUNDARY. A prior carrying `tier: 'unverified'` was never
    // checked against the code — so there is nothing to adjudicate: "is the defect still present?"
    // presumes someone established it was present. Adjudicating it anyway routed it into `stillOpen`,
    // where it renders as a live prior finding AND feeds the verdict (`rereviewVerdict` counts
    // stillOpen) — so a finding no verifier ever looked at became a gating one after one hop, and the
    // tier that exists to say "nothing checked this" lived only inside the round that minted it.
    // It re-enters THIS round's own unverified track instead: label kept, out of the verdict, out of
    // the refutation denominator, re-persisted as `unverified` for the next round.
    const priorUnverified = priorLive.filter((/** @type {Finding} */ f) => String(f['tier'] || '') === 'unverified')
    carryUnverifiedPriors(priorUnverified, priorRound)
    const priorLedger = priorLive.filter((/** @type {Finding} */ f) => String(f['tier'] || '') !== 'unverified')
    // Judged once per prior (a released deferral is logged): toCheck is the remainder, not a second pass.
    const settled = priorLedger.filter(isSettledPrior)
    /** @type {Finding[]} */
    const toCheck = priorLedger.filter(f => !settled.includes(f))

    // Settled priors: carried unless the code around them changed since the prior round.
    const carriedResults = (await runParallel(settled.map((/** @type {Finding} */ f) => () => {
      const pf = promptFields(f)
      return ragent(
        `A prior review finding was set aside by the author (disposition: ${f['disposition']}). Decide only whether the CODE AROUND IT CHANGED since commit ${flattenField(priorRound['head'])}. Shell + read only.
FINDING: [${pf.severity}] ${pf.title} — at ${pf.file}:${f['line']} (symbol ${pf.symbol}), rule ${pf.ruleId}.
Run \`git diff ${priorRound.head ? `${shq(priorRound.head)}...HEAD` : 'HEAD'} -- ${shq(f.file)}\` and judge whether the enclosing symbol/region was touched. Return {changed: <bool>, reason}.`,
        { label: `carry:${f['file']}:${f['line']}`, phase: 'Adjudicate', schema: CHANGED_SCHEMA, model: CULL_MODEL },
      ).then(r => ({ f, changed: r == null ? null : !!r.changed }))
    }))).filter(x => x != null)
    // A dead carry agent (changed == null) is indeterminate — keep the dismissed prior as carried (do
    // NOT reopen on an indeterminate carry), but count + ⚠️-log it like the other death paths so this
    // is no longer the one unaudited death path.
    //
    // THE EXIT, AND WHY IT LOSES NOTHING. A dismissal is the author's decision; the only thing that
    // can invalidate it is the code around it changing. So one carry-check that says "unchanged" is
    // the whole answer, and re-asking it every round forever buys nothing — it was the only track
    // with no exit at all, costing one agent per dismissal per round in perpetuity. A retired prior
    // is not forgotten into silence: the lenses raise the finding fresh, on its merits — which is
    // exactly what the `changed === true` branch does here, minus the stale `rejected` label.
    //
    // WHEN THE RE-RAISE HAPPENS, HONESTLY. Not only "if that code is ever touched again". On a full
    // re-scan the lenses see the whole diff and re-invent every prior, so the re-discovery can land in
    // the SAME round the dismissal retires: partitionAbsorbed refuses to absorb into a retired host
    // (it is not persisted), the finding is KEPT, and it enters the next ledger as `open`. The
    // author's dismissal is then undone with no code change, and next round it costs a full
    // adjudicator instead of a cheap carry agent.
    //
    // THAT IS THE ACCEPTED COST, AND THE ALTERNATIVE IS WORSE. Dropping a finding whose only carrier
    // retired would reinstate exactly the loss class partitionAbsorbed exists to close: retirement is
    // judged at REGION granularity while the carrier matches on file+ruleId, so a genuinely NEW defect
    // elsewhere in the same file under the same rule would be discarded by a host whose own region did
    // not move — silently, into no report and no ledger. Losing a label is recoverable (the author
    // re-dismisses it, once); losing a defect is not.
    //
    // An INDETERMINATE carry-check (agent died) retires nothing: it stays carried and is asked again
    // next round.
    let carryDied = 0
    /** @param {(typeof carriedResults)[number]} c */
    const applyCarry = c => {
      const { f, changed } = c
      if (changed === null) { carryDied++; logLine(`⚠️ carry-check for ${f.file}:${f.line} died — kept as carried by default`); adjudicated.carried.push(f) }
      // A deferred prior is a known DEFECT, not a dismissal: its code changed, the question is whether the
      // defect is still there — the adjudicator's (resolved → tombstone; still present → open, counted).
      // Reopening it unseen reported a fixed defect as open.
      else if (changed && f['disposition'] === 'deferred') toCheck.push(f)
      else if (changed) adjudicated.stillOpen.push({ ...f, why: `${baseWhy(f.why)} (reopened: dismissed as ${f.disposition}, but the code around it changed — re-verify the justification)` })
      // Unchanged, a deferred prior stays carried (and deferred) until it is answered, instead of
      // retiring after one confirmation.
      else if (f['disposition'] === 'deferred') adjudicated.carried.push(f)
      else adjudicated.retired.push(f)
    }
    for (const c of carriedResults) applyCarry(c)

    // Open/deferred/confirmed priors: is the defect CLASS still present at its (re-located) site?
    // The adjudicator must state the violated invariant and attack the fix — a fix that closes the
    // literal repro but not the class must not close. A "resolved" Critical/High is then re-attacked
    // by an independent red-team agent that never sees the adjudicator's verdict.
    const adjudModel = results[0]?.['plan']?.lensModel || 'opus'
    let overturned = 0
    let redTeamDied = 0
    let invalidRedTeam = 0
    let adjudicatorDied = 0
    let cannotTellCount = 0
    const redTeam = async (/** @type {Finding} */ f, /** @type {AdjudicateAnswer} */ adj) => {
      if (!isHighSeverity(f['severity'])) return adj
      const pf = promptFields(f)
      const rt = await ragent(
        `A code-review finding was raised on an earlier revision of this repo and the author has since pushed fix commits. Attack the fix. Shell + read only; do NOT hunt for unrelated bugs.
FINDING: [${pf.severity}] ${pf.title}
  originally at ${pf.file}:${f['line']} (enclosing symbol ${pf.symbol}), rule ${pf.ruleId}
  why it mattered: ${sanitizeAttack(withoutAbsorbed(f.why))}${absorbedPromptBlock(f.why)}
INVARIANT it violated: ${redTeamInvariant(adj, f)}
METHOD: re-locate the symbol (grep it — the line has likely moved), read the current code, and try to CONSTRUCT a concrete input/state that violates the invariant even with the current code in place (canonical: the fix compares for exact equality where the invariant is about overlap/containment/ordering). Check every candidate against the actual code paths before claiming it works.
Return {defeated, attack} — defeated=true ONLY with a concrete attack that survives your own check against the code.`,
        { label: `redteam:${f['file']}:${f['line']}`, phase: 'Adjudicate', schema: ATTACK_SCHEMA, model: adjudModel },
      )
      // A dead red-teamer keeps `resolved`: the adjudicator already ran its own attack pass, and a
      // transient agent death must not spuriously reopen findings. But the degradation must be
      // auditable — count it, log it, and annotate the note so "red-team passed" is distinguishable
      // from "red-team never ran" in the report and the run log.
      const { adj: redTeamed, died, overturned: ov, invalid } = classifyRedTeam(f, adj, rt)
      if (died) { redTeamDied++; logLine(`⚠️ red-team for ${f['file']}:${f['line']} died — "resolved" stands on the adjudicator's own attack pass only`) }
      if (invalid) { invalidRedTeam++; logLine(`⚠️ red-team for ${f['file']}:${f['line']} claimed defeat with NO attack — invalid verdict discarded, keeping resolved`) }
      if (ov) overturned++
      return redTeamed
    }
    const checkResults = (await runParallel(toCheck.map((/** @type {Finding} */ f) => () => {
      const pf = promptFields(f)
      return ragent(
        `You are adjudicating whether a prior review finding is still present after a fix attempt. Load the ${/** @type {Profile} */ (active[0]).rubricSkill} skill for the rubric. Shell + read only; do NOT hunt for new bugs.
FINDING: [${pf.severity}] ${pf.title}
  originally at ${pf.file}:${f['line']} (enclosing symbol ${pf.symbol}), rule ${pf.ruleId}
  why it mattered: ${sanitizeAttack(withoutAbsorbed(f.why))}${absorbedPromptBlock(f.why)}
METHOD:
  1. State in ONE sentence the INVARIANT this finding violated — the property that must hold, not the literal repro (derive it from the why/title).
  2. Re-locate the symbol (grep it — the line has likely moved) and read the fix.
  3. Construct AT LEAST TWO concrete attacks: inputs/states that would violate the invariant while the current fix is in place (canonical: the fix compares for exact equality where the invariant is about overlap/containment/ordering). Check each against the actual code.
  4. Decide:
  - "resolved": every attack fails — the fix closes the CLASS, not just the described instance.
  - "still-open": the defect is still present OR one of your attacks succeeds (cite the current file:line; put the attack in \`attack\`).
  - "cannot-tell": you could NOT determine the answer — the file is gone or renamed, the symbol no longer exists, or you could not read enough of the code to judge. Say why in \`note\`. Use this rather than "resolved" whenever you are guessing: "resolved" means you checked and every attack failed, never "I could not find it".
  - "regressed": the site was changed but now has a DIFFERENT defect of the same kind (cite it).
Return {status, currentLine, note, invariant, attack}.`,
        { label: `adjudicate:${f['file']}:${f['line']}`, phase: 'Adjudicate', schema: ADJUDICATE_SCHEMA, model: adjudModel },
      ).then(async r => ({ f, r: r && shouldRedTeam(r) ? await redTeam(f, r) : r }))
    }))).filter(x => x != null)
    /** @param {(typeof checkResults)[number]} c */
    const tallyAdjudication = c => {
      const { f, r } = c
      const { track, entry, demoted, cannotTell, adjudicatorDied: adjDied } = adjudicateOne(f, r)
      if (demoted) logLine(`⚠️ adjudicator for ${f.file}:${f.line} returned resolved WITH an attack — demoting to still-open`)
      if (cannotTell) { cannotTellCount++; logLine(`⚠️ adjudicator for ${f.file}:${f.line} could not tell — kept still-open, marked UNVERIFIED in the report`) }
      if (adjDied) { adjudicatorDied++; logLine(`⚠️ adjudicator for ${f.file}:${f.line} died — no verdict returned; kept still-open by default`) }
      adjudicated[track].push(entry)
    }
    for (const c of checkResults) tallyAdjudication(c)
    logLine(`Adjudicate: ${adjudicated.resolved.length} resolved · ${adjudicated.stillOpen.length} still-open · ${adjudicated.regressed.length} regressed · ${adjudicated.carried.length} carried · ${adjudicated.retired.length} carried→retired (code unchanged; leaves the ledger) · ${overturned} overturned by red-team · ${redTeamDied} red-team died · ${invalidRedTeam} invalid red-team · ${adjudicatorDied} adjudicator died · ${cannotTellCount} could not tell · ${carryDied} carry died`)
  }
}
await adjudicatePriors()
return { unverified, adjudicated, priorTombstones, carriedDeferred }
}
