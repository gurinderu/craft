// What the OpenCode work hook (lib/work-hook-opencode.mjs; realm @nick/craft, node #288) shares with the hooks the
// craft binary runs for Claude Code and Codex (cli/bin/craft/src/hook/role/work.rs, #538): which agents are craft's
// own, and the repo test with its log line.
import { findRepoRoot, readDeclarations, roleHookDecision } from './role-hook.mjs'
import { repoKey } from './hook-log.mjs'

// The Workflow tool's own agents (craft's engines among them) start as this subagent type: they are the loop.
const ENGINE_AGENT = 'workflow-subagent'
// craft's shipped agents (agents/, integrations/opencode/agents/) by the names a delivery without a plugin namespace gives them.
const CRAFT_AGENTS = ['engine-service', 'nix-reviewer', 'review-task', 'rust-architecture-reviewer', 'rust-miri', 'rust-reviewer', 'rust-security-scanner']

/**
 * An agent whose brief craft itself writes (an engine's lens, a skill's dispatch): the work lines are noise in its
 * context, once per agent of a run. A plugin-namespaced craft agent, a shipped one by its bare name, or an engine's.
 * @param {string} agent @returns {boolean}
 */
export const craftAgent = agent => agent.startsWith('craft:') || CRAFT_AGENTS.includes(agent) || agent === ENGINE_AGENT

/**
 * The repo test the start hook makes, at `cwd`: the log entry's common part and whether it speaks; `who` is the
 * harness, which the entry carries and which decides the project agents counted (readDeclarations).
 * @param {string} cwd @param {string} session @param {Record<string, string | undefined>} env @param {Date} now
 * @param {string} event @param {string} [who] @returns {import('./hook-log.mjs').HookEntry}
 */
export function repoTest(cwd, session, env, now, event, who = 'claude-code') {
  const root = findRepoRoot(cwd)
  const { found, silent } = roleHookDecision(readDeclarations(root, who), env)
  return { ts: now.toISOString(), repo: repoKey(root), source: '', event, harness: who, session, spoke: silent === null, found, silent }
}
