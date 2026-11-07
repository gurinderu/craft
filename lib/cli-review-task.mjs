// A task of the CLI's step protocol run in Claude Code (lib/cli-review-steps.mjs): what its agent is told, and the
// agent type it runs on.
import { isAgentTypeMissing } from './agent-fallback.mjs'
import { shq } from './plugin-script.mjs'

/** @typedef {import('./cli-review-steps.mjs').Task} Task @typedef {import('./cli-review-steps.mjs').Sandbox} Sandbox */

// A task names its agent and model in host-neutral tokens (the binary's `AgentKind` and `Model`,
// cli/crates/craft-review/src/agent.rs); this driver maps each to Claude Code's name. The plugin registers its agents
// only under its prefix (lib/launch-names.mjs), so `rust-reviewer` is `craft:rust-reviewer`, the agent the engine's
// Rust lenses run on (lib/review-profiles.mjs); the model tokens are Claude Code's own names.
const TASK_AGENTS = new Map([['rust-reviewer', { agentType: 'craft:rust-reviewer' }]])
const TASK_MODELS = new Map([['opus', 'opus'], ['sonnet', 'sonnet'], ['haiku', 'haiku']])

/** Whether `token` is a model a task may name. @param {unknown} token @returns {boolean} */
export const isTaskModel = token => typeof token === 'string' && TASK_MODELS.has(token)

/**
 * What a task's agent is told: its prompt, schema and answer are files it reads and writes itself. The file is the
 * whole task, over anything an agent's own instructions add (a reviewer agent's gate, verdict and run record), and the
 * answer file is the only output: an agent without a Write tool writes it through Bash.
 * @param {Task} t @returns {string}
 */
const taskPrompt = t => `Read the file ${t.promptFile} and do exactly what it says: it is your whole task — run no gate, give no verdict and write no run record of your own beyond what it asks. When done, write your final answer as JSON matching the schema in ${t.schemaFile} to ${t.answerFile} (create the directory if needed) and nothing else — without a Write tool, through Bash with a quoted heredoc: \`cat > ${shq(t.answerFile)} <<'JSON'\` — then reply with the single word done.`

/**
 * The task runner of one run: a task naming an agent this plugin ships runs on it; one naming no agent, or an agent
 * the plugin does not ship (logged once), on the default type. An agent the session has not registered is learned
 * from its first throw, logged, and its tasks go to the default type from then on — the prompt is self-contained,
 * as the engine's lens fallback holds (lib/review-lens-dispatch.mjs). A null leaves no answer file, which the binary
 * asks for again on the same agent.
 * @param {Sandbox} sb @returns {(t: Task) => Promise<unknown>}
 */
export function taskRunner(sb) {
  /** @type {Set<string>} */
  const unknown = new Set()
  /** @type {Set<string>} */
  const missing = new Set()
  return async t => {
    const opts = { label: t.label, phase: 'Agents', model: TASK_MODELS.get(t.model) }
    const typed = t.agentType === undefined ? undefined : TASK_AGENTS.get(t.agentType)
    if (t.agentType !== undefined && !typed && !unknown.has(t.agentType)) {
      unknown.add(t.agentType)
      sb.log(`⚠️ task agent '${t.agentType}' is not one this plugin ships — its tasks run on the default agent type`)
    }
    if (!typed || missing.has(typed.agentType)) return sb.agent(taskPrompt(t), opts)
    try {
      return await sb.agent(taskPrompt(t), { ...opts, agentType: typed.agentType })
    } catch (e) {
      if (!isAgentTypeMissing(e, typed.agentType)) throw e
      if (!missing.has(typed.agentType)) {
        missing.add(typed.agentType)
        sb.log(`⚠️ agent type '${typed.agentType}' is not registered here (${String(e).slice(0, 160)}) — its tasks run on the default agent type`)
      }
      return sb.agent(taskPrompt(t), opts)
    }
  }
}
