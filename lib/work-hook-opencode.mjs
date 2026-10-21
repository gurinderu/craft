// craft's hook at the moment of work in OpenCode (opencode/plugin/work-hook.ts; realm @nick/craft, node #288): the
// same request classes, repo test, off switch and hook log as the Claude Code hook (lib/work-hook.mjs), over what
// OpenCode's plugin API gives — a `chat.message` per user message, a child session's parent from `session.created`,
// `session.compacted`. OpenCode has no Workflow tool and no craft:develop: the lines name what its delivery ships.
import { hookEvent } from './hook-log.mjs'
import { craftAgent, repoTest } from './work-hook.mjs'
import { REMINDER, repeatOf, saidInSession } from './work-hook-said.mjs'
import { OFF, REPORT, REVIEW_BRIEF, REVIEWER, SUBAGENT_MEMORY, FOR_FINDINGS, WHY_FINDINGS, delegateBoth, ifRequest, launcher, reReviewLine, recallLine, reminderLine, subagentWork } from './work-hook-text.mjs'
import { promptKind } from './work-hook-kind.mjs'

const EVENT = 'chat.message'
// The harness the plugin's log lines carry (lib/hook-log.mjs).
const HARNESS = 'opencode'
// The OpenCode installer links skills by directory name: the memory skill is `memory`, not `craft:memory`.
const MEMORY = 'the memory skill (record-decision, record-rule or record-question), and check the `memory backend:` line it prints'
const RECALL = 'load the memory skill with the skill tool and'
// No Workflow tool here: the re-review is the session's own pass over the fix commits, or for Rust the review this
// delivery ships, pointed at the same commits.
const RE_REVIEW = 'here in this session over git diff <that commit>..HEAD: for Rust code the rust-review skill or the rust-audit tool, otherwise your own review pass'
const FINDINGS_BRIEF = `"Before your first tool call, load the addressing-findings skill (skill tool) and work the findings with it; ${REPORT}."`
// The same shape as the Claude Code texts per request kind (lib/work-hook-text.mjs), in OpenCode's words: skills load
// with its skill tool by directory name, and its review is the rust-review skill with the review agents it
// dispatches, or the plugin's rust-audit tool (opencode/plugin/index.ts), which /rust-audit calls.
export const OPENCODE_FINDINGS_TEXT = [
  'craft: before your first tool call on this request, make one call: load the addressing-findings skill with the skill tool. Reading the PRs with gh first does not replace it.',
  recallLine(RECALL),
  reReviewLine(RE_REVIEW),
  WHY_FINDINGS,
  launcher('the memory skill', MEMORY),
  `craft: delegating is fine: load the skill here first, then paste this line verbatim into each subagent's brief: ${FINDINGS_BRIEF}`,
  OFF,
].join('\n')
export const OPENCODE_REVIEW_TEXT = [
  'craft: before your first tool call on this request, make one call: for Rust code, load the rust-review skill with the skill tool, or call the rust-audit tool (the /rust-audit command) for a whole crate. Reading the PRs with gh first does not replace it.',
  'craft: why: rust-review runs the cargo gate and a severity-tiered checklist to an Approve/Warning/Block verdict and dispatches craft\'s review agents with a crafted brief; the rust-audit tool fans those agents out over the crate into one severity-ranked report.',
  launcher('the memory skill', MEMORY),
  `craft: delegating a review to a reviewer agent is fine: paste this line verbatim into its brief: ${REVIEW_BRIEF} Fixing the findings stays here, with addressing-findings.`,
  OFF,
].join('\n')
export const OPENCODE_OTHER_LANGUAGE_TEXT = [
  ifRequest('load the addressing-findings skill with the skill tool', 'for Rust code load the rust-review skill with the skill tool, or call the rust-audit tool (the /rust-audit command) for a whole crate'),
  recallLine(RECALL, FOR_FINDINGS),
  reReviewLine(RE_REVIEW),
  launcher('the memory skill', MEMORY),
  delegateBoth(FINDINGS_BRIEF),
  OFF,
].join('\n')
export const OPENCODE_REMINDER_TEXT = reminderLine('load the addressing-findings skill', 'rust-review or the rust-audit tool', 'the rust-review skill for Rust code, otherwise your own review pass over them in this session')
const OPENCODE_TEXT = { findings: OPENCODE_FINDINGS_TEXT, review: OPENCODE_REVIEW_TEXT, 'other-language': OPENCODE_OTHER_LANGUAGE_TEXT }
export const OPENCODE_SUBAGENT_TEXT = [
  subagentWork('load addressing-findings with the skill tool'),
  SUBAGENT_MEMORY,
  `craft: if your brief is only to review: ${REVIEWER}.`,
  'craft: the re-review loop belongs to the main session: report back and leave it there.',
  OFF,
].join('\n')

/**
 * One user message: `prompt` its text, `session` its session, `cwd` the project directory; `parent` and `agent` only
 * on the first message of a subagent's session (its parent session and the agent it runs as).
 * @typedef {{ prompt: string, session: string, cwd: string, parent?: string, agent?: string }} OpencodeMessage
 * @typedef {import('./hook-log.mjs').HookEntry} HookEntry @typedef {{ text: string, entry: HookEntry | null }} OpencodeRun
 */

/**
 * A main session's message: silent and unlogged on a prompt of no class; otherwise the repo test and the text of
 * its class, once per class and session until a compaction; a later prompt in another script hears the reminder
 * line (lib/work-hook.mjs, onPrompt).
 * @param {OpencodeMessage} m @param {Record<string, string | undefined>} env @param {Date} now
 * @param {() => HookEntry[]} logged @returns {OpencodeRun}
 */
function onMessage(m, env, now, logged) {
  const kind = promptKind(m.prompt)
  if (!kind) return { text: '', entry: null }
  const base = repoTest(m.cwd, m.session, env, now, EVENT, HARNESS)
  const entry = { ...base, kind }
  const repeat = entry.spoke ? repeatOf(logged(), m.session, HARNESS, kind) : null
  if (repeat === REMINDER) return { text: OPENCODE_REMINDER_TEXT, entry: { ...base, reason: REMINDER } }
  if (repeat) Object.assign(entry, { spoke: false, silent: repeat })
  return { text: entry.spoke ? OPENCODE_TEXT[kind] : '', entry }
}

/**
 * A subagent's brief: it speaks in a repo where the start hook would, when the brief itself asks for review work or
 * its parent session heard the prompt lines, never to craft's own agents (a `craft-agent` silence); logged under the
 * parent session with the agent, as SubagentStart is.
 * @param {OpencodeMessage & { parent: string }} m @param {Record<string, string | undefined>} env @param {Date} now
 * @param {() => HookEntry[]} logged @returns {OpencodeRun}
 */
function onSubagent(m, env, now, logged) {
  const kind = promptKind(m.prompt)
  const entry = { ...repoTest(m.cwd, m.parent, env, now, EVENT, HARNESS), agent: m.agent ?? '', ...(kind ? { kind } : {}) }
  if (!entry.spoke) return { text: '', entry: null }
  if (craftAgent(entry.agent)) return { text: '', entry: { ...entry, spoke: false, silent: 'craft-agent' } }
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
  return { ...repoTest(cwd, session, {}, now, 'session.compacted', HARNESS), source: 'compact', spoke: false, found: [], silent: 'context-reset' }
}
