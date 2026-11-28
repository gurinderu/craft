// The Claude Code driver of the audit of a whole project on the CLI's step protocol (integrations/claude-code/src/audit.js;
// realm @nick/craft, node #588): the `craft` binary decides what an audit needs — the scout of the tracked files, the
// batches, the lens agents a pass buys, the verifiers of Medium and above, the report and the record — and the shared
// driver (integrations/shared/cli-step-driver.mjs) runs the agents each step hands out and hands their answers back.
// What is the audit's own: its arguments, its start, its finished step and its answer, the verdict and where the
// report is.
import { readAuditOptions } from './cli-audit-options.mjs'
import { auditStart, auditStartTimeout } from './cli-audit-commands.mjs'
import { auditFinished } from './cli-audit-step.mjs'
import { finishedAuditAnswer } from './cli-audit-answer.mjs'
import { runCliSteps } from './cli-step-driver.mjs'

/** @typedef {import('./cli-review-steps.mjs').Sandbox} Sandbox */
/** @typedef {import('./cli-audit-options.mjs').AuditOptions} AuditOptions @typedef {import('./cli-audit-step.mjs').AuditFinished} AuditFinished */

/** @type {import('./cli-step-read.mjs').StepKind<AuditOptions, AuditFinished>} */
const AUDIT = {
  engine: 'audit',
  kind: 'audit',
  title: 'Audit',
  // A pass is its lens round and its verifiers' round, each handed out again for a refused answer.
  maxRounds: 12,
  readOptions: readAuditOptions,
  start: auditStart,
  startTimeout: auditStartTimeout,
  finished: auditFinished,
  answer: finishedAuditAnswer,
}

/**
 * One audit run, then its answer: the verdict and where the report is, or why there is none.
 * @param {Sandbox} sb @param {string} craftVersion @returns {Promise<string>}
 */
export const runCliAudit = (sb, craftVersion) => runCliSteps(sb, craftVersion, AUDIT)
