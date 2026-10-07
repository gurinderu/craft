// The prior-decision sections of a review report (lib/prior-decisions.mjs, lib/prior-decision-apply.mjs
// write them), lifted out whole for an engine that keeps a nested report only up to a bound: the
// sections sit at the report's tail, where the bound cuts, so they are carried apart and appended to
// the outer report verbatim — never summarised by a model, never cut.
// Inlined into workflows/rust-audit.js, and its absence section into workflows/review.js and
// workflows/adversarial-review.js (no imports: the sandbox has no module system).

export const PRIOR_DECISION_HEADINGS = ['## Rejected before (set aside — not in the verdict)', '## Prior decisions not applied']

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

// A launch without priorDecisions applied no project memory, and only the report can say so: the
// recall step lives in the launching session, which a direct Workflow launch skips. An empty list is
// present — recall ran and found nothing — so it says nothing; '' is absent, as parsePriorDecisions reads it.
export const PRIOR_DECISIONS_ABSENT = 'no remembered decisions were passed (priorDecisions absent), so project memory was not applied — before launching, call recall of the craft:memory skill for the paths of the diff and pass its active decisions as {priorDecisions: [...]} (an empty list when it finds none)'

/** @param {unknown} raw @returns {boolean} */
export function priorDecisionsAbsent(raw) {
  return raw == null || raw === ''
}

/** The report section naming an absent priorDecisions; '' when it was given. @param {unknown} raw @returns {string} */
export function priorDecisionsAbsentSection(raw) {
  return priorDecisionsAbsent(raw) ? `\n\n## Prior decisions not passed\n- ⚠️ ${PRIOR_DECISIONS_ABSENT}\n` : ''
}
