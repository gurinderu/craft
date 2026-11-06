// The agent type an engine's service steps run as (realm @nick/craft, node #397): craft's own minimal
// `engine-service` agent (agents/engine-service.md: tools Bash, Read and Write, `omitClaudeMd: true`, no model —
// each call passes its own). Observed (Claude Code 2.1.319, the plugin loaded by --plugin-dir): a plugin agent with
// `omitClaudeMd` starts without the project's CLAUDE.md and AGENTS.md, its first request about 3k tokens of
// context against 50–64k for an engine agent on the default type; the field needs Claude Code 2.1.271 or later.
// It has no write limit, so a step whose prompt is self-sufficient and names its own commands takes it, writers
// (a checkpoint, the run record) included; one that needs another tool, the consumer's project instructions or
// judgement keeps its type. Not observed: a launch of a plugin agent with this field from the Workflow sandbox —
// hence makeDefaultTypeFallback below.
export const SERVICE_AGENT_TYPE = 'craft:engine-service'

/** @typedef {{ agentType?: string | undefined, schema?: object | undefined, label?: string | undefined }} ServiceOpts */

/**
 * Whether an answer fits the top level of the schema it was asked for: not null, and for an object schema an
 * object carrying every `required` key. A site's own deeper checks still run on what comes back.
 * @param {unknown} got @param {object | undefined} schema @returns {boolean}
 */
export function fitsSchema(got, schema) {
  if (got == null) return false
  const s = /** @type {{ type?: unknown, required?: unknown }} */ (schema || {})
  if (s.type !== 'object') return true
  if (typeof got !== 'object' || Array.isArray(got)) return false
  const required = Array.isArray(s.required) ? s.required : []
  return required.every(k => Object.prototype.hasOwnProperty.call(got, String(k)))
}

/**
 * A dispatch that re-runs a SERVICE_AGENT_TYPE call once on the default agent type — the same prompt, model and
 * schema, only `agentType` dropped — like every other non-default type in the engines (lib/agent-fallback.mjs,
 * realm @nick/craft #113, #116): when the service agent threw (could not launch: the sandbox's "Agent type …
 * not found"), returned nothing, or answered off its schema. A throw is remembered for the rest of the run: every
 * later service step goes straight to the default type (`route` does the same for a dispatch made outside `run`),
 * logged once. Each step the default type answered in its place is counted for the run record's `agentFallbacks`.
 * `stopped`: the run dispatches no more work (a usage limit), so a null or a throw is not the service agent's and
 * is not re-run. `isDeadline`: the dispatch's own marker for a deadline fire, which is never re-dispatched — a rerun
 * would double the step's worst-case wait; it comes back as null.
 * @template {ServiceOpts} O
 * @template R
 * @param {(prompt: string, opts: O) => Promise<R>} dispatch
 * @param {(message: string) => void} logLine
 * @param {() => boolean} [stopped]
 * @param {(got: unknown) => boolean} [isDeadline]
 */
export function makeDefaultTypeFallback(dispatch, logLine, stopped = () => false, isDeadline = () => false) {
  let count = 0
  let launchFailed = false
  /** @param {R} got @returns {R | null} */
  const settle = got => (isDeadline(got) ? null : got)
  /** @param {O} opts @returns {O} */
  const withoutType = opts => {
    const rest = { ...opts }
    delete rest.agentType
    return rest
  }
  /** The options a dispatch outside `run` goes with: the service type dropped once it failed to launch. @param {O} opts @returns {O} */
  const route = opts => (launchFailed && opts.agentType === SERVICE_AGENT_TYPE ? withoutType(opts) : opts)
  /** @param {string} prompt @param {O} opts @returns {Promise<R | null>} */
  async function run(prompt, opts) {
    if (opts.agentType !== SERVICE_AGENT_TYPE) return settle(await dispatch(prompt, opts))
    if (launchFailed) return onDefault(prompt, opts)
    /** @type {{ got: R } | { threw: unknown }} */
    const first = await dispatch(prompt, opts).then(answer => ({ got: answer }), threw => ({ threw }))
    if ('threw' in first) return afterThrow(prompt, opts, first.threw)
    const got = first.got
    if (isDeadline(got)) return null
    if (fitsSchema(got, opts.schema) || stopped()) return got
    return rerun(prompt, opts, got)
  }
  /** The step on the default type in the service agent's place, counted. @param {string} prompt @param {O} opts @returns {Promise<R | null>} */
  async function onDefault(prompt, opts) {
    count++
    return settle(await dispatch(prompt, withoutType(opts)))
  }
  /** The service agent could not launch: remembered, said once, and this step on the default type. @param {string} prompt @param {O} opts @param {unknown} e @returns {Promise<R | null>} */
  async function afterThrow(prompt, opts, e) {
    if (stopped()) throw e
    launchFailed = true
    logLine(`⚠️ agent '${opts.label || '?'}' as ${SERVICE_AGENT_TYPE} threw (${String(e).replace(/\s+/g, ' ').slice(0, 160)}) — it and every later service step of this run go to the default agent type`)
    return onDefault(prompt, opts)
  }
  /** The service agent answered nothing or off its schema: one rerun on the default type. @param {string} prompt @param {O} opts @param {R} got @returns {Promise<R | null>} */
  async function rerun(prompt, opts, got) {
    logLine(`⚠️ agent '${opts.label || '?'}' as ${SERVICE_AGENT_TYPE} ${got == null ? 'returned no result' : 'answered off its schema'} — re-running it once on the default agent type`)
    // The fallback never leaves the call worse off than the service agent did: a throw from it (a spent budget)
    // is the next dispatch's to raise, and this call answers what the service agent answered.
    try {
      return await onDefault(prompt, opts)
    } catch (e) {
      logLine(`⚠️ agent '${opts.label || '?'}' on the default agent type threw (${String(e).slice(0, 160)}) — keeping what ${SERVICE_AGENT_TYPE} answered`)
      return got
    }
  }
  /** @returns {{ agent: string, count: number }[]} the fallbacks so far, for agentUnavailableRecord */
  const fallbacks = () => (count ? [{ agent: SERVICE_AGENT_TYPE, count }] : [])
  return { run, route, fallbacks }
}
