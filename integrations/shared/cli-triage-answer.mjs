// What the triage engine returns (integrations/claude-code/src/triage-findings.js; realm @nick/craft, node #616): for a
// finished run, where its plan is — the session that launched it reads `plan.json` itself (the plan, the triage ledger,
// the issues to file), as it reads a review's report — with the plan's summary, which leads with what did not run; the
// text of a plan that failed; or the stop and how to resume. No model copies the plan.
import { telemetryLostSection } from './review-coverage.mjs'

/** @typedef {import('./cli-triage-step.mjs').TriageFinished} TriageFinished */

/** How a stopped run is resumed once agents answer again. @param {string} run */
export const triageResumeHint = run => `To resume it once agents can answer again: the Workflow \`craft:triage-findings run=${run}\` alone.`

/** `answer`, then each note that says something. @param {string} answer @param {string[]} notes */
export const withNotes = (answer, notes) => [answer, ...notes.filter(Boolean)].join('\n\n')

/** @param {string} why @returns {string} */
export const incompleteAnswer = why => `## Triage\n\n⚠️ INCOMPLETE — ${why}`

/**
 * The answer of a run the binary ended: stopped on the usage limit, its plan failed, or its plan written.
 * @param {TriageFinished} step @returns {string}
 */
export function finishedTriageAnswer(step) {
  const notes = [telemetryLostSection(step.filing?.lost ?? []).trim(), ...step.notes]
  if (step.stopped)
    return withNotes(incompleteAnswer(`${step.line || 'the run stopped'}. The run is in ${step.run}. ${triageResumeHint(step.run)}`), [
      'No run record is filed until the resumed run finishes.',
      ...notes,
    ])
  if (step.failed) return withNotes(`## Triage\n\n${step.failed}`, [`The plan file ${step.planFile} holds the same (run ${step.run}).`, ...notes])
  const read = `The plan is ${step.planFile} — read that file for the plan (\`plan_markdown\`), the triage ledger (\`ledger\`) and the issues to file (\`issues\`) (run ${step.run}).`
  return withNotes(`## Triage\n\n${read}`, [step.summary.trim(), ...notes])
}
