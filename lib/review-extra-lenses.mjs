// The consumer's own reviewing agents, run by craft:review as extra lenses (realm @nick/craft, node #295):
// named by the caller, or discovered among the repository's own agent definitions.
//
// PURITY IS THE CONTRACT, as in lib/verify-economy.mjs: nothing here logs, dispatches or reads
// workflow state. The definitions are read by an agent (the sandbox has no filesystem); what to make of
// them is decided here, and pasted back into src/review.js through a `craft-inline` fenced region.

// An agent type as the harness names one: `reviewer`, `code-critic`, `team.security-v2`.
export const AGENT_TYPE_FORM = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,79}$/

// The values that turn the extra lenses off; an absent argument means "discover".
/** @type {unknown[]} */
export const EXTRA_LENSES_OFF = ['', false, 'false', 'none']

// Absent: discover. Off, or an empty list: none. Otherwise the named agents, each once, a malformed
// name refused by name.
/** @param {unknown} raw @returns {{ how: 'discovered' | 'named' | 'off', agents: string[], refused: string[] }} */
export function parseExtraLenses(raw) {
  if (raw == null) return { how: 'discovered', agents: [], refused: [] }
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

/** @typedef {{ name?: unknown, description?: unknown, tools?: unknown }} AgentDefinition */

// The repository's agents that review and do not edit: a description that says it reviews or audits,
// no edit tool granted by name, no editing duty in its description, and never one of craft's own.
/** @param {unknown} defs @returns {string[]} */
export function pickRepoReviewers(defs) {
  const REVIEW_WORDS = /\b(?:review|reviews|reviewer|reviewing|audit|audits|auditor|critic|critique|critiques)\b/i
  // A clause that says what the agent is NOT for ("Not for writing fixes, reviewing design") names no duty.
  const NEGATED_CLAUSE = /\bnot\s+(?:for|to|a|an)\b[^.]*/gi
  const EDITING_WORDS = /\b(?:edit|edits|implement|implements|refactor|refactors|apply|applies|write|writes|fix|fixes)\b[^.]*\b(?:code|files?|changes?|fix|fixes|patch|patches)\b/i
  const EDIT_TOOLS = /\b(?:Edit|Write|MultiEdit|NotebookEdit)\b/
  const list = Array.isArray(defs) ? /** @type {AgentDefinition[]} */ (defs) : []
  const picked = list.map(agentFields).filter(a => AGENT_TYPE_FORM.test(a.name) && !/^craft:/i.test(a.name)
    && REVIEW_WORDS.test(a.duty.replace(NEGATED_CLAUSE, '')) && !EDITING_WORDS.test(a.duty.replace(NEGATED_CLAUSE, '')) && !EDIT_TOOLS.test(a.tools))
  return [...new Set(picked.map(a => a.name))]
}

// A listed definition as plain strings, whatever shape the listing agent answered in.
/** @param {AgentDefinition | null | undefined} d @returns {{ name: string, duty: string, tools: string }} */
export function agentFields(d) {
  const tools = d?.tools
  return { name: String(d?.name ?? '').trim(), duty: String(d?.description ?? ''), tools: Array.isArray(tools) ? tools.join(' ') : String(tools ?? '') }
}

/**
 * The report's account of the extra lenses: which ran, how they were chosen, and each gap.
 * @param {{ how: string, ran: string[], failed: { agent: string, why: string }[], discovery: string }} o
 * @returns {string}
 */
export function extraLensSection({ how, ran, failed, discovery }) {
  if (how === 'off') return ''
  if (how === 'discovered' && !ran.length && !failed.length) {
    return `\n\n## Extra lenses\nNo repo reviewer found: ${discovery || 'none of the repository\'s own agents describes itself as reviewing'} -- only the engine's own lenses ran. Name one with \`extraLenses: ["<agent>"]\`.\n`
  }
  const lines = [
    `Chosen: ${how === 'named' ? 'named by the caller (extraLenses)' : 'discovered among the repository\'s own agents'}.`,
    `Ran: ${ran.length ? ran.join(', ') : 'none'}.`,
    ...failed.map(x => `- \u26a0\ufe0f coverage gap: ${x.agent} -- ${x.why}; its review did not happen.`),
  ]
  return `\n\n## Extra lenses\n${lines.join('\n')}\n`
}
