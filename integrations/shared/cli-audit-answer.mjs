// What the audit engine returns (integrations/claude-code/src/audit.js; realm @nick/craft, node #588): for a finished
// pass, its verdict, where its report is — the session that launched it reads `report.md` itself, as it reads a
// review's — and the counts of what it left unread, unjudged and unverified, with the files listing them and how to go
// on; or the stop and how to resume (integrations/shared/cli-step-answer.mjs). A pass that left a file unread or a
// finding unjudged never reads as a clean one, whatever its verdict says. No model copies the report.
import { finishedNotes, resumeHint, stoppedAnswer, withNotes } from './cli-step-answer.mjs'

/** @typedef {import('./cli-audit-step.mjs').AuditFinished} AuditFinished */

/** Whether the pass left anything it promised undone. @param {AuditFinished} step */
const incomplete = step => /INCOMPLETE/.test(step.verdict) || step.unread.count > 0 || step.unjudged > 0

/** The verdict line: a pass left incomplete said so first. @param {AuditFinished} step @returns {string} */
const verdictLine = step =>
  incomplete(step) ? `⚠️ INCOMPLETE — verdict ${step.verdict}: the audit did not read or judge all of what it was given.` : `Verdict: ${step.verdict}`

/** The files that list what the pass left, each named. @param {AuditFinished} step @returns {string[]} */
const listFiles = step => [
  step.unread.count && step.unread.file ? `The unread files are listed in ${step.unread.file}.` : '',
  step.unverifiedLow.count && step.unverifiedLow.file ? `The unverified Low and Info findings are listed in ${step.unverifiedLow.file}.` : '',
]

/** How to go on with a pass the binary says can be resumed. @param {AuditFinished} step @returns {string} */
const goOn = step =>
  step.resume || incomplete(step)
    ? `${resumeHint('audit', step.run)} It reads what was left unread, judges what was left unjudged, or files again a record that did not land.`
    : ''

/**
 * The answer of a run the binary ended: stopped on the usage limit, or its pass ended with a report.
 * @param {AuditFinished} step @returns {string}
 */
export function finishedAuditAnswer(step) {
  if (step.stopped) return stoppedAnswer('Audit', 'audit', step)
  const counts = `Counts: unread=${step.unread.count} file(s), unjudged=${step.unjudged} finding(s), unverifiedLow=${step.unverifiedLow.count} finding(s).`
  const read = `The report is ${step.report} — read that file for the findings (run ${step.run}).`
  return withNotes(`## Audit\n\n${verdictLine(step)}\n\n${read}\n\n${counts}`, [
    ...listFiles(step),
    goOn(step),
    step.degraded.length ? `Ran weaker than asked: ${step.degraded.join('; ')}` : '',
    'Nothing was posted to a PR or an issue: to work the findings, hand the report to `craft:addressing-findings`, where every accepted audit finding is not this PR’s.',
    ...finishedNotes(step),
  ])
}
