// The report the review returns (src/review.js): the synthesized one, or the mechanical fallback, with the
// verdict line made honest and every section the engine owns appended.
import { toolTitlesSection } from './tool-titles.mjs'
import { priorRejectedSection } from './prior-decision-apply.mjs'
import { projectRuleSection } from './project-rule-apply.mjs'
import { contradictionSection } from './memory-contradiction.mjs'
import { honestVerdict, honestVerdictLine } from './honest-verdict.mjs'
import { UNVERIFIED_PREAMBLE } from './review-synthesis.mjs'
import { seamSetAsideSection } from './unit-seam.mjs'
import { unitNoticeSection } from './unit-scope.mjs'

/**
 * @typedef {import('./review-schemas.mjs').Finding} Finding
 * @typedef {import('./review-run.mjs').ReviewRun} ReviewRun
 */
/** @typedef {import('./review-run.mjs').ReviewState} ReviewState */

/**
 * The report text the engine returns.
 * @param {ReviewRun} reviewRun
 * @param {Pick<ReviewState, 'isRereview' | 'recordVerdict' | 'tierLists' | 'mergedProvenance' | 'carriedSection' | 'uncoveredFiles' | 'synthesisUnusable' | 'notRun' | 'coverageNotes' | 'adjudicated' | 'floorPremiseHeld' | 'savedByFloor' | 'report' | 'priorRejected' | 'carriedDeferred' | 'ruleNotices' | 'doubtfulReport'>} state
 */
export function finalReport(reviewRun, { isRereview, recordVerdict, tierLists, mergedProvenance, carriedSection, uncoveredFiles, synthesisUnusable, notRun, coverageNotes, adjudicated, floorPremiseHeld, savedByFloor, report, priorRejected, carriedDeferred, ruleNotices, doubtfulReport }) {
const { SEV_RANK, finalVerdict, scopeSection, limitStop, out, unitRuns, unitNotices } = reviewRun
const { confirmed, suspected, unverified } = tierLists
// If the synthesis agent died even after the retry, don't lose the whole run — assemble a
// mechanical report from the verified findings (unmerged, but complete).
function fallbackReport() {
  // Why there is no synthesized report: a death and a live answer that was not report text read differently.
  const cause = fallbackCause()
  // On a re-review the verdict must come from recordVerdict (still-open+regressed+new), NOT
  // finalVerdict(confirmed) — confirmed holds only the delta, so finalVerdict would print a false
  // Approve and hide live still-open/regressed priors. Render those tracks too.
  const emoji = { Block: '⛔ Block', Warning: '⚠️ Warning', Approve: '✅ Approve' }[isRereview ? recordVerdict : finalVerdict(confirmed)]
  const verdictMark = fallbackVerdictMark(emoji)
  // The catalog ruleId and a gate tool's own rule beside it (realm @nick/craft, node #236).
  const ruleTag = (/** @type {Finding} */ f) => { const r = [f['ruleId'], f['toolRule'] ? `tool: ${f['toolRule']}` : ''].filter(Boolean).join(' · '); return r ? ` · [${r}]` : '' }
  const fmt = (/** @type {Finding} */ f) => `- ${f['severity']} · \`${f['file'] || '?'}:${f['line'] || 0}\`${ruleTag(f)} · ${f['title']} · ${f['why']} · Fix: ${f['fix']}${f['whereChecked'] ? ` · Premise checked at: ${f['whereChecked']}` : ''}`
  const bySev = (/** @type {Finding[]} */ a) => a.slice().sort((/** @type {Finding} */ x, /** @type {Finding} */ y) => (SEV_RANK[x['severity'] ?? ''] ?? 9) - (SEV_RANK[y['severity'] ?? ''] ?? 9))
  return [
    `## Verdict`,
    // `notRun` LIVE, not the `incompleteNotes` snapshot taken before the verdict existed: the
    // revoked-premise path pushes into `notRun` afterwards, and a fallback rendered from the stale
    // snapshot would print a clean verdict over findings the same run has just declared unchecked.
    `${verdictMark} \u2014 ${cause}; mechanical fallback report (findings listed unmerged).${fallbackIncompleteClause()}`,
    ``, `## Gate`, mergedProvenance, carriedSection(),
    ...fallbackRereviewTracks(bySev, fmt),
    ``, `## ${isRereview ? '🆕 New' : 'Confirmed'}`, ...(confirmed.length ? bySev(confirmed).map(fmt) : ['- none']),
    ...(suspected.length ? [``, `## Suspected (needs confirmation)`, ...bySev(suspected).map(fmt)] : []),
    ...(unverified.length ? [``, `## Unverified (not checked)`, UNVERIFIED_PREAMBLE, ...bySev(unverified).map(fmt)] : []),
    ...(uncoveredFiles.length ? [``, `## Not reviewed (no language profile)`, ...uncoveredFiles.map((/** @type {string} */ f) => `- ${f}`)] : []),
  ].join('\n')
}

/** Why there is no synthesized report: the usage-limit stop first, then the synthesis agent's own failure. */
function fallbackCause() {
  if (limitStop.seen()) return limitStop.note()
  return synthesisUnusable ? 'synthesis agent returned no usable report' : 'synthesis agent died twice'
}

/** Never Approve over what did not run (realm @nick/craft, node #299): the same rule as the record. @param {string | undefined} emoji */
function fallbackVerdictMark(emoji) {
  return honestVerdict(isRereview ? recordVerdict : finalVerdict(confirmed), notRun) === 'INCOMPLETE' ? '\u26a0\ufe0f INCOMPLETE' : emoji
}

/** The fallback verdict line's incompleteness clause, read from the live `notRun`. */
function fallbackIncompleteClause() {
  return [...notRun, ...coverageNotes].length ? ` · ⚠️ ${notRun.length ? 'INCOMPLETE — part of this review did not run' : 'PARTIAL COVERAGE — a coverage hole a re-run will not fix'}: ${[...notRun, ...coverageNotes].join('; ')}.` : ''
}

/** A re-review's still-open and regressed tracks in the fallback report. @param {(a: Finding[]) => Finding[]} bySev @param {(f: Finding) => string} fmt @returns {string[]} */
function fallbackRereviewTracks(bySev, fmt) {
  return [
    ...(isRereview && adjudicated.stillOpen.length ? [``, `## 🔴 Still open`, ...bySev(adjudicated.stillOpen).map(fmt)] : []),
    ...(isRereview && adjudicated.regressed.length ? [``, `## ⚠️ Regressed`, ...bySev(adjudicated.regressed).map(fmt)] : []),
  ]
}

// APPENDED AFTER SYNTHESIS, because the synthesis prompt is composed before the verdict exists and
// therefore cannot carry this. The model wrote its report believing the run was a Block; if it was
// not, the reader is told here, in the report itself, rather than only on the run record.
// THE VERDICT LINE ITSELF, not only a section under it. The synthesis prompt was composed before
// the verdict existed, so the model wrote its `## Verdict` line believing the run was a Block — and
// a reader who has read a green verdict line has been misled, whatever a section at the bottom of
// the document says afterwards. The run record already says INCOMPLETE here, so without this the
// record and the report disagree, and rust-audit's dimension roll-up reads the verdict STRING: a
// clean line there carries the wrong-green up into the audit.
// Amends the first non-empty line under `## Verdict`, and only if it does not already say so.
/** @param {string} text */
function markVerdictIncomplete(text) {
  if (floorPremiseHeld) return text
  const lines = String(text).split('\n')
  const headingAt = lines.findIndex(l => /^#+\s*Verdict\b/i.test(l.trim()))
  if (headingAt < 0) return text
  const at = lines.findIndex((l, i) => i > headingAt && l.trim())
  if (at < 0 || /INCOMPLETE/.test(/** @type {string} */ (lines[at]))) return text
  lines[at] = `${lines[at]} · ⚠️ INCOMPLETE — ${savedByFloor.length} verification(s) were skipped because the verdict stood at Block, and the run did not end at Block; those findings are unverified for a reason that did not apply.`
  return lines.join('\n')
}

function floorPremiseSection() {
  if (floorPremiseHeld) return ''
  return `\n\n## ⚠️ INCOMPLETE — a verification saving whose premise did not hold\n`
    + `${savedByFloor.length} batch verification(s) were deliberately not dispatched because the verdict stood at Block when their turn came, and no judgement on a Medium can move a Block. The run ended at ${recordVerdict}. The saving therefore rested on a confirmed finding that did not reach the final verdict, and those findings are UNVERIFIED for no good reason — treat this section as a coverage hole and re-run. They are listed under Unverified above.\n`
    + savedByFloor.map(n => `- ${n}`).join('\n')
}

// Appended, not asked of the synthesis model: a finding set aside by a prior decision must reach the
// reader with that decision, whatever the model chose to render.
// The verbatim titles of the verdict's tool findings that name no rule: the engine's, never the model's (realm @nick/craft, node #236).
/** Every finding the report prints and the author can rule on: Confirmed (New on a re-review), Suspected, Unverified — most deadnix/statix seeds are Low and land Unverified — and on a re-review the still-open and regressed priors. A regressed prior prints under Regressed with the prior round's title; listing that title beside a fresh Low seed's at the same site lets the equal-title rule pick (realm @nick/craft, node #236); a Medium or higher fresh seed there is folded into the prior instead, unless the tool tells the two apart (#239). @returns {Finding[]} */
function verdictFindings() {
  const tiers = [...confirmed, ...suspected, ...unverified]
  return isRereview ? [...adjudicated.stillOpen, ...adjudicated.regressed, ...tiers] : tiers
}
return out(markVerdictIncomplete(honestVerdictLine(report || fallbackReport(), notRun)) + floorPremiseSection() + priorRejectedSection([...priorRejected, ...carriedDeferred()]) + projectRuleSection(priorRejected, ruleNotices) + contradictionSection(verdictFindings()) + doubtfulReport() + toolTitlesSection(verdictFindings()) + seamSetAsideSection(unitRuns) + unitNoticeSection(unitNotices) + scopeSection())
}
