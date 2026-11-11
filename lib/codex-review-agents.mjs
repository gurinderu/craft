// What a task's agent and model tokens mean in Codex (realm @nick/craft, nodes #465, #491). Codex has no agent
// types a script can dispatch on, so a task naming one of craft's agents (`rust-reviewer`, `nix-reviewer`, the
// binary's `AgentKind`) runs with that agent's prompt body — the Claude Code delivery's agent file, which the Codex
// plugin root carries as a real file — before its own prompt; a consumer's own agent, an extra lens, with its
// `.claude/agents/<name>.md` in the reviewed repository. A token with no file runs on the bare prompt, said degraded.
// The model tokens are Claude tiers; Codex takes the session's own model unless a table maps a tier to one.
import fs from 'node:fs'
import path from 'node:path'

/** The tiers a task may name (cli/crates/craft-review/src/agent.rs, `Model`). */
const TIERS = ['opus', 'sonnet', 'haiku']

/** @typedef {Map<string, string>} ModelTable  a Codex model for each tier mapped; a tier not in it runs on the session's model */

/**
 * The model table from its text: one model name for every tier, or `tier=model` pairs joined by commas; '' none.
 * @param {string} text @returns {{ table: ModelTable } | { refused: string }}
 */
export function modelTable(text) {
  /** @type {ModelTable} */
  const table = new Map()
  const spec = text.trim()
  if (!spec) return { table }
  const name = /^[\w.:/-]{1,80}$/
  if (!spec.includes('=')) return name.test(spec) ? { table: new Map(TIERS.map(t => [t, spec])) } : { refused: `codexModels=${JSON.stringify(text)} is not a model name` }
  for (const pair of spec.split(',')) {
    const [tier = '', model = ''] = pair.split('=').map(s => s.trim())
    if (!TIERS.includes(tier) || !name.test(model)) return { refused: `codexModels=${JSON.stringify(text)}: "${pair}" is not <opus|sonnet|haiku>=<model>` }
    table.set(tier, model)
  }
  return { table }
}

/** The `-m` arguments for a tier: none when the table leaves it to the session. @param {ModelTable} table @param {string} tier @returns {string[]} */
export const modelArgs = (table, tier) => {
  const model = table.get(tier)
  return model ? ['-m', model] : []
}

/** A Markdown agent file's body, its frontmatter cut; '' when there is no such file. @param {string} file @returns {string} */
function bodyOf(file) {
  let text
  try { text = fs.readFileSync(file, 'utf8') } catch { return '' }
  return text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '').trim()
}

/** An agent's name as a file name, null when it could leave its directory. @param {string} name */
const safeName = name => (/^[\w][\w.-]{0,63}$/.test(name) ? name : null)

/**
 * The prompt body a task runs with before its own prompt, and the agent it stands for ('' none named): craft's agent
 * from the plugin's Claude Code agent files, a consumer's from the reviewed repository's `.claude/agents`.
 * @param {{ agentType?: string, consumerAgent?: string }} task @param {{ pluginRoot: string, repo: string }} where
 * @returns {{ agent: string, body: string }}
 */
export function rubricOf(task, { pluginRoot, repo }) {
  const consumer = task.consumerAgent !== undefined
  const agent = task.consumerAgent ?? task.agentType ?? ''
  const name = safeName(agent)
  if (!agent || !name) return { agent, body: '' }
  const dir = consumer ? path.join(repo, '.claude', 'agents') : path.join(pluginRoot, 'integrations', 'claude-code', 'agents')
  return { agent, body: bodyOf(path.join(dir, `${name}.md`)) }
}
