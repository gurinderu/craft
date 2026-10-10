// The verbatim titles of the verdict's gate-tool findings that name no rule, appended to the report by
// the engine, not written by the synthesis model: such a finding is told apart from a past decision by
// its title alone, and the model's report line may reword it. A decision is recorded with the title
// listed here (realm @nick/craft, node #236). Inlined into src/review.js after
// lib/prior-decision-match.mjs, whose namesNoRule and findingLine it calls.
import { findingLine, namesNoRule } from './prior-decision-match.mjs'

/** @typedef {import('./prior-decisions.mjs').DecidableFinding} DecidableFinding */

/**
 * The section listing each verdict finding of a gate tool that names no rule, once, as
 * `file:line` and its title unchanged but for collapsed whitespace; '' when there is none.
 * @param {DecidableFinding[]} findings @returns {string}
 */
export function toolTitlesSection(findings) {
  const rows = findings.filter(namesNoRule).map(f => `- \`${String(f.file || '?')}:${findingLine(f)}\` · ${String(f.title ?? '').replace(/\s+/g, ' ').trim()}`)
  const unique = [...new Set(rows)]
  return unique.length ? `\n\n## Tool finding titles (verbatim)\n${unique.join('\n')}\n` : ''
}
