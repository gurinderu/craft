// What the hook log says about a session for the OpenCode work hook (realm @nick/craft, node #288): whether the
// prompt lines are still in the session's context. The lines of Claude Code, Codex and OpenCode alike; the craft
// binary reads them the same way for Claude Code and Codex (cli/bin/craft/src/hook/role/heard.rs).
import { hookEvent } from './hook-log.mjs'
import { coveredBy } from './work-hook-text.mjs'

/** @typedef {import('./hook-log.mjs').HookEntry} HookEntry @typedef {import('./work-hook-kind.mjs').PromptKind} PromptKind */

// A SessionStart from these sources empties the context the earlier lines lived in.
const CONTEXT_RESET = new Set(['compact', 'clear'])
// OpenCode's events for the same moments (lib/work-hook-opencode.mjs): a main session's message, its compaction.
const OPENCODE_PROMPT = 'chat.message'
const OPENCODE_RESET = 'session.compacted'
// The `reason` of the one line a later prompt in another script hears (realm @nick/craft, #288).
export const REMINDER = 'language-reminder'

/** A line that empties its session's context. @param {HookEntry} e @returns {boolean} */
function reset(e) {
  const event = hookEvent(e)
  return (event === 'SessionStart' && CONTEXT_RESET.has(e.source)) || event === OPENCODE_RESET
}

/**
 * The session's lines since its context was last emptied (the log is in append order).
 * @param {HookEntry[]} log @param {string} session @returns {HookEntry[]}
 */
function sinceReset(log, session) {
  /** @type {HookEntry[]} */
  let mine = []
  for (const e of log) {
    if (e.session !== session) continue
    if (reset(e)) mine = []
    else mine.push(e)
  }
  return mine
}

/**
 * Whether a log line is the prompt hook speaking a request's text in a main session, for one of `kinds` when they
 * are given; a line with a `reason` said something else (the re-review nudge, the reminder) and is no request's text.
 * @param {HookEntry} e @param {string[]} [kinds] @returns {boolean}
 */
function promptSpoke(e, kinds) {
  const event = hookEvent(e)
  const prompt = event === 'UserPromptSubmit' || (event === OPENCODE_PROMPT && e.agent === undefined)
  return prompt && e.spoke && e.reason === undefined && (kinds === undefined || kinds.includes(e.kind ?? ''))
}

/**
 * Whether the prompt hook's lines are still in this session's context: it spoke there (a Claude Code
 * UserPromptSubmit line, or an OpenCode chat.message line without an agent, which only a subagent's carries), and
 * no line of the same session that empties its context — a SessionStart with a compact or clear source, an
 * OpenCode session.compacted — came after. With `kinds`, only lines said for a request of one of those kinds
 * count: their texts differ per kind (coveredBy, lib/work-hook-text.mjs).
 * @param {HookEntry[]} log @param {string} session @param {string[]} [kinds] @returns {boolean}
 */
export function saidInSession(log, session, kinds) {
  return sinceReset(log, session).some(e => promptSpoke(e, kinds))
}

/**
 * What a prompt of `kind` hears when its text was already said in the session's context: nothing for a per-kind
 * text (`already-said`), the reminder line for the conditional one (REMINDER); null when that text is not there.
 * @param {HookEntry[]} log @param {string} session @param {string | undefined} who @param {PromptKind} kind
 * @returns {'already-said' | typeof REMINDER | null}
 */
export function repeatOf(log, session, who, kind) {
  if (!saidInSession(log, session, coveredBy(who, kind))) return null
  return kind === 'other-language' ? REMINDER : 'already-said'
}
