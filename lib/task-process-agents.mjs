// What a task's agent and model tokens mean to a host with no agent types a script can dispatch on (realm @nick/craft,
// nodes #453, #465): a task naming one of craft's agents (`rust-reviewer`, `nix-reviewer`, the binary's `AgentKind`)
// runs with that agent's prompt body — the Claude Code delivery's agent file, which a checkout carries as a real file
// — before its own prompt; a consumer's own agent, an extra lens, with its `.claude/agents/<name>.md` in the reviewed
// repository. A token with no file runs on the bare prompt, said degraded. The model tokens are Claude tiers; the
// host takes its own configured model unless a table maps a tier to one of its models.
import fs from 'node:fs'
import path from 'node:path'

/** The tiers a task may name (cli/crates/craft-review/src/agent.rs, `Model`). */
const TIERS = ['opus', 'sonnet', 'haiku']

/** @typedef {Map<string, string>} ModelTable  a host model for each tier mapped; a tier not in it runs on the host's own */

/**
 * The model table from its text: one model name for every tier, or `tier=model` pairs joined by commas; '' none.
 * @param {string} text @param {string} key  the argument as a refusal names it @param {RegExp} name  a model name the host takes
 * @returns {{ table: ModelTable } | { refused: string }}
 */
export function modelTable(text, key, name) {
  /** @type {ModelTable} */
  const table = new Map()
  const spec = text.trim()
  if (!spec) return { table }
  if (!spec.includes('=')) return name.test(spec) ? { table: new Map(TIERS.map(t => [t, spec])) } : { refused: `${key}=${JSON.stringify(text)} is not a model name` }
  for (const pair of spec.split(',')) {
    const [tier = '', model = ''] = pair.split('=').map(s => s.trim())
    if (!TIERS.includes(tier) || !name.test(model)) return { refused: `${key}=${JSON.stringify(text)}: "${pair}" is not <opus|sonnet|haiku>=<model>` }
    table.set(tier, model)
  }
  return { table }
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

/**
 * The binary's prompts name craft's files under `${CLAUDE_PLUGIN_ROOT}`, which a host's shell or file tool may not
 * expand: the plugin root is written in. @param {string} text @param {string} root @returns {string}
 */
export const spellRoot = (text, root) => text.replaceAll('${CLAUDE_PLUGIN_ROOT}', root)

/**
 * The line that ends every task's message: a host loads none of craft's skills, so a skill an agent's body or the
 * task's prompt names (the review rubrics) is read from the plugin's own file. @param {string} root @returns {string}
 */
export const skillLine = root => `A skill named in the prompt or the guidance (such as \`rust-review\`) is the file ${path.join(root, 'skills', '<name>', 'SKILL.md')}: read it from there.`

/**
 * Why no task can answer until the human logs in to the host: its own words, then what to do.
 * @param {string} host @param {string} said  the host's line @param {string} how  how to log in @returns {string}
 */
export const notLoggedIn = (host, said, how) => `${host} is not logged in (${said.trim()}): log in to ${host} — ${how} — then resume the run`
