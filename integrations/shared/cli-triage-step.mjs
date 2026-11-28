// The finished step `craft triage submit | status` prints, as the triage driver reads it (integrations/shared/cli-step-read.mjs
// reads every kind's pending step and status, and the fields every finished step carries; realm @nick/craft, node #616):
// its plan file, the plan's summary — or the text of a plan that failed. The plan itself is read from its file, by the
// session that launched the triage, never copied through a model.
import { stepText } from './cli-review-step-fields.mjs'
import { finishedFields, pathOf } from './cli-step-read.mjs'

/** @typedef {import('./cli-review-step.mjs').Filing} Filing */
/** @typedef {{ run: string, done: true, planFile: string, recordFile: string, summary: string, failed: string, stopped: boolean, line: string, resume: string, degraded: string[], notes: string[], filing: Filing | null }} TriageFinished  stopped: the binary held the run on the usage limit — no plan, `line` says why and `resume` how to go on; failed: the text of a plan that failed, '' else */

/**
 * A finished step's fields, or why it cannot be read: neither stopped nor naming its plan file.
 * @param {Record<string, unknown>} v @returns {{ step: TriageFinished } | { error: string }}
 */
export function triageFinished(v) {
  const base = finishedFields(v)
  const planFile = pathOf(v['planFile'])
  if (!base.stopped && !planFile) return { error: 'a finished step names no plan file' }
  return { step: { ...base, planFile, summary: stepText(v['summary']), failed: stepText(v['failed']) } }
}
