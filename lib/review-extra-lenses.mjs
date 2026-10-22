// The consumer's own reviewing agents, run by craft:review as extra lenses (realm @nick/craft, node #295):
// named by the caller, or discovered among the session project's own agent definitions.
//
// PURITY IS THE CONTRACT, as in lib/verify-economy.mjs: nothing here logs, dispatches or reads
// workflow state. The definitions are read by an agent (the sandbox has no filesystem); what to make of
// them is decided here, and pasted back into src/review.js through a `craft-inline` fenced region.

// An agent type as the harness names one: `reviewer`, `code-critic`, `team.security-v2`.
export const AGENT_TYPE_FORM = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,79}$/

// The values that turn the extra lenses off; an absent argument means "discover".
/** @type {unknown[]} */
export const EXTRA_LENSES_OFF = ['', false, 'false', 'none']

// Absent: discover when `discover` is set (the light profile), else none, so a full review stays as
// it was. Off, or an empty list: none. Otherwise the named agents, each once, a malformed name refused.
/** @param {unknown} raw @param {boolean} [discover] @returns {{ how: 'discovered' | 'named' | 'off', agents: string[], refused: string[] }} */
export function parseExtraLenses(raw, discover = true) {
  if (raw == null) return { how: discover ? 'discovered' : 'off', agents: [], refused: [] }
  if (EXTRA_LENSES_OFF.includes(raw)) return { how: 'off', agents: [], refused: [] }
  const items = Array.isArray(raw) ? /** @type {unknown[]} */ (raw) : String(raw).split(/[\s,]+/)
  const names = items.map(x => String(x ?? '').trim()).filter(Boolean)
  if (!names.length) return { how: 'off', agents: [], refused: [] }
  return {
    how: 'named',
    agents: [...new Set(names.filter(n => AGENT_TYPE_FORM.test(n)))],
    refused: names.filter(n => !AGENT_TYPE_FORM.test(n)).map(n => n.slice(0, 40)),
  }
}

/** @typedef {{ name?: unknown, description?: unknown, tools?: unknown, disallowedTools?: unknown }} AgentDefinition */

// The session project's agents that review and have no edit tool (the prompt tells them to stay read-only):
// a description that says it reviews or audits, no editing duty in it, never one of craft's own, and
// no edit tool granted (mayEdit).
/** @param {unknown} defs @returns {string[]} */
export function pickRepoReviewers(defs) {
  const REVIEW_WORDS = /\b(?:review|reviews|reviewer|reviewing|audit|audits|auditor|critic|critique|critiques)\b/i
  // A clause that says what the agent is NOT for ("Not for writing fixes, reviewing design") names no duty.
  const NEGATED_CLAUSE = /\bnot\s+(?:for|to|a|an)\b[^.]*/gi
  const EDITING_WORDS = /\b(?:edit|edits|implement|implements|refactor|refactors|apply|applies|write|writes|fix|fixes)\b[^.]*\b(?:code|files?|changes?|fix|fixes|patch|patches)\b/i
  const list = Array.isArray(defs) ? /** @type {AgentDefinition[]} */ (defs) : []
  const picked = list.map(agentFields).filter(a => AGENT_TYPE_FORM.test(a.name) && !/^craft:/i.test(a.name)
    && REVIEW_WORDS.test(a.duty.replace(NEGATED_CLAUSE, '')) && !EDITING_WORDS.test(a.duty.replace(NEGATED_CLAUSE, '')) && !mayEdit(a))
  return [...new Set(picked.map(a => a.name))]
}

export const EDIT_TOOL_NAMES = ['Edit', 'Write', 'MultiEdit', 'NotebookEdit']

// A Claude Code agent with no `tools` line inherits every tool, so it may edit unless its
// `disallowedTools` takes every edit tool away; a `tools` list may edit when it names one, or `*`.
/** @param {{ tools: string, disallowed: string }} a @returns {boolean} */
export function mayEdit(a) {
  /** @param {string} s */
  const names = s => s.split(/[^A-Za-z0-9_*]+/).filter(Boolean)
  const granted = names(a.tools)
  if (granted.length) return granted.some(t => t === '*' || EDIT_TOOL_NAMES.includes(t))
  const denied = names(a.disallowed)
  return !EDIT_TOOL_NAMES.every(t => denied.includes(t))
}

// A listed definition as plain strings, whatever shape the listing agent answered in.
/** @param {AgentDefinition | null | undefined} d @returns {{ name: string, duty: string, tools: string, disallowed: string }} */
export function agentFields(d) {
  /** @param {unknown} v */
  const text = v => (Array.isArray(v) ? v.join(' ') : String(v ?? ''))
  return { name: String(d?.name ?? '').trim(), duty: String(d?.description ?? ''), tools: text(d?.tools), disallowed: text(d?.disallowedTools) }
}

// Which extra lenses ran, and the language profile whose rubric verified their findings.
/** @param {string[]} ran @param {string} rubric @returns {string} */
export function extraLensRanLine(ran, rubric) {
  if (!ran.length) return 'Ran: none.'
  return `Ran: ${ran.join(', ')}.${rubric ? ` Their findings were verified under the ${rubric} profile's rubric, whatever file they cite.` : ''}`
}

/** @param {{ agent: string, why: string }} x */
export function extraLensGapMark(x) {
  return `- \u26a0\ufe0f coverage gap: ${x.agent} -- ${x.why}; its review did not happen.`
}

// A discovered lens that could not run: said, never a gap (realm @nick/craft, node #178).
/** @param {{ agent: string, why: string }} x */
export function extraLensSoftMark(x) {
  return `- ${x.agent} could not run: ${x.why} (discovered, not named, so no coverage gap).`
}

// Each lens that did not run: a gap when the caller named it, a plain line when discovery chose it.
/** @param {string} how @param {{ agent: string, why: string }[]} failed @returns {string[]} */
export function extraLensFailedLines(how, failed) {
  return failed.map(how === 'named' ? extraLensGapMark : extraLensSoftMark)
}

// The account on a run that ended before any lens ran: a discovery that did not run, or named lenses
// that did not run -- a gap when the diff had something to review, "not needed" when it had nothing.
/** @param {string} how @param {{ reason: string, needed: boolean }} exit @param {{ agent: string, why: string }[]} failed @returns {string} */
export function extraLensExitSection(how, exit, failed) {
  const head = how === 'discovered' ? [`Discovery did not run (${exit.reason}).`]
    : ['Chosen: named by the caller (extraLenses).', exit.needed ? 'Ran: none.' : `Ran: none. Not needed (${exit.reason}): there was nothing for them to review.`]
  return `\n\n## Extra lenses\n${[...head, ...failed.map(extraLensGapMark)].join('\n')}\n`
}

/**
 * The report's account of the extra lenses: which ran, how they were chosen, and each gap.
 * @param {{ how: string, ran: string[], failed: { agent: string, why: string }[], discovery: string, rubric?: string, exit?: { reason: string, needed: boolean } | null }} o
 * @returns {string}
 */
export function extraLensSection({ how, ran, failed, discovery, rubric = '', exit = null }) {
  if (how === 'off') return ''
  if (exit) return extraLensExitSection(how, exit, failed)
  if (how === 'discovered' && !ran.length && !failed.length) {
    return `\n\n## Extra lenses\nNo repo reviewer found: ${discovery || 'none of the repository\'s own agents describes itself as reviewing'} -- only the engine's own lenses ran. Name one with \`extraLenses: ["<agent>"]\`.\n`
  }
  const lines = [
    `Chosen: ${how === 'named' ? 'named by the caller (extraLenses)' : 'discovered among the session project\'s own agents'}.`,
    extraLensRanLine(ran, rubric),
    ...extraLensFailedLines(how, failed),
  ]
  return `\n\n## Extra lenses\n${lines.join('\n')}\n`
}
