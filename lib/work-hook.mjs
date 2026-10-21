// What craft's hook says at the moment of work and to the subagent the work is handed to (realm @nick/craft,
// node #288; the counter-example it answers, #287): lines at session start reach neither the moment the human
// asks for review work nor a subagent's brief. Same repo test and off switch as the start hook (#275, #264);
// a subagent has no Workflow tool (#262); the words follow the harness (lib/work-hook-text.mjs, #293). The harness surfaces it rests on are pinned in REALITY.md's rows.
import { findRepoRoot, readDeclarations, roleHookDecision } from './role-hook.mjs'
import { hookEvent, repoKey } from './hook-log.mjs'
import { promptKind } from './work-hook-kind.mjs'
import { continuation, notHuman, subagentReport } from './work-hook-word.mjs'
import { NUDGE, REMINDER, nudgedInSession, recentKind, repeatOf, saidInSession } from './work-hook-said.mjs'
import { harness } from './hook-harness.mjs'
import { nudgeText, reminderText, workText } from './work-hook-text.mjs'

// The Workflow tool's own agents (craft's engines among them) start as this subagent type: they are the loop.
const ENGINE_AGENT = 'workflow-subagent'
// craft's shipped agents (agents/, opencode/agents/) by the names a delivery without a plugin namespace gives them.
const CRAFT_AGENTS = ['nix-reviewer', 'rust-architecture-reviewer', 'rust-miri', 'rust-reviewer', 'rust-security-scanner']

/**
 * An agent whose brief craft itself writes (an engine's lens, a skill's dispatch): the work lines are noise in its
 * context, once per agent of a run. A plugin-namespaced craft agent, a shipped one by its bare name, or an engine's.
 * @param {string} agent @returns {boolean}
 */
export const craftAgent = agent => agent.startsWith('craft:') || CRAFT_AGENTS.includes(agent) || agent === ENGINE_AGENT

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
 * A human prompt's kind; the log is read only for a bare continuation, which takes the kind of the request it
 * continues (recentKind).
 * @param {string} prompt @param {HookEntry} entry @param {Date} now @param {() => HookEntry[]} logged
 */
const classify = (prompt, entry, now, logged) =>
  promptKind(prompt, continuation(prompt) ? recentKind(logged(), entry.repo, entry.session ?? '', now) : null)

/**
 * An agent's words the harness delivers as a prompt (#288), where the hook could speak: the first subagent report
 * in a session's context that heard the findings text (or the conditional one) gets one conditional line — the
 * re-review comes before the replies; anything else is a silence logged as `not-human`. A silent repo logs nothing.
 * @param {string} prompt @param {HookEntry} entry @param {() => HookEntry[]} logged @returns {HookRun}
 */
function onAgentWords(prompt, entry, logged) {
  if (!entry.spoke) return { stdout: '', entry: null }
  const session = entry.session ?? ''
  const log = subagentReport(prompt) && session ? logged() : []
  if (saidInSession(log, session, ['findings', 'other-language']) && !nudgedInSession(log, session)) {
    return { stdout: context('UserPromptSubmit', nudgeText(entry.harness)), entry: { ...entry, reason: NUDGE } }
  }
  return { stdout: '', entry: { ...entry, spoke: false, silent: 'not-human' } }
}

/**
 * A UserPromptSubmit run: the start hook's repo test; where it passes, a prompt of no class is a silence logged as
 * `no-kind` (a bare continuation takes the kind of the request it continues, so it reads these lines too), and an
 * agent's words are `not-human`. A prompt in another script is `other-language`, whose text is conditional. The
 * text of a class is said once per session until a compact or clear — the text stays in the session's context, and
 * repeating it on every message of a long review would bury the work under it. Claude Code's text is per class, so
 * there it is once per class; Codex's names both English classes. The conditional text covers no per-kind text nor
 * they it (coveredBy): a later prompt in another script hears one reminder line, logged with its reason and no kind.
 * @param {Record<string, unknown>} input @param {Record<string, string | undefined>} env @param {string} fallbackCwd
 * @param {Date} now @param {() => HookEntry[]} logged @returns {HookRun}
 */
function onPrompt(input, env, fallbackCwd, now, logged) {
  // Codex also fires UserPromptSubmit inside a subagent, with `agent_id` and the brief as `prompt`, under the
  // parent's session_id: SubagentStart already spoke to it, and logging it would count as the main session's.
  if (str(input['agent_id'])) return { stdout: '', entry: null }
  const event = 'UserPromptSubmit'
  const prompt = str(input['prompt'])
  const base = decide(input, env, fallbackCwd, now, event)
  if (notHuman(prompt)) return onAgentWords(prompt, base, logged)
  const kind = classify(prompt, base, now, logged)
  if (!kind) return { stdout: '', entry: base.spoke ? { ...base, spoke: false, silent: 'no-kind' } : null }
  const entry = { ...base, kind }
  const repeat = entry.spoke && entry.session ? repeatOf(logged(), entry.session, entry.harness, kind) : null
  if (repeat === REMINDER) return { stdout: context(event, reminderText(entry.harness)), entry: { ...base, reason: REMINDER } }
  if (repeat) Object.assign(entry, { spoke: false, silent: repeat })
  return { stdout: entry.spoke ? context(event, workText(entry.harness, kind).prompt) : '', entry }
}

/**
 * A SubagentStart run: it speaks to the subagent only in a repo where the start hook would, in a session where
 * the prompt hook spoke (the harness gives this event no brief to classify), and never to craft's own agents
 * (craftAgent), a silence not logged: a review run starts dozens of them, and their lines would rotate out the ones the
 * hook reads. The repo test runs before the log is read; a silent repo is not logged.
 * @param {Record<string, unknown>} input @param {Record<string, string | undefined>} env @param {string} fallbackCwd
 * @param {Date} now @param {() => HookEntry[]} logged @returns {HookRun}
 */
function onSubagent(input, env, fallbackCwd, now, logged) {
  const agent = str(input['agent_type'])
  const session = str(input['session_id'])
  if (craftAgent(agent) || !session) return { stdout: '', entry: null }
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
