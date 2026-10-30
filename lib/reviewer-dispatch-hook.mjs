// What craft's PreToolUse hook on the Agent tool says when the main session dispatches the repo's own reviewer
// (realm @nick/craft, node #417; one engine for any language: #420; on #414, #264, #288, #289, #262): the repo's reviewer stands, and the same range
// also goes through craft's review engine here, in the main session — a subagent has no Workflow tool (#262). The
// dispatch is never blocked: the context reaches the model after the tool result (#289), which for a background
// reviewer is at once. Same repo test and off switch as the start hook (lib/role-hook.mjs); traced like the other
// hooks (lib/hook-log.mjs, #283).
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { findRepoRoot, readDeclarations } from './role-hook.mjs'
import { craftAgent, repoTest } from './work-hook.mjs'
import { harness } from './hook-harness.mjs'

const EVENT = 'PreToolUse'
// Every line this hook writes carries it, so the run report counts it apart from the push hook's PreToolUse lines.
export const REVIEWER_REASON = 'reviewer-dispatch'
const LOGGER = path.join(path.dirname(fileURLToPath(import.meta.url)), 'craft-log-run.mjs')

/** @param {unknown} v @returns {string} */
const str = v => (typeof v === 'string' ? v : '')

/**
 * The `name` and `description` of an agent file's YAML frontmatter, read line by line: a folded or literal
 * description (`>` or `|`) takes its indented lines; a field it lacks is ''.
 * @param {string} text @returns {{ name: string, description: string }}
 */
export function agentFrontmatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)
  const lines = m?.[1]?.split(/\r?\n/) ?? []
  /** @param {string} key */
  const field = key => {
    const at = lines.findIndex(l => l.startsWith(`${key}:`))
    if (at < 0) return ''
    let value = (lines[at] ?? '').slice(key.length + 1).trim()
    if (/^[>|][+-]?$/.test(value) || value === '') {
      const rest = []
      for (const l of lines.slice(at + 1)) { if (!/^\s/.test(l)) break; rest.push(l.trim()) }
      value = rest.join(' ')
    }
    return value.replace(/^(['"])(.*)\1$/, '$2')
  }
  return { name: field('name'), description: field('description') }
}

/**
 * Whether an agent is a reviewer: its name says review, or the first clause of its description does — up to the
 * first `.`, `;` or dash, so a "Not for … review" clause later on does not make a designer one.
 * @param {{ name: string, description: string }} agent @returns {boolean}
 */
export function isReviewer({ name, description }) {
  const lead = description.split(/[.;]\s|\s[—–-]\s/)[0] ?? ''
  return /review/i.test(name) || /\breview/i.test(lead)
}

/**
 * The repo's own agent dispatched as `type` (by its frontmatter name, else its file name), or null.
 * @param {string} root @param {string} type @returns {{ file: string, reviewer: boolean } | null}
 */
export function projectAgent(root, type) {
  for (const file of readDeclarations(root).agents) {
    let text = ''
    try { text = fs.readFileSync(path.join(root, file), 'utf8') } catch { continue }
    const meta = agentFrontmatter(text)
    if ((meta.name || path.basename(file, '.md')) === type) return { file, reviewer: isReviewer(meta) }
  }
  return null
}

/**
 * The context the hook adds for a dispatch of the repo's reviewer `type` (from `file`).
 * @param {string} type @param {string} file @param {boolean} background @returns {string}
 */
export function reviewerDispatchText(type, file, background) {
  const when = background
    ? 'it runs in the background, so launch the engine now, in parallel, not after it returns'
    : 'launch the engine now, on the range the reviewer was given'
  return [
    `craft: ${type} is this repo's own reviewer (${file}); it and the repo's rules stand. The same diff range also goes through craft's review engine here in the main session (Workflow tool; never a subagent, which has none): the craft:review workflow { base: <the same base>, fresh: true, fullEvery: 0 } on any language (it routes source files outside its profiles to a nested adversarial review) — ${when}.`,
    `craft: when both are back, fold the engine's findings into ${type}'s verdict under the repo's own rules: a Medium-or-higher finding from either side stays open until it is closed. Once the engine run has ended: node "${LOGGER}" enrich-cost --run-id <wf_…> (best-effort).`,
    'craft: to silence this, set CRAFT_ROLE_HOOK=0 or add a line `craft-role-hook: off` to AGENTS.md or CLAUDE.md.',
  ].join('\n')
}

/** @typedef {import('./work-hook.mjs').HookRun} HookRun */

/** @param {string} input @returns {Record<string, unknown>} */
function parse(input) {
  try {
    const v = /** @type {unknown} */ (JSON.parse(input))
    return v !== null && typeof v === 'object' ? /** @type {Record<string, unknown>} */ (v) : {}
  } catch { return {} }
}

/**
 * The Agent call's subagent type, where it runs and the repo's agent of that type; null for another tool, craft's
 * own agents (craftAgent) and a type that is no agent of the repo's.
 * @param {Record<string, unknown>} fields @param {string} fallbackCwd
 * @returns {{ type: string, cwd: string, agent: { file: string, reviewer: boolean }, toolInput: Record<string, unknown> } | null}
 */
function dispatchOf(fields, fallbackCwd) {
  const raw = fields['tool_input']
  if (str(fields['tool_name']) !== 'Agent' || raw === null || typeof raw !== 'object') return null
  const toolInput = /** @type {Record<string, unknown>} */ (raw)
  const type = str(toolInput['subagent_type'])
  if (!type || craftAgent(type)) return null
  const cwd = str(fields['cwd']) || fallbackCwd
  const agent = projectAgent(findRepoRoot(cwd), type)
  return agent ? { type, cwd, agent, toolInput } : null
}

/**
 * One PreToolUse run on the Agent tool. Not logged: another tool, craft's own agents (craftAgent) and a type that
 * is no agent of the repo's. Logged, each with `reason: reviewer-dispatch`: the repo test's silence (the off
 * switch), `not-review` (a project agent that is no reviewer), `in-subagent` (the call comes from a subagent, which
 * has no Workflow tool), `codex` (no Workflow tool there either), or the line it spoke.
 * @param {string} input @param {Record<string, string | undefined>} env @param {string} fallbackCwd @param {Date} now
 * @returns {HookRun}
 */
export function reviewerDispatchHook(input, env, fallbackCwd, now) {
  const fields = parse(input)
  const target = dispatchOf(fields, fallbackCwd)
  if (!target) return { stdout: '', entry: null }
  const { type, cwd, agent, toolInput } = target
  const who = harness(fields, env)
  const base = { ...repoTest(cwd, str(fields['session_id']), env, now, EVENT, who), agent: type, reason: REVIEWER_REASON }
  /** @param {string} why @returns {HookRun} */
  const quiet = why => ({ stdout: '', entry: { ...base, spoke: false, silent: why } })
  if (!base.spoke) return { stdout: '', entry: base }
  if (!agent.reviewer) return quiet('not-review')
  if (str(fields['agent_id'])) return quiet('in-subagent')
  if (who === 'codex') return quiet('codex')
  const text = reviewerDispatchText(type, agent.file, toolInput['run_in_background'] === true)
  return { stdout: JSON.stringify({ hookSpecificOutput: { hookEventName: EVENT, additionalContext: text } }), entry: base }
}
