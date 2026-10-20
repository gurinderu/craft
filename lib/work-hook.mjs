// What craft's hook says at the moment of work and to the subagent the work is handed to (realm @nick/craft,
// node #288; the counter-example it answers, #287): lines at session start reach neither the moment the human
// asks for review work nor a subagent's brief. Same repo test and off switch as the start hook (#275, #264);
// a subagent has no Workflow tool (#262). The harness surfaces it rests on are pinned in REALITY.md's rows.
import { findRepoRoot, readDeclarations, roleHookDecision, SWITCH_ENV } from './role-hook.mjs'
import { hookEvent, repoKey } from './hook-log.mjs'

// The harness hands a background agent's result back as a prompt; its words are the agent's, not a request.
const NOT_A_REQUEST = /^\s*<task-notification>/
// JS's \b is ASCII-only, so a Cyrillic word edge is "no letter beside it".
const RU = '(?<!\\p{L})'
// Working findings or PR comments. A bare "fix" or "comments" is ordinary coding talk, so it counts only beside
// review words; "фикс" without that context also stands in "зафиксируй" (record) and "фиксация" (fixation).
const FINDINGS = [
  /\bfindings?\b/i,
  /\b(?:review|PR|pull[- ]request|reviewer'?s?)\s+(?:comments?|feedback|threads?|notes?|remarks?)\b/i,
  /\bcomments?\s+(?:on|in|from)\s+(?:the\s+|this\s+|that\s+|my\s+|our\s+|your\s+)?(?:PR|pull[- ]request|review(?:er)?)\b/i,
  /\b(?:fix|address|resolve|apply)(?:es|ed|ing)?\s+(?:the\s+|all\s+|these\s+|those\s+)?(?:review|PR)\b/i,
  new RegExp(`${RU}(?:находк|замечани)\\p{L}*`, 'iu'),
  new RegExp(`${RU}комментари\\p{L}*\\s+(?:к|в|на|по|из)\\s+(?:PR|MR|пр|пул+[- ]?реквест\\p{L}*|ревью)(?!\\p{L})`, 'iu'),
  new RegExp(`${RU}(?:по|за)?фикс(?!ир|ац)\\p{L}*\\s+(?:по|к|в|на|из)\\s+(?:PR|MR|пр|ревью|комментари\\p{L}*|замечани\\p{L}*)(?!\\p{L})`, 'iu'),
]
// Asking for a review or naming a PR. "reviewed" is a report about the past and "preview" another word.
const REVIEW = [
  /\breview(?:s|ing)?\b/i,
  /\bPRs?\b/,
  /\bpull[- ]requests?\b/i,
  new RegExp(`${RU}ревью\\p{L}*`, 'iu'),
  new RegExp(`${RU}пул+[- ]?реквест\\p{L}*`, 'iu'),
]
// The Workflow tool's own agents (craft's engines among them) start as this subagent type: they are the loop.
const ENGINE_AGENT = 'workflow-subagent'

const OFF = `craft: the repo's own roles and rules still win; to silence this, set ${SWITCH_ENV}=0 or add \`craft-role-hook: off\` to AGENTS.md or CLAUDE.md.`
const MEMORY = 'craft:memory (record-decision, record-rule or record-question), and check the `memory backend:` line it prints'
export const PROMPT_TEXT = [
  'craft: review findings or PR comments → work them with craft:addressing-findings; a review → craft:review for one pass, craft:develop for the loop to a PR.',
  `craft: record each finding you reject or defer with ${MEMORY}.`,
  'craft: delegating this to a subagent? Put these same instructions in its brief, and keep the review loop here in the main session: a subagent cannot run craft\'s workflow engines.',
  OFF,
].join('\n')
export const SUBAGENT_TEXT = [
  `craft: if your brief is review findings, PR comments or a review: work findings with craft:addressing-findings, and record each one you reject or defer with ${MEMORY}.`,
  'craft: a subagent cannot run craft\'s workflow engines (craft:review, craft:develop\'s loop): report back and leave the review loop to the main session.',
  OFF,
].join('\n')

/**
 * The class of a human prompt: `findings` (working findings or PR comments), `review` (asking for a review or
 * naming a PR), or null.
 * @param {string} prompt @returns {'findings' | 'review' | null}
 */
export function promptKind(prompt) {
  if (NOT_A_REQUEST.test(prompt)) return null
  if (FINDINGS.some(re => re.test(prompt))) return 'findings'
  return REVIEW.some(re => re.test(prompt)) ? 'review' : null
}

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
 * The repo test the start hook makes, at the input's cwd: the log entry's common part and whether it speaks.
 * @param {Record<string, unknown>} input @param {Record<string, string | undefined>} env @param {string} fallbackCwd
 * @param {Date} now @param {string} event @returns {HookEntry}
 */
function decide(input, env, fallbackCwd, now, event) {
  const root = findRepoRoot(str(input['cwd']) || fallbackCwd)
  const { found, silent } = roleHookDecision(readDeclarations(root), env)
  return { ts: now.toISOString(), repo: repoKey(root), source: '', event, session: str(input['session_id']), spoke: silent === null, found, silent }
}

/** @param {string} event @param {string} text @returns {string} */
const context = (event, text) => JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: text } })

// A SessionStart from these sources empties the context the earlier lines lived in.
const CONTEXT_RESET = new Set(['compact', 'clear'])

/**
 * Whether the prompt hook's lines are still in this session's context: it spoke there, and no SessionStart line
 * of the same session with a compact or clear source came after (the log is in append order).
 * @param {HookEntry[]} log @param {string} session @returns {boolean}
 */
export function saidInSession(log, session) {
  let said = false
  for (const e of log) {
    if (e.session !== session) continue
    const event = hookEvent(e)
    if (event === 'UserPromptSubmit' && e.spoke) said = true
    else if (event === 'SessionStart' && CONTEXT_RESET.has(e.source)) said = false
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
