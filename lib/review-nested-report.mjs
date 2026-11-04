// The nested adversarial review's part of the review's report and record (realm @nick/craft, node #420): the
// labelled section, its external sources under it (node #430), and the run record's `nestedReview` field.
// Pure: no agent, no log, no workflow state.
import { summarizeFindings } from './run-record.mjs'
import { NESTED_ENGINE } from './review-nested-verdict.mjs'
import { NESTED_OWN_LINE } from './external-source-text.mjs'

/** @typedef {import('./review-nested-verdict.mjs').NestedFinding} NestedFinding @typedef {import('./review-nested-verdict.mjs').NestedOutcome} NestedOutcome */

/** @param {NestedFinding} f */
const capitalized = f => ({ ...f, severity: typeof f.severity === 'string' ? f.severity.charAt(0).toUpperCase() + f.severity.slice(1) : f.severity })
/** @param {NestedFinding} f */
const nestedFindingLine = f => `- ${capitalized(f).severity} · \`${String(f.file ?? '?')}:${Number(f.line) || 0}\` · ${String(f.title ?? '')} · ${String(f.description ?? '')} · Fix: ${String(f.fix ?? '')} · [${NESTED_ENGINE}]`

/**
 * The labelled section of the report the nested part brings.
 * @param {NestedOutcome} nested @param {boolean} posting  the run posts its findings on a PR @returns {string}
 */
export function nestedSection(nested, posting) {
  const head = `\n\n## Files outside every profile — nested ${NESTED_ENGINE}\n`
  const files = `Files: ${nested.files.join(', ')}`
  if (!nested.ran) return `${head}⚠️ It did not run (${nested.why}); these files were NOT reviewed. ${files}\n`
  return `${head}Its verdict: ${nested.verdict} · ${files}\n`
    + `\n### Confirmed\n${nested.confirmed.length ? nested.confirmed.map(nestedFindingLine).join('\n') : '- none'}\n`
    + (nested.suspected.length ? `\n### Suspected (needs confirmation)\n${nested.suspected.map(nestedFindingLine).join('\n')}\n` : '')
    + (nested.notRun.length ? `\n### Not run in it\n${nested.notRun.map(n => `- ${n}`).join('\n')}\n` : '')
    + (nested.externalSources ? `\n${nested.externalSources.replace(/^## /, '### ')}\n` : '')
    + (nested.dropped ? `\n${nested.dropped} of its finding(s) lay outside these files and were set aside: the rest of the diff is this review's own.\n` : '')
    + (posting ? '\nThese findings are not posted on the PR: only the profile review\'s are.\n' : '')
}

/** The run record's `nestedReview` field. @param {NestedOutcome} nested */
export function nestedRecord(nested) {
  return {
    name: NESTED_ENGINE, ran: nested.ran, files: nested.files, verdict: nested.ran ? nested.verdict : null,
    findings: summarizeFindings([...nested.confirmed, ...nested.suspected].map(capitalized)), notRun: nested.notRun,
  }
}

/**
 * A nested `## External sources` section once the review adopted its prep: only the systems its findings named that
 * memory lacks and its discovery's lines (node #435: the review left those files to it) — the review's own section
 * already lists what was prepared and what failed. '' when none.
 * @param {string} section @returns {string}
 */
export function unrecordedOnly(section) {
  const lines = section.split('\n').filter(l => NESTED_OWN_LINE.test(l))
  return lines.length ? `## External sources\n${lines.join('\n')}` : ''
}
