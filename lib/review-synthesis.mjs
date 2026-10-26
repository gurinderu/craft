// The one merged report (src/review.js, Synthesize phase): the synthesis agent's prompt for a first review or a
// re-review, its verdict rule and incompleteness clause, and what an unusable answer is.
import { PATH_FLOOR_MARK } from './path-severity-floor.mjs'

/**
 * @typedef {import('./review-run.mjs').ReviewRun} ReviewRun
 */
/** @typedef {import('./review-run.mjs').ReviewState} ReviewState */
// ONE sentence, three readers: the first-pass template, the re-review template and the mechanical
// fallback report. It was written twice before and the two copies already meant different things.
// It names ALL FOUR ways into the tier — a Low/Info nobody paid a verifier for, a Medium nobody
// paid for because the verdict was already fixed at Block, a finding whose verifier died, and a
// panel whose every returned vote was off-schema — because a reader who is told only the cheap
// reasons will read a dead verifier's findings as cheap ones, and a panel that ANSWERED unreadably
// did not die: calling it a death misdescribes the largest discard there is.
export const UNVERIFIED_PREAMBLE = 'These were not verified: no verifier was spent on them because a Low/Info finding cannot change the verdict, or because the verdict was already fixed at Block by a confirmed Critical/High and a Medium cannot move it, or the verifier that should have judged them died before returning a verdict, or every vote the panel DID return answered off-schema and carried none of the judgements the tier is decided on — each entry says which in its own `why`. Nothing below has been checked against the code — treat each as a lead, not a finding.'

/**
 * The synthesized report, or null when the agent died or answered with something else.
 * @param {ReviewRun} reviewRun
 * @param {Pick<ReviewState, 'priorRound' | 'adjudicated' | 'tierLists' | 'notRun' | 'incompleteNotes' | 'active' | 'thisRound' | 'mergedProvenance' | 'carriedLine' | 'uncoveredFiles' | 'criticNotes'>} state
 */
export async function synthesisPhase(reviewRun, { priorRound, adjudicated, tierLists, notRun, incompleteNotes, active, thisRound, mergedProvenance, carriedLine, uncoveredFiles, criticNotes }) {
const { strict, ragent } = reviewRun
const { log: logLine, phase: enterPhase } = reviewRun.sb
const { confirmed, suspected, unverified } = tierLists
// ================= Synthesize one merged report =================
enterPhase('Synthesize')
const isRereview = !!priorRound
// `foundInRound` is for the record only; the synthesis prompt stays as it was (realm @nick/craft, node #248).
/** @param {string} k @param {unknown} v */
const withoutRound = (k, v) => (k === 'foundInRound' ? undefined : v)
const rereviewData = rereviewDataOf()
function rereviewDataOf() {
  return isRereview ? {
    resolved: adjudicated.resolved, stillOpen: adjudicated.stillOpen,
    // `retired` is NOT folded into `carried`: they answer different questions for the reader. A
    // carried prior is re-checked next round; a retired one leaves the ledger, and on a full rescan
    // its re-discovery is kept as a New Confirmed finding — so folding them made the report say a
    // defect was "carried forward unchanged" while listing the same defect under New.
    regressed: adjudicated.regressed, carried: adjudicated.carried, retired: adjudicated.retired, neu: confirmed,
  } : null
}
// The verdict-line clause the synthesis model is told to append when coverage was not complete. It
// names the SAME cause the record string names: a genuine not-run is INCOMPLETE (re-running helps),
// a coverage hole is PARTIAL COVERAGE (a re-run will not fix it). floorPremiseHeld is deliberately
// not consulted here — the synthesis prompt is composed before the verdict exists, and the revoked-
// floor cause is appended afterward by markVerdictIncomplete.
// An Approve holds only over what ran: the model is told so, and honestVerdictLine enforces it after (realm @nick/craft, node #299).
const neverApproveClause = neverApproveClauseOf()
function neverApproveClauseOf() {
  return notRun.length ? ' Part of this review did not run, so the verdict is never Approve: where it would be Approve, write "\u26a0\ufe0f INCOMPLETE" in its place.' : ''
}
const incompleteClause = incompleteClauseOf() + neverApproveClause
function incompleteClauseOf() {
  return incompleteNotes.length
    ? ` Append " · ⚠️ ${notRun.length ? 'INCOMPLETE — part of this review did not run' : 'PARTIAL COVERAGE — a coverage hole a re-run will not fix'}: ${incompleteNotes.join('; ')}; findings may be undercounted." to the verdict line.`
    : ''
}
// Set when the synthesis agent answered but not with report text, so the fallback names the real cause.
let synthesisUnusable = false
// The synthesis agent's report text, or null when it died or answered with something else (logged).
async function synthesize() {
  return ragent(
    `You are consolidating a code review (languages: ${active.map(p => p.id).join(', ')}) into ONE markdown report. Do NOT invent findings — only use what is given.

VERDICT RULE: the verdict is driven ONLY by Confirmed findings.
- ⛔ Block if any Confirmed Critical or High.
- ⚠️ Warning if Confirmed Medium only.
- ✅ Approve if no Confirmed Critical/High/Medium.
Suspected findings NEVER change the verdict — they are surfaced for the author. UNVERIFIED findings were never checked at all — EITHER no verifier was spent (a Low/Info cannot move the verdict) OR the verifier that should have judged them died before returning one OR every vote it did return was off-schema and unreadable, so a Critical or High can carry this tier. They change nothing and must never be presented as confirmed, as checked, or as cheap.${strict ? '\nSTRICT MODE: the maintainability bar is a presumption of block — if ANY Confirmed finding has source "maintainability" (or lists "maintainability" among its merged `sources`) at Medium or above, the verdict is ⛔ Block (state in the verdict line that strict maintainability mode escalated it).' : ''}

CALIBRATE severities across the Confirmed set so the same kind of issue is not Critical in one place and Medium in another; adjust outliers and say so in one line if you do. A finding whose why carries "raised to Medium from" with "${PATH_FLOOR_MARK}" is never calibrated below Medium in the report: the record already holds it at Medium. For any resource-exhaustion / algorithmic-complexity finding (SAF-009), severity must be MEASURED, not inherited from "same class as X" — a shared mechanism implies nothing about shared magnitude. Demand attack cost against a REAL-DATA baseline (not just the PoC's own numbers) and attacker-bytes-per-victim-CPU-second; where the finding carries no such measurement, say so and rate it conservatively rather than borrowing a neighbour's label.

DEDUPLICATE across lenses: findings that describe the same underlying defect (same file, same/overlapping lines, fixes that collapse into one edit) MUST be merged into ONE entry — keep the highest severity and the clearest why, credit the other lens in one clause. Never list per-lens duplicates as separate findings.

${isRereview ? `This is a RE-REVIEW (round ${thisRound}). Produce, in order:
1. \`## Verdict\` — driven ONLY by Still-open + Regressed + New Confirmed findings (Block on any Critical/High; Warning on Medium; else Approve). Resolved and Carried NEVER change the verdict.${incompleteClause}
2. \`## Gate\` — ${JSON.stringify(mergedProvenance)}.${carriedLine}
3. \`## ✅ Resolved\` — prior findings the fixes closed (one line each); omit if empty.
4. \`## 🔴 Still open\` — prior findings still present; \`severity · file:line · [ruleId] · what · why\`; omit if empty.
5. \`## ⚠️ Regressed\` — new defects the fixes introduced at a prior site; omit if empty.
6. \`## 🆕 New\` — Confirmed findings from the delta lenses (same format); omit if empty. In Still open, Regressed, New, Suspected and Unverified alike: a finding with a non-empty \`toolRule\` (a gate tool's own rule) carries it in the brackets, always labelled \`tool:\` so it never reads as a catalog id: \`[ruleId · tool: toolRule]\`, or \`[tool: toolRule]\` when ruleId is empty. A gate tool's finding without a \`toolRule\` (its source a gate tool: clippy, clippy-pedantic, semgrep, semver, semver-checks, statix, deadnix, fmt, tool) prints its \`title\` verbatim as \`what\` — never reworded: a past decision is matched to it by that title.
6a. \`## Suspected (needs confirmation)\` — the SUSPECTED JSON below: findings a verifier DID examine and could not confirm; same format; never merge these into New or Still open, never call them confirmed — they never change the verdict; omit the section if empty.
6b. \`## Unverified (not checked)\` — the UNVERIFIED JSON below, same format, and OPEN the section with exactly this sentence: "${UNVERIFIED_PREAMBLE}" Never merge these into New, Still open or Carried, never call them confirmed, and do not re-rank or upgrade their severity. They change nothing about the verdict. Omit the section if empty.
7. \`## 🔽 Carried\` — settled priors (rejected/justified/deferred) that are re-checked again next round, collapsed to a count + one-line list; omit if empty.
7b. \`## 🏁 Retired\` — dismissals whose code has not moved since the author ruled on them: they leave the ledger and are NOT re-checked again. Collapse to a count + one-line list; omit if empty. If a defect here also appears under \`## 🆕 New\`, say so on its line — the dismissal stopped being tracked and the site was raised afresh; that is expected, not a contradiction.${uncoveredFiles.length ? `\n8. \`## Not reviewed\` — these changed files match no active language profile and were NOT reviewed; list them verbatim: ${JSON.stringify(uncoveredFiles)}` : ''}${criticNotes ? `\n9. \`## Coverage gaps\` — surface verbatim: ${JSON.stringify(criticNotes)}` : ''}
RE-REVIEW DATA (JSON): ${JSON.stringify(rereviewData, withoutRound, 2)}` : `Produce, in order:
1. \`## Verdict\` — one line (emoji + reason).${incompleteClause}
2. \`## Gate\` — ${JSON.stringify(mergedProvenance)}.${carriedLine}
3. \`## Confirmed\` — findings by severity (Critical first), each as \`severity · file:line · [ruleId] · what · why · fix\` and a blast-radius note when present. Include the \`ruleId\` in brackets when the finding has a non-empty one; omit the brackets otherwise. A finding with a non-empty \`toolRule\` (a gate tool's own rule) carries it in the same brackets, always labelled \`tool:\` so it never reads as a catalog id: \`[ruleId · tool: toolRule]\`, or \`[tool: toolRule]\` when ruleId is empty. When a finding carries a non-empty \`whereChecked\`, append \`· Premise checked at: <value>\` — that is the off-site evidence the author needs in order to re-check the claim, not decoration. A gate tool's finding without a \`toolRule\` (its source a gate tool: clippy, clippy-pedantic, semgrep, semver, semver-checks, statix, deadnix, fmt, tool) prints its \`title\` verbatim as \`what\` — never reworded: a past decision is matched to it by that title.
4. \`## Suspected (needs confirmation)\` — findings a verifier DID examine and could not confirm; same format; omit the section if empty.
5. \`## Unverified (not checked)\` — same format, and OPEN the section with exactly this sentence: "${UNVERIFIED_PREAMBLE}" Never merge these into Confirmed or Suspected, never call them confirmed, and do not re-rank or upgrade their severity. Omit the section if empty.
6. \`## Fix first\` — the few highest-leverage Confirmed items.
${uncoveredFiles.length ? `7. \`## Not reviewed\` — these changed files match no active language profile and were NOT reviewed; list them verbatim: ${JSON.stringify(uncoveredFiles)}` : ''}
${criticNotes ? `8. \`## Coverage gaps\` — surface verbatim: ${JSON.stringify(criticNotes)}` : ''}`}

CONFIRMED (JSON): ${JSON.stringify(confirmed, withoutRound, 2)}

SUSPECTED (JSON): ${JSON.stringify(suspected, withoutRound, 2)}

UNVERIFIED — NOT CHECKED (JSON): ${JSON.stringify(unverified, withoutRound, 2)}`,
    { label: 'synthesis', phase: 'Synthesize', effort: 'medium' },
  // Without a schema the answer is the agent's final text; anything else is no report at all — but a
  // LIVE agent that answered with a non-string, or with blank text, did not die, and the fallback must
  // not say it did: every non-null answer that reaches the fallback is an unusable one.
  ).then(text => {
    if (typeof text === 'string' && text.trim()) return text
    if (text != null) {
      synthesisUnusable = true
      const what = typeof text === 'string' ? 'blank text' : Array.isArray(text) ? 'an array' : `a value of type ${typeof text}`
      logLine(`⚠️ synthesis agent answered with ${what}, not report text — discarded; using the mechanical fallback report`)
    }
    return null
  })
}
const report = await synthesize()
return { report, isRereview, synthesisUnusable }
}
