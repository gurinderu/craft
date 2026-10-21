// craft's hook at the moment of work in OpenCode (opencode/plugin/work-hook.ts; realm @nick/craft, node #288): the
// same request classes, repo test, off switch and hook log as the Claude Code hook (lib/work-hook.mjs), over what
// OpenCode's plugin API gives — a `chat.message` per user message, a child session's parent from `session.created`,
// `session.compacted`. OpenCode has no Workflow tool and no craft:develop: the lines name what its delivery ships.
import { hookEvent } from './hook-log.mjs'
import { repoTest, saidInSession } from './work-hook.mjs'
import { OFF } from './work-hook-text.mjs'
import { promptKind } from './work-hook-kind.mjs'

const EVENT = 'chat.message'
// The OpenCode installer links skills by directory name: the memory skill is `memory`, not `craft:memory`.
const MEMORY = 'the memory skill (record-decision, record-rule or record-question), and check the `memory backend:` line it prints'
export const OPENCODE_PROMPT_TEXT = [
  'craft: before your first tool call on this request, load its craft skill with the skill tool: review findings or PR comments → addressing-findings; a review of Rust code → rust-review, or the /rust-audit command for a whole crate. Reading the PRs with gh first does not replace it.',
  `craft: record each finding you reject or defer with ${MEMORY}.`,
  'craft: delegating this to a subagent? Put these same instructions in its brief.',
  OFF,
].join('\n')
export const OPENCODE_SUBAGENT_TEXT = [
  `craft: if your brief is to work review findings or PR comments: before your first tool call load addressing-findings (skill tool) and work them with it, and record each one you reject or defer with ${MEMORY}; if your brief is to review: report findings only, change no code and record nothing.`,
  OFF,
].join('\n')

/**
 * One user message: `prompt` its text, `session` its session, `cwd` the project directory; `parent` and `agent` only
 * on the first message of a subagent's session (its parent session and the agent it runs as).
 * @typedef {{ prompt: string, session: string, cwd: string, parent?: string, agent?: string }} OpencodeMessage
 * @typedef {import('./hook-log.mjs').HookEntry} HookEntry @typedef {{ text: string, entry: HookEntry | null }} OpencodeRun
 */

/**
 * A main session's message: silent and unlogged on a prompt of no class; otherwise the repo test, and once per
 * session until a compaction (lib/work-hook.mjs, onPrompt).
 * @param {OpencodeMessage} m @param {Record<string, string | undefined>} env @param {Date} now
 * @param {() => HookEntry[]} logged @returns {OpencodeRun}
 */
function onMessage(m, env, now, logged) {
  const kind = promptKind(m.prompt)
  if (!kind) return { text: '', entry: null }
  const entry = { ...repoTest(m.cwd, m.session, env, now, EVENT, true), kind }
  if (entry.spoke && saidInSession(logged(), m.session)) Object.assign(entry, { spoke: false, silent: 'already-said' })
  return { text: entry.spoke ? OPENCODE_PROMPT_TEXT : '', entry }
}

/**
 * A subagent's brief: it speaks in a repo where the start hook would, when the brief itself asks for review work or
 * its parent session heard the prompt lines; logged under the parent session with the agent, as SubagentStart is.
 * @param {OpencodeMessage & { parent: string }} m @param {Record<string, string | undefined>} env @param {Date} now
 * @param {() => HookEntry[]} logged @returns {OpencodeRun}
 */
function onSubagent(m, env, now, logged) {
  const kind = promptKind(m.prompt)
  const entry = { ...repoTest(m.cwd, m.parent, env, now, EVENT, true), agent: m.agent ?? '', ...(kind ? { kind } : {}) }
  if (!entry.spoke) return { text: '', entry: null }
  if (!kind && !logged().some(e => hookEvent(e) === EVENT && e.session === m.parent && e.agent === undefined && e.spoke)) return { text: '', entry: null }
  return { text: OPENCODE_SUBAGENT_TEXT, entry }
}

/**
 * One OpenCode user message: `text` is '' for silence, else the lines the plugin adds to the message; `entry` the
 * line for the hook log, or null. `logged` reads the log, only when needed.
 * @param {OpencodeMessage} m @param {Record<string, string | undefined>} env @param {Date} now
 * @param {() => HookEntry[]} logged @returns {OpencodeRun}
 */
export function opencodeMessage(m, env, now, logged) {
  return m.parent ? onSubagent({ ...m, parent: m.parent }, env, now, logged) : onMessage(m, env, now, logged)
}

/**
 * A session's compaction: the line that lets the prompt lines be said again (saidInSession), logged only for a
 * session where they were said.
 * @param {string} session @param {string} cwd @param {Date} now @param {() => HookEntry[]} logged @returns {HookEntry | null}
 */
export function opencodeCompacted(session, cwd, now, logged) {
  if (!saidInSession(logged(), session)) return null
  return { ...repoTest(cwd, session, {}, now, 'session.compacted', true), source: 'compact', spoke: false, found: [], silent: 'context-reset' }
}
