// A task of the CLI's step protocol run in Claude Code (lib/cli-review-steps.mjs): what its agent is told, and the
// agent type it runs on.
import { makeTypeFallback } from './agent-type-fallback.mjs'
import { shq } from './plugin-script.mjs'

/** @typedef {import('./cli-review-steps.mjs').Task} Task @typedef {import('./cli-review-steps.mjs').Sandbox} Sandbox */

// A task names its agent and model in host-neutral tokens (the binary's `AgentKind` and `Model`,
// cli/crates/craft-review/src/agent.rs); this driver maps each to Claude Code's name. The plugin registers its agents
// only under its prefix (lib/launch-names.mjs), so `rust-reviewer` is `craft:rust-reviewer`, the agent the engine's
// Rust lenses run on (lib/review-profiles.mjs; realm @nick/craft, node #465); the model tokens are Claude Code's own names.
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

/** @typedef {{ agent: string, count: number, shipped: boolean }} Fallen  tasks of one agent that ran on the default type */

/**
 * The task runner of one run: a task naming an agent this plugin ships runs on it (realm @nick/craft, node #465);
 * one naming no agent, or an agent the plugin does not ship (logged once), on the default type. A typed task that
 * throws or returns nothing is re-run once on the default type, and the type retired when it cannot launch — the soft
 * path every non-default type takes (lib/agent-type-fallback.mjs), since what the sandbox says for an unregistered
 * type is not observed (node #152); the prompt is self-contained, so the default type can run it. A null from an
 * untyped task leaves no answer file, which the binary asks for again.
 * `degraded(round)`: what ran on the default type in place of the agent its task named since the last call, as the
 * notes `craft review submit --degraded` takes, so the report says the run was weaker (realm #113, #116).
 * @param {Sandbox} sb
 * @returns {{ run: (t: Task) => Promise<unknown>, degraded: (round: number) => string[] }}
 */
export function taskRunner(sb) {
  /** @type {Map<string, number>} tasks of each agent this plugin does not ship, since the last `degraded` */
  const unknown = new Map()
  /** @type {Map<string, ReturnType<typeof typedFallback>>} */
  const typed = new Map()
  /** @type {Map<string, number>} each typed agent's fallbacks at the last `degraded` */
  const seen = new Map()
  /** @param {{ agentType: string }} mapped  a TASK_AGENTS entry */
  const typedFallback = mapped => makeTypeFallback({ agentType: mapped.agentType, what: 'task' }, (/** @type {string} */ p, /** @type {Record<string, unknown>} */ o) => sb.agent(p, o), sb.log)
  /** @param {{ agentType: string }} mapped */
  const fallbackOf = mapped => {
    const got = typed.get(mapped.agentType) ?? typedFallback(mapped)
    typed.set(mapped.agentType, got)
    return got
  }
  /** @param {Task} t */
  async function run(t) {
    const opts = { label: t.label, phase: 'Agents', model: TASK_MODELS.get(t.model) }
    if (t.agentType === undefined) return sb.agent(taskPrompt(t), opts)
    const mapped = TASK_AGENTS.get(t.agentType)
    if (!mapped) {
      if (!unknown.has(t.agentType)) sb.log(`⚠️ task agent '${t.agentType}' is not one this plugin ships — its tasks run on the default agent type`)
      unknown.set(t.agentType, (unknown.get(t.agentType) ?? 0) + 1)
      return sb.agent(taskPrompt(t), opts)
    }
    // On a throw or a null, once more on the default type; retired when it cannot launch (node #152).
    return fallbackOf(mapped).run(taskPrompt(t), { ...opts, agentType: mapped.agentType })
  }
  /** @returns {Fallen[]} */
  function fallen() {
    /** @type {Fallen[]} */
    const out = []
    for (const [type, fb] of typed) {
      const total = fb.fallbacks().reduce((n, x) => n + x.count, 0)
      const count = total - (seen.get(type) ?? 0)
      seen.set(type, total)
      if (count > 0) out.push({ agent: type, count, shipped: true })
    }
    for (const [type, count] of unknown) if (count > 0) out.push({ agent: type, count, shipped: false })
    for (const type of unknown.keys()) unknown.set(type, 0)
    return out
  }
  /** @param {number} round */
  const degraded = round => fallen().map(x => degradedNote(round, x))
  return { run, degraded }
}

/**
 * One note for the report: which agent, how many of the round's tasks ran without it, and that the run is weaker.
 * @param {number} round @param {Fallen} x @returns {string}
 */
const degradedNote = (round, x) => (x.shipped
  ? `round ${round}: ${x.count} task(s) on \`${x.agent}\` ran on the default agent type instead, without its rubric (the agent is not registered in this session, or it failed) — this run is weaker than a normal one, not broken.`
  : `round ${round}: ${x.count} task(s) named \`${x.agent}\`, which this plugin does not ship, and ran on the default agent type — this run is weaker than a normal one, not broken.`)
