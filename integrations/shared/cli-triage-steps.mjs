// The Claude Code driver of the triage on the CLI's step protocol (integrations/claude-code/src/triage-findings.js; realm
// @nick/craft, node #616): the `craft` binary decides what a triage needs — the gatherers, the memory's recall and
// judges, the validators, the plan — and the shared driver (integrations/shared/cli-step-driver.mjs) runs the agents each
// step hands out and hands their answers back. What is the triage's own: its arguments, its start, its finished step
// and its answer, where the plan is.
import { readTriageOptions } from './cli-triage-options.mjs'
import { triageStart, triageStartTimeout } from './cli-triage-commands.mjs'
import { triageFinished } from './cli-triage-step.mjs'
import { finishedTriageAnswer } from './cli-triage-answer.mjs'
import { runCliSteps } from './cli-step-driver.mjs'

/** @typedef {import('./cli-review-steps.mjs').Sandbox} Sandbox */
/** @typedef {import('./cli-triage-options.mjs').TriageOptions} TriageOptions @typedef {import('./cli-triage-step.mjs').TriageFinished} TriageFinished */

/** @type {import('./cli-step-read.mjs').StepKind<TriageOptions, TriageFinished>} */
const TRIAGE = {
  engine: 'triage-findings',
  kind: 'triage',
  title: 'Triage',
  maxRounds: 12,
  readOptions: readTriageOptions,
  start: triageStart,
  startTimeout: triageStartTimeout,
  finished: triageFinished,
  answer: finishedTriageAnswer,
}

/**
 * One triage run, then its answer: where the plan is, or why there is none.
 * @param {Sandbox} sb @param {string} craftVersion @returns {Promise<string>}
 */
export const runCliTriage = (sb, craftVersion) => runCliSteps(sb, craftVersion, TRIAGE)
