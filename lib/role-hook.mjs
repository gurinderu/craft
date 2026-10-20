// What craft's SessionStart hook says, and when (realm @nick/craft, node #275; the risk it is held
// against, #276). The repo's own roles and rules win on every step they cover (#264); the cycle the text
// points to is craft:develop (#266); a subagent has no Workflow tool (#262), a session started with
// --agent has it (#274).
import fs from 'node:fs'
import path from 'node:path'

// The environment variable that switches the hook off for one person or machine.
export const SWITCH_ENV = 'CRAFT_ROLE_HOOK'
// The line that switches it off for the repo, in its AGENTS.md or CLAUDE.md.
const OFF_LINE = /^[ \t]*craft-role-hook:[ \t]*off[ \t]*$/im
const OFF_VALUES = new Set(['0', 'off', 'false', 'no'])
// A rules file counts as the repo's work rules only when it speaks of how work reaches the trunk: an
// AGENTS.md or CLAUDE.md that only describes the code (a bare /init) keeps the hook silent.
const WORK_RULE = /\b(pull requests?|PRs?|code review|reviews?|reviewers?|commits?|branch(es)?|worktrees?|merges?)\b/i
const RULES_FILES = ['AGENTS.md', 'CLAUDE.md']
const NAMES_SHOWN = 4

/** @typedef {{ path: string, text: string }} RulesFile @typedef {{ agents: string[], rules: RulesFile[] }} Declarations */

/**
 * The repo root above `start`: the nearest directory holding `.git` (a directory, or the file a linked
 * worktree has); `start` itself when there is none.
 * @param {string} start @returns {string}
 */
export function findRepoRoot(start) {
  let dir = path.resolve(start)
  for (;;) {
    if (fs.existsSync(path.join(dir, '.git'))) return dir
    const up = path.dirname(dir)
    if (up === dir) return path.resolve(start)
    dir = up
  }
}

/** @param {string} file @returns {string | null} */
function readText(file) {
  try { return fs.readFileSync(file, 'utf8') } catch { return null }
}

/**
 * What the repo at `root` declares: its project agents (`.claude/agents/*.md`) and its root rules files.
 * A rules file reached twice (CLAUDE.md a symlink to AGENTS.md) is read once.
 * @param {string} root @returns {Declarations}
 */
export function readDeclarations(root) {
  /** @type {string[]} */
  let agents = []
  try {
    agents = fs.readdirSync(path.join(root, '.claude', 'agents')).filter(f => f.endsWith('.md')).sort().map(f => `.claude/agents/${f}`)
  } catch { /* no project agents */ }
  /** @type {RulesFile[]} */
  const rules = []
  const seen = new Set()
  for (const name of RULES_FILES) {
    const file = path.join(root, name)
    let real
    try { real = fs.realpathSync(file) } catch { continue }
    if (seen.has(real)) continue
    seen.add(real)
    const text = readText(file)
    if (text !== null) rules.push({ path: name, text })
  }
  return { agents, rules }
}

/** @param {string[]} names @returns {string} */
function nameList(names) {
  const shown = names.slice(0, NAMES_SHOWN).join(', ')
  return names.length > NAMES_SHOWN ? `${shown} and ${names.length - NAMES_SHOWN} more` : shown
}

/**
 * The context the hook adds, '' for silence: silent when switched off (the environment variable or the
 * repo's off line) or when the repo declares neither an agent nor work rules.
 * @param {Declarations} declared @param {Record<string, string | undefined>} env @returns {string}
 */
export function roleHookText({ agents, rules }, env) {
  if (OFF_VALUES.has((env[SWITCH_ENV] ?? '').trim().toLowerCase())) return ''
  if (rules.some(r => OFF_LINE.test(r.text))) return ''
  const found = [...agents, ...rules.filter(r => WORK_RULE.test(r.text)).map(r => r.path)]
  if (found.length === 0) return ''
  return [
    `craft: this repo declares its own roles or work rules (${nameList(found)}); they win on every step they cover.`,
    'craft: the repo\'s developer role runs its cycle with craft\'s tools: recall project memory (craft:memory) before the work; before a PR, the review loop to convergence and one full review (craft:develop).',
    'craft: only the main session (also one started with --agent) can run craft\'s workflow engines; a role running as a subagent hands the review loop back to the main session.',
    `craft: to silence this, set ${SWITCH_ENV}=0 or add a line \`craft-role-hook: off\` to AGENTS.md or CLAUDE.md.`,
  ].join('\n')
}

/**
 * The hook's stdout for one SessionStart input (the harness's JSON on stdin): '' for silence, else the
 * JSON that adds the text as context. A missing or unreadable input falls back to `fallbackCwd`.
 * @param {string} input @param {Record<string, string | undefined>} env @param {string} fallbackCwd @returns {string}
 */
export function sessionStartOutput(input, env, fallbackCwd) {
  let cwd = fallbackCwd
  try {
    const parsed = /** @type {{ cwd?: unknown }} */ (JSON.parse(input))
    if (typeof parsed?.cwd === 'string' && parsed.cwd !== '') cwd = parsed.cwd
  } catch { /* not JSON: the process cwd */ }
  const text = roleHookText(readDeclarations(findRepoRoot(cwd)), env)
  if (!text) return ''
  return JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: text } })
}
