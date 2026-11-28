// The finished step `craft audit submit | status` prints, as the audit driver reads it (integrations/shared/cli-step-read.mjs
// reads every kind's pending step and status, and the fields every finished step carries; realm @nick/craft, node #588):
// the verdict, the report file, how many files the pass left unread and the file listing them, how many findings it
// left unjudged, and how many Low and Info findings it held unverified and the file listing them. The report itself is
// read from its file, by the session that launched the audit, never copied through a model.
import { isObject } from './cli-review-step.mjs'
import { stepText } from './cli-review-step-fields.mjs'
import { finishedFields, pathOf } from './cli-step-read.mjs'

/** @typedef {import('./cli-review-step.mjs').Filing} Filing */
/** @typedef {{ count: number, file: string }} Listed  how many, and the file that lists them ('' none) */
/** @typedef {{ run: string, done: true, verdict: string, report: string, recordFile: string, unread: Listed, unjudged: number, unverifiedLow: Listed, stopped: boolean, line: string, resume: string, degraded: string[], notes: string[], filing: Filing | null }} AuditFinished  stopped: the binary held the run on the usage limit — no report, `line` says why; resume: the binary's command that goes on with it, '' when there is nothing to go on with */

/** A count the binary printed, 0 when it printed none. @param {unknown} v @returns {number} */
const countOf = v => (typeof v === 'number' && Number.isSafeInteger(v) && v > 0 ? v : 0)

/** A count with the file listing it. @param {unknown} v @returns {Listed} */
const listedOf = v => (isObject(v) ? { count: countOf(v['count']), file: pathOf(v['file']) } : { count: 0, file: '' })

/**
 * A finished step's fields, or why it cannot be read: neither stopped nor naming its verdict and report file.
 * @param {Record<string, unknown>} v @returns {{ step: AuditFinished } | { error: string }}
 */
export function auditFinished(v) {
  const base = finishedFields(v)
  const report = pathOf(v['report'])
  const verdict = stepText(v['verdict']).trim()
  if (!base.stopped && !report) return { error: 'a finished step names no report file' }
  if (!base.stopped && !verdict) return { error: 'a finished step names no verdict' }
  return {
    step: { ...base, verdict, report, unread: listedOf(v['unread']), unjudged: countOf(v['unjudged']), unverifiedLow: listedOf(v['unverifiedLow']) },
  }
}
