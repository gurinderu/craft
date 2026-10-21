// Whether the prompt hook's lines are still in a session's context, read back from the hook log (realm @nick/craft,
// node #288): the lines of Claude Code, Codex and OpenCode alike.
import { hookEvent } from './hook-log.mjs'

/** @typedef {import('./hook-log.mjs').HookEntry} HookEntry */

// A SessionStart from these sources empties the context the earlier lines lived in.
const CONTEXT_RESET = new Set(['compact', 'clear'])
// OpenCode's events for the same moments (lib/work-hook-opencode.mjs): a main session's message, its compaction.
const OPENCODE_PROMPT = 'chat.message'
const OPENCODE_RESET = 'session.compacted'

/**
 * Whether a log line is the prompt hook speaking a request's text in a main session, for one of `kinds` when they
 * are given; a line with a `reason` said something else (the re-review nudge) and is no request's text.
 * @param {HookEntry} e @param {string} event @param {string[]} [kinds] @returns {boolean}
 */
function promptSpoke(e, event, kinds) {
  const prompt = event === 'UserPromptSubmit' || (event === OPENCODE_PROMPT && e.agent === undefined)
  return prompt && e.spoke && e.reason === undefined && (kinds === undefined || kinds.includes(e.kind ?? ''))
}

/**
 * Whether the prompt hook's lines are still in this session's context: it spoke there (a Claude Code
 * UserPromptSubmit line, or an OpenCode chat.message line without an agent, which only a subagent's carries), and
 * no line of the same session that empties its context — a SessionStart with a compact or clear source, an
 * OpenCode session.compacted — came after (the log is in append order). With `kinds`, only lines said for a
 * request of one of those kinds count: their texts differ per kind (coveredBy, lib/work-hook-text.mjs).
 * @param {HookEntry[]} log @param {string} session @param {string[]} [kinds] @returns {boolean}
 */
export function saidInSession(log, session, kinds) {
  let said = false
  for (const e of log) {
    if (e.session !== session) continue
    const event = hookEvent(e)
    if (promptSpoke(e, event, kinds)) said = true
    else if ((event === 'SessionStart' && CONTEXT_RESET.has(e.source)) || event === OPENCODE_RESET) said = false
  }
  return said
}
