// A task of the CLI's step protocol run in Claude Code (lib/cli-review-steps.mjs): what its agent is told, the
// agent type it runs on, and how long it is waited for (lib/cli-review-deadline.mjs).
import { makeTypeFallback } from './agent-type-fallback.mjs'
import { abandonedLine, deadlined, deadlineFired, taskCut } from './cli-review-deadline.mjs'
import { shq } from './plugin-script.mjs'

/** @typedef {import('./cli-review-step.mjs').Task} Task @typedef {import('./cli-review-steps.mjs').Sandbox} Sandbox */
/** @typedef {{ label?: string, phase?: string, model?: string | undefined, agentType?: string, schema?: object, cut?: import('./cli-review-deadline.mjs').Cut }} TaskOpts  a task dispatch's options, its deadline stripped before agent() */

// A task names its agent and model in host-neutral tokens (the binary's `AgentKind` and `Model`,
// cli/crates/craft-review/src/agent.rs); this driver maps each to Claude Code's name. The plugin registers its agents
// only under its prefix (lib/launch-names.mjs), so `rust-reviewer` is `craft:rust-reviewer` and `nix-reviewer` is
// `craft:nix-reviewer`, the agents the engine's Rust and Nix lenses run on (lib/review-profiles.mjs; realm @nick/craft,
// node #465); the model tokens are Claude Code's own names.
const TASK_AGENTS = new Map([
  ['rust-reviewer', { agentType: 'craft:rust-reviewer' }],
  ['nix-reviewer', { agentType: 'craft:nix-reviewer' }],
])
const TASK_MODELS = new Map([['opus', 'opus'], ['sonnet', 'sonnet'], ['haiku', 'haiku']])

// A consumer repository's own agent type, launched by the name its repository gives it: the one launch not under
// craft's prefix, marked for lib/launch-names.mjs (realm @nick/craft, node #295), as lib/review-extra-lens-run.mjs
// marks it. Not the bare `return name`, which esbuild's syntax minifier would inline and the mark with it.
/** @param {string} name */
function consumerAgentType(name) {
  return String(name)
}

/** Whether `token` is a model a task may name. @param {unknown} token @returns {boolean} */
export const isTaskModel = token => typeof token === 'string' && TASK_MODELS.has(token)

/**
 * What a task's agent is told: its prompt, schema and answer are files it reads and writes itself. The file is the
 * whole task, over anything an agent's own instructions add (a reviewer agent's gate, verdict and run record), and the
 * answer file is the only output: an agent without a Write tool writes it through Bash.
 * @param {Task} t @returns {string}
 */
const taskPrompt = t => `Read the file ${t.promptFile} and do exactly what it says: it is your whole task — run no gate, give no verdict and write no run record of your own beyond what it asks. When done, write your final answer as JSON matching the schema in ${t.schemaFile} to ${t.answerFile} (create the directory if needed) and nothing else — without a Write tool, through Bash with a quoted heredoc: \`cat > ${shq(t.answerFile)} <<'JSON'\` — then reply with the single word done.`

/** @typedef {{ agent: string, count: number, shipped: boolean, why?: string }} Fallen  tasks of one agent that ran on the default type, and what its first failure said */

/**
 * The task runner of one run: a task naming an agent this plugin ships runs on it (realm @nick/craft, node #465);
 * one naming no agent, or an agent the plugin does not ship (logged once), on the default type. A typed task that
 * throws or returns nothing is re-run once on the default type without memory, and the type retired only on the
 * recognised missing-type wording: tasks run in a parallel batch, so concurrent failures say nothing about the type —
 * the lens soft path (lib/agent-type-fallback.mjs, `retireOnRepeat: false`; realm @nick/craft #113, #152); the prompt
 * is self-contained, so the default type can run it. A null from an
 * untyped task leaves no answer file, which the binary asks for again.
 * `degraded(round)`: what ran on the default type in place of the agent its task named since the last call, as the
 * notes `craft review submit --degraded` takes, so the report says the run was weaker (realm #113, #116).
 * `stopped`: the run dispatches no more work (the usage limit), so a typed task's null is not re-run on the default type.
 * Every task races its kind's deadline, one budget shared by its re-run on the default type
 * (lib/cli-review-deadline.mjs): one past it is abandoned as dead and never re-run; `abandoned()` names those since
 * the last call, as the ids `craft review submit --abandoned` takes.
 * @param {Sandbox} sb @param {() => boolean} [stopped]
 * @returns {{ run: (t: Task) => Promise<unknown>, degraded: (round: number) => string[], abandoned: () => string[] }}
 */
export function taskRunner(sb, stopped = () => false) {
  /** @type {Map<string, number>} tasks of each agent this plugin does not ship, since the last `degraded` */
  const unknown = new Map()
  /** @type {Map<string, ReturnType<typeof typedFallback>>} */
  const typed = new Map()
  /** @type {Map<string, { count: number, failures: number }>} each typed agent's fallbacks and failures at the last `degraded` */
  const seen = new Map()
  /** @type {(prompt: string, opts: TaskOpts) => Promise<unknown>} */
  const dispatch = deadlined((p, o) => sb.agent(p, o), sb.log)
  /** @type {string[]} the tasks abandoned at their deadline since the last `abandoned` */
  let cutOff = []
  /** A deadline fire as the dead agent it counts as. @param {unknown} got */
  const settle = got => (deadlineFired(got) ? null : got)
  /** @param {{ agentType: string }} mapped  a TASK_AGENTS entry */
  const typedFallback = mapped => makeTypeFallback({ agentType: mapped.agentType, what: 'task', retireOnRepeat: false }, dispatch, sb.log, stopped, deadlineFired)
  /** @param {{ agentType: string }} mapped */
  const fallbackOf = mapped => {
    const got = typed.get(mapped.agentType) ?? typedFallback(mapped)
    typed.set(mapped.agentType, got)
    return got
  }
  /** @param {Task} t */
  async function run(t) {
    const cut = taskCut(t.kind)
    try {
      const got = await runOn(t, cut)
      if (!cut.fired) return got
      sb.log(abandonedLine(t.label, cut))
      cutOff.push(t.id)
      return null
    } finally {
      // The armed timer outlives the answer otherwise, holding the run open for the whole deadline.
      cut.dispose()
    }
  }
  /** @param {Task} t @param {import('./cli-review-deadline.mjs').Cut} cut */
  async function runOn(t, cut) {
    // The reviewed repository's own agent, an extra lens: on that agent, its own model, and no fallback, since a
    // generic agent is not the consumer's reviewer; a dead one leaves no answer, which the binary names.
    if (t.consumerAgent !== undefined) return runConsumer(t, t.consumerAgent, cut)
    const opts = { label: t.label, phase: 'Agents', model: TASK_MODELS.get(t.model), cut }
    if (t.agentType === undefined) return settle(await dispatch(taskPrompt(t), opts))
    const mapped = TASK_AGENTS.get(t.agentType)
    if (!mapped) {
      if (!unknown.has(t.agentType)) sb.log(`⚠️ task agent '${t.agentType}' is not one this plugin ships — its tasks run on the default agent type`)
      unknown.set(t.agentType, (unknown.get(t.agentType) ?? 0) + 1)
      return settle(await dispatch(taskPrompt(t), opts))
    }
    // On a throw or a null, once more on the default type; retired only on the missing-type wording (node #152).
    return fallbackOf(mapped).run(taskPrompt(t), { ...opts, agentType: mapped.agentType })
  }
  /** A consumer agent's task; a throw is logged and leaves no answer file. @param {Task} t @param {string} name @param {import('./cli-review-deadline.mjs').Cut} cut */
  async function runConsumer(t, name, cut) {
    try {
      return settle(await dispatch(taskPrompt(t), { label: t.label, phase: 'Agents', agentType: consumerAgentType(name), cut }))
    } catch (e) {
      sb.log(`⚠️ extra lens ${name} threw: ${String((e && /** @type {{ message?: unknown }} */ (e).message) || e).slice(0, 160)}`)
      return null
    }
  }
  /** @returns {Fallen[]} */
  function fallen() {
    /** @type {Fallen[]} */
    const out = []
    for (const [type, fb] of typed) {
      const total = fb.fallbacks().reduce((n, x) => n + x.count, 0)
      const failures = fb.failures()
      const last = seen.get(type) ?? { count: 0, failures: 0 }
      seen.set(type, { count: total, failures: failures.length })
      // The round's first failure; a round where the retired type failed nothing says what retired it.
      const why = failures[last.failures] ?? failures.at(-1)
      if (total > last.count) out.push({ agent: type, count: total - last.count, shipped: true, ...(why ? { why } : {}) })
    }
    for (const [type, count] of unknown) if (count > 0) out.push({ agent: type, count, shipped: false })
    for (const type of unknown.keys()) unknown.set(type, 0)
    return out
  }
  /** @param {number} round */
  const degraded = round => fallen().map(x => degradedNote(round, x))
  const abandoned = () => {
    const out = cutOff
    cutOff = []
    return out
  }
  return { run, degraded, abandoned }
}

/**
 * One note for the report: which agent, how many of the round's tasks ran without it, and that the run is weaker.
 * @param {number} round @param {Fallen} x @returns {string}
 */
const degradedNote = (round, x) => (x.shipped
  ? `round ${round}: ${x.count} task(s) on \`${x.agent}\` ran on the default agent type instead, without its rubric (${x.why ? `the first ${x.why}` : 'the agent is not registered in this session, or it failed'}) — this run is weaker than a normal one, not broken.`
  : `round ${round}: ${x.count} task(s) named \`${x.agent}\`, which this plugin does not ship, and ran on the default agent type — this run is weaker than a normal one, not broken.`)
