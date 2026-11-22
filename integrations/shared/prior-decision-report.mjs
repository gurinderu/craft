// The prior-decision sections of a review report (integrations/shared/prior-decisions.mjs, integrations/shared/prior-decision-apply.mjs
// write them), lifted out whole for an engine that keeps a nested report only up to a bound: the
// sections sit at the report's tail, where the bound cuts, so they are carried apart and appended to
// the outer report verbatim — never summarised by a model, never cut.
// Imported by integrations/claude-code/src/rust-audit.js.

// The verbatim tool titles ride with them: a decision is recorded by those titles, and a model summarising
// the nested report would reword them (realm @nick/craft, node #236).
// The project rules' section rides with them (realm @nick/craft, node #273): what a rule covered is out of the verdict;
// so do a High a human's decision set aside and a High a rule covers, kept for a human to confirm (node #196).
// The findings going against a memory record ride too (realm @nick/craft, #281): they are in the verdict, but which
// record each contradicts is memory's fact, and the nested report's file is the only other place it is said.
export const PRIOR_DECISION_HEADINGS = [
  '## High rejected by a human (set aside — not in the verdict)',
  '## Rejected before (set aside — not in the verdict)',
  '## Known and deferred (open question — not in the verdict)',
  '## Covered by project rules (not in the verdict)',
  '## High covered by a project rule — confirm (still in the verdict)',
  '## Contradicts project memory — a defect when confirmed, whatever the other doubt signs say',
  '## Prior decisions not applied',
  '## Tool finding titles (verbatim)',
]

/**
 * The report without its prior-decision sections, and those sections, each from its heading to the
 * next `## ` heading or the end.
 * @param {string} report @returns {{ rest: string, lifted: string }}
 */
export function liftPriorDecisionSections(report) {
  const lines = report.split('\n')
  /** @type {string[]} */
  const rest = []
  /** @type {string[]} */
  const lifted = []
  let inside = false
  for (const line of lines) {
    if (line.startsWith('## ')) inside = PRIOR_DECISION_HEADINGS.includes(line.trim())
    ;(inside ? lifted : rest).push(line)
  }
  return { rest: rest.join('\n'), lifted: lifted.join('\n').trim() }
}

/**
 * The outer report's section carrying every nested review's lifted text under its dimension; '' when
 * none had any.
 * @param {Array<{ dimension: string, text: string }>} lifted @returns {string}
 */
export function nestedPriorDecisionsSection(lifted) {
  const given = lifted.filter(l => l.text)
  if (!given.length) return ''
  return `\n\n## Prior decisions in the nested reviews (verbatim)\n${given.map(l => `### ${l.dimension}\n${l.text}`).join('\n\n')}\n`
}
