// What craft's hook says at the moment of work and to the subagent the work is handed to (realm @nick/craft,
// node #288; the counter-example it answers, #287): lines at session start reach neither the moment the human
// asks for review work nor a subagent's brief. Same repo test and off switch as the start hook (#275, #264);
// a subagent has no Workflow tool (#262); the words follow the harness (lib/work-hook-text.mjs, #293). The harness surfaces it rests on are pinned in REALITY.md's rows.
import { findRepoRoot, readDeclarations, roleHookDecision } from './role-hook.mjs'
import { hookEvent, repoKey } from './hook-log.mjs'
import { promptKind } from './work-hook-kind.mjs'
import { continuation, notHuman, recentKind, subagentReport } from './work-hook-word.mjs'
import { saidInSession } from './work-hook-said.mjs'
import { harness } from './hook-harness.mjs'
import { coveredBy, nudgeText, workText } from './work-hook-text.mjs'

// The Workflow tool's own agents (craft's engines among them) start as this subagent type: they are the loop.
const ENGINE_AGENT = 'workflow-subagent'

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
 * The repo test the start hook makes, at `cwd`: the log entry's common part and whether it speaks; `who` is the
 * harness, which the entry carries and which decides the project agents counted (readDeclarations).
 * @param {string} cwd @param {string} session @param {Record<string, string | undefined>} env @param {Date} now
 * @param {string} event @param {string} [who] @returns {HookEntry}
 */
export function repoTest(cwd, session, env, now, event, who = 'claude-code') {
  const root = findRepoRoot(cwd)
  const { found, silent } = roleHookDecision(readDeclarations(root, who), env)
  return { ts: now.toISOString(), repo: repoKey(root), source: '', event, harness: who, session, spoke: silent === null, found, silent }
}

/**
 * @param {Record<string, unknown>} input @param {Record<string, string | undefined>} env @param {string} fallbackCwd
 * @param {Date} now @param {string} event @returns {HookEntry}
 */
const decide = (input, env, fallbackCwd, now, event) =>
  repoTest(str(input['cwd']) || fallbackCwd, str(input['session_id']), env, now, event, harness(input, env))

/** @param {string} event @param {string} text @returns {string} */
const context = (event, text) => JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: text } })

/**
 * A human prompt's kind; the log is read only for a bare continuation, which takes the repo's recent kind.
 * @param {string} prompt @param {string} cwd @param {Date} now @param {() => HookEntry[]} logged
 */
const classify = (prompt, cwd, now, logged) =>
  promptKind(prompt, continuation(prompt) ? recentKind(logged(), repoKey(findRepoRoot(cwd)), now) : null)

/**
 * An agent's words the harness delivers as a prompt (#288), where the hook could speak: a subagent's report in a
 * session that heard the findings text gets one line — the re-review comes before the replies — unless a reviewer
 * sent it; anything else is a silence logged as `not-human`. A silent repo logs nothing.
 * @param {string} prompt @param {HookEntry} entry @param {() => HookEntry[]} logged @returns {HookRun}
 */
function onAgentWords(prompt, entry, logged) {
  if (!entry.spoke) return { stdout: '', entry: null }
  const session = entry.session ?? ''
  if (subagentReport(prompt) && session && saidInSession(logged(), session, ['findings', 'other-language'])) {
    return { stdout: context('UserPromptSubmit', nudgeText(entry.harness)), entry: { ...entry, reason: 're-review-nudge' } }
  }
  return { stdout: '', entry: { ...entry, spoke: false, silent: 'not-human' } }
}

/**
 * A UserPromptSubmit run: silent and unlogged on a prompt of no class (a bare continuation takes the kind of the
 * repo's latest classed request within 12 hours; a prompt in another script is `other-language`, whose text is
 * conditional), silent with `not-human` on an agent's words; otherwise the start hook's repo test,
 * and once per session until a compact or clear — the text stays in the session's context, and repeating it on
 * every message of a long review would bury the work under it. Claude Code's text is per class, so there it is
 * once per class (the conditional text covers both, coveredBy); Codex's names both classes, so once per session.
 * @param {Record<string, unknown>} input @param {Record<string, string | undefined>} env @param {string} fallbackCwd
 * @param {Date} now @param {() => HookEntry[]} logged @returns {HookRun}
 */
function onPrompt(input, env, fallbackCwd, now, logged) {
  // Codex also fires UserPromptSubmit inside a subagent, with `agent_id` and the brief as `prompt`, under the
  // parent's session_id: SubagentStart already spoke to it, and logging it would count as the main session's.
  if (str(input['agent_id'])) return { stdout: '', entry: null }
  const event = 'UserPromptSubmit'
  const prompt = str(input['prompt'])
  if (notHuman(prompt)) return onAgentWords(prompt, decide(input, env, fallbackCwd, now, event), logged)
  const kind = classify(prompt, str(input['cwd']) || fallbackCwd, now, logged)
  if (!kind) return { stdout: '', entry: null }
  const entry = { ...decide(input, env, fallbackCwd, now, event), kind }
  const session = entry.session
  if (entry.spoke && session && saidInSession(logged(), session, coveredBy(entry.harness, kind))) {
    Object.assign(entry, { spoke: false, silent: 'already-said' })
  }
  return { stdout: entry.spoke ? context(event, workText(entry.harness, kind).prompt) : '', entry }
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
  return { stdout: context('SubagentStart', workText(entry.harness).subagent), entry }
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
