// The repo test craft's hooks make (realm @nick/craft, node #275; the risk it is held against, #276): what a repo
// declares — its own roles and rules win on every step they cover (#264) — and the off switch. The OpenCode work hook
// makes it here (lib/work-hook-opencode.mjs); the Claude Code and Codex hooks make the same one in the craft binary
// (cli/bin/craft/src/hook/role/declared.rs, #538).
import fs from 'node:fs'
import path from 'node:path'

// The environment variable that switches the hook off for one person or machine.
export const SWITCH_ENV = 'CRAFT_ROLE_HOOK'
// The line that switches it off for the repo, in its AGENTS.md or CLAUDE.md.
const OFF_LINE = /^[ \t]*craft-role-hook:[ \t]*off[ \t]*$/im
const OFF_VALUES = new Set(['0', 'off', 'false', 'no'])
// A rules file counts as the repo's work rules only when it names the review-and-merge process in a phrase
// code prose does not use: bare "review", "commit", "branch" or "merge" also mean "deep merge" or
// "branch coverage", so an AGENTS.md or CLAUDE.md that only describes the code keeps the hook silent.
const WORK_RULES = [/\bpull requests?\b/i, /\bPRs?\b/, /\bcode reviews?\b/i, /\breviewers?\b/i, /\breview loops?\b/i, /\bbefore merg(e|ing)\b/i]
const RULES_FILES = ['AGENTS.md', 'CLAUDE.md']
// The agents a harness reads beside `.claude/agents`: Codex's role files were observed loaded (codex-cli 0.160.0).
/** @type {Record<string, { dir: string, ext: string, ownOnly: boolean }>} */
const OWN_AGENTS = { opencode: { dir: '.opencode/agents', ext: '.md', ownOnly: true }, codex: { dir: '.codex/agents', ext: '.toml', ownOnly: false } }

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
  try {
    return fs.readFileSync(file, 'utf8')
  } catch {
    return null
  }
}

/**
 * What the repo at `root` declares: its project agents (`.claude/agents/*.md`; under OpenCode also the project's own
 * `.opencode/agents/*.md` — not the symlinks craft's OpenCode installer puts there, #264; under Codex also the role
 * files `.codex/agents/*.toml` it loads in a trusted project) and its root rules files. A rules file reached twice
 * (CLAUDE.md a symlink to AGENTS.md) is read once.
 * @param {string} root @param {string} [who] the harness reading them (`claude-code`, `codex` or `opencode`)
 * @returns {Declarations}
 */
export function readDeclarations(root, who = 'claude-code') {
  const agents = projectAgents(root, '.claude/agents', '.md', false)
  const own = OWN_AGENTS[who]
  if (own) agents.push(...projectAgents(root, own.dir, own.ext, own.ownOnly))
  /** @type {RulesFile[]} */
  const rules = []
  const seen = new Set()
  for (const name of RULES_FILES) {
    const file = path.join(root, name)
    let real
    try {
      real = fs.realpathSync(file)
    } catch {
      continue
    }
    if (seen.has(real)) continue
    seen.add(real)
    const text = readText(file)
    if (text !== null) rules.push({ path: name, text })
  }
  return { agents, rules }
}

/**
 * The `*<ext>` agents in `dir` under `root`, as repo-relative paths; `ownOnly` leaves out symlinks.
 * @param {string} root @param {string} dir @param {string} ext @param {boolean} ownOnly @returns {string[]}
 */
function projectAgents(root, dir, ext, ownOnly) {
  try {
    return fs
      .readdirSync(path.join(root, dir), { withFileTypes: true })
      .filter(e => e.name.endsWith(ext) && !(ownOnly && e.isSymbolicLink()))
      .map(e => `${dir}/${e.name}`)
      .sort()
  } catch {
    return []
  }
}

/**
 * Whether the hook speaks and on what: `silent` names why not — `off-env` (the environment variable),
 * `off-line` (the repo's off line) or `nothing-declared` — and is null when it speaks on `found`.
 * @param {Declarations} declared @param {Record<string, string | undefined>} env
 * @returns {{ found: string[], silent: string | null }}
 */
export function roleHookDecision({ agents, rules }, env) {
  if (OFF_VALUES.has((env[SWITCH_ENV] ?? '').trim().toLowerCase())) return { found: [], silent: 'off-env' }
  if (rules.some(r => OFF_LINE.test(r.text))) return { found: [], silent: 'off-line' }
  const found = [...agents, ...rules.filter(r => WORK_RULES.some(rule => rule.test(r.text))).map(r => r.path)]
  return { found, silent: found.length ? null : 'nothing-declared' }
}
