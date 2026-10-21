// What craft's hook says at the moment of work and to the subagent the work is handed to (realm @nick/craft,
// node #288; the counter-example it answers, #287): lines at session start reach neither the moment the human
// asks for review work nor a subagent's brief. Same repo test and off switch as the start hook (#275, #264);
// a subagent has no Workflow tool (#262). The harness surfaces it rests on are pinned in REALITY.md's rows.
import { findRepoRoot, readDeclarations, roleHookDecision, SWITCH_ENV } from './role-hook.mjs'
import { hookEvent, repoKey } from './hook-log.mjs'
import { promptKind } from './work-hook-kind.mjs'

// The Workflow tool's own agents (craft's engines among them) start as this subagent type: they are the loop.
const ENGINE_AGENT = 'workflow-subagent'

export const OFF = `craft: the repo's own roles and rules still win; to silence this, set ${SWITCH_ENV}=0 or add \`craft-role-hook: off\` to AGENTS.md or CLAUDE.md.`
export const MEMORY = 'craft:memory (record-decision, record-rule or record-question), and check the `memory backend:` line it prints'
export const PROMPT_TEXT = [
  'craft: before your first tool call on this request, load its craft skill: review findings or PR comments → craft:addressing-findings (Skill tool); a review → the craft:review workflow for one pass, craft:develop (Skill tool) for the loop to a PR. Reading the PRs with gh first does not replace it.',
  `craft: record each finding you reject or defer with ${MEMORY}.`,
  'craft: delegating this to a subagent? Put these same instructions in its brief, and keep the review loop here in the main session: a subagent cannot run craft\'s workflow engines.',
  OFF,
].join('\n')
export const SUBAGENT_TEXT = [
  `craft: if your brief is to work review findings or PR comments: before your first tool call load craft:addressing-findings (Skill tool) and work them with it, and record each one you reject or defer with ${MEMORY}; if your brief is to review: report findings only, change no code and record nothing.`,
  'craft: a subagent cannot run craft\'s workflow engines (craft:review, craft:develop\'s loop): report back and leave the review loop to the main session.',
  OFF,
].join('\n')

/** @typedef {import('./hook-log.mjs').HookEntry} HookEntry @typedef {{ stdout: string, entry: HookEntry | null }} HookRun */

/** @param {string} input @returns {Record<string, unknown>} */
function parse(input) {
  try {
    const v = /** @type {unknown} */ (JSON.parse(input))
    return v !== null && typeof v === 'object' ? /** @type {Record<string, unknown>} */ (v) : {}
  } catch { return {} }
}

/** @param {unknown} v @returns {string} */
const str = v => (typeof v === 'string' ? v : '')

/**
 * The repo test the start hook makes, at `cwd`: the log entry's common part and whether it speaks.
 * @param {string} cwd @param {string} session @param {Record<string, string | undefined>} env @param {Date} now
 * @param {string} event @returns {HookEntry}
 */
export function repoTest(cwd, session, env, now, event) {
  const root = findRepoRoot(cwd)
  const { found, silent } = roleHookDecision(readDeclarations(root), env)
  return { ts: now.toISOString(), repo: repoKey(root), source: '', event, session, spoke: silent === null, found, silent }
}

/**
 * @param {Record<string, unknown>} input @param {Record<string, string | undefined>} env @param {string} fallbackCwd
 * @param {Date} now @param {string} event @returns {HookEntry}
 */
const decide = (input, env, fallbackCwd, now, event) => repoTest(str(input['cwd']) || fallbackCwd, str(input['session_id']), env, now, event)

/** @param {string} event @param {string} text @returns {string} */
const context = (event, text) => JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: text } })

// A SessionStart from these sources empties the context the earlier lines lived in.
const CONTEXT_RESET = new Set(['compact', 'clear'])
// OpenCode's events for the same moments (lib/work-hook-opencode.mjs): a main session's message, its compaction.
const OPENCODE_PROMPT = 'chat.message'
const OPENCODE_RESET = 'session.compacted'

/**
 * Whether the prompt hook's lines are still in this session's context: it spoke there (a Claude Code
 * UserPromptSubmit line, or an OpenCode chat.message line without an agent, which only a subagent's carries), and
 * no line of the same session that empties its context — a SessionStart with a compact or clear source, an
 * OpenCode session.compacted — came after (the log is in append order).
 * @param {HookEntry[]} log @param {string} session @returns {boolean}
 */
export function saidInSession(log, session) {
  let said = false
  for (const e of log) {
    if (e.session !== session) continue
    const event = hookEvent(e)
    if ((event === 'UserPromptSubmit' || (event === OPENCODE_PROMPT && e.agent === undefined)) && e.spoke) said = true
    else if ((event === 'SessionStart' && CONTEXT_RESET.has(e.source)) || event === OPENCODE_RESET) said = false
  }
  return said
}

/**
 * A UserPromptSubmit run: silent and unlogged on a prompt of no class; otherwise the start hook's repo test,
 * and once per session until a compact or clear — the text stays in the session's context, and repeating it on
 * every message of a long review would bury the work under it; the class only names the request in the log.
 * @param {Record<string, unknown>} input @param {Record<string, string | undefined>} env @param {string} fallbackCwd
 * @param {Date} now @param {() => HookEntry[]} logged @returns {HookRun}
 */
function onPrompt(input, env, fallbackCwd, now, logged) {
  const kind = promptKind(str(input['prompt']))
  if (!kind) return { stdout: '', entry: null }
  const event = 'UserPromptSubmit'
  const entry = { ...decide(input, env, fallbackCwd, now, event), kind }
  const session = entry.session
  if (entry.spoke && session && saidInSession(logged(), session)) {
    Object.assign(entry, { spoke: false, silent: 'already-said' })
  }
  return { stdout: entry.spoke ? context(event, PROMPT_TEXT) : '', entry }
}

/**
 * A SubagentStart run: it speaks to the subagent only in a repo where the start hook would, in a session where
 * the prompt hook spoke (the harness gives this event no brief to classify), and never to the Workflow tool's
 * agents. The repo test runs before the log is read; a silent repo is not logged.
 * @param {Record<string, unknown>} input @param {Record<string, string | undefined>} env @param {string} fallbackCwd
 * @param {Date} now @param {() => HookEntry[]} logged @returns {HookRun}
 */
function onSubagent(input, env, fallbackCwd, now, logged) {
  const agent = str(input['agent_type'])
  const session = str(input['session_id'])
  if (agent === ENGINE_AGENT || !session) return { stdout: '', entry: null }
  const entry = { ...decide(input, env, fallbackCwd, now, 'SubagentStart'), agent }
  if (!entry.spoke || !logged().some(e => hookEvent(e) === 'UserPromptSubmit' && e.session === session && e.spoke)) return { stdout: '', entry: null }
  return { stdout: context('SubagentStart', SUBAGENT_TEXT), entry }
}

/**
 * One run of the work hook over the harness's JSON input, by its `hook_event_name`: `stdout` is '' for silence,
 * `entry` the line for the hook log or null when there is nothing to log. `logged` reads the log, only when needed.
 * @param {string} input @param {Record<string, string | undefined>} env @param {string} fallbackCwd @param {Date} now
 * @param {() => HookEntry[]} logged @returns {HookRun}
 */
export function workHook(input, env, fallbackCwd, now, logged) {
  const parsed = parse(input)
  const event = str(parsed['hook_event_name'])
  if (event === 'UserPromptSubmit') return onPrompt(parsed, env, fallbackCwd, now, logged)
  if (event === 'SubagentStart') return onSubagent(parsed, env, fallbackCwd, now, logged)
  return { stdout: '', entry: null }
}
