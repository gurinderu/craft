// What the triage engine returns (integrations/claude-code/src/triage-findings.js; realm @nick/craft, node #616): for a
// finished run, where its plan is — the session that launched it reads `plan.json` itself (the plan, the triage ledger,
// the issues to file), as it reads a review's report — with the plan's summary, which leads with what did not run; the
// text of a plan that failed; or the stop and how to resume (integrations/shared/cli-step-answer.mjs). No model copies
// the plan.
import { finishedNotes, stoppedAnswer, withNotes } from './cli-step-answer.mjs'

/** @typedef {import('./cli-triage-step.mjs').TriageFinished} TriageFinished */

/**
 * The answer of a run the binary ended: stopped on the usage limit, its plan failed, or its plan written.
 * @param {TriageFinished} step @returns {string}
 */
export function finishedTriageAnswer(step) {
  if (step.stopped) return stoppedAnswer('Triage', 'triage-findings', step)
  const notes = finishedNotes(step)
  if (step.failed) return withNotes(`## Triage\n\n${step.failed}`, [`The plan file ${step.planFile} holds the same (run ${step.run}).`, ...notes])
  const read = `The plan is ${step.planFile} — read that file for the plan (\`plan_markdown\`), the triage ledger (\`ledger\`) and the issues to file (\`issues\`) (run ${step.run}).`
  return withNotes(`## Triage\n\n${read}`, [step.summary.trim(), ...notes])
}
