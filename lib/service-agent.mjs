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
 * A dispatch that re-runs a SERVICE_AGENT_TYPE call once on the default agent type when the service agent
 * returned nothing (died, could not launch, was skipped) or an answer off its schema — the same prompt, model
 * and schema, only `agentType` dropped — like every other non-default type in the engines (lib/agent-fallback.mjs,
 * realm @nick/craft #113, #116). Each fallback is logged and counted for the run record's `agentFallbacks`.
 * `stopped`: the run dispatches no more work (a usage limit), so a null is not the service agent's and is not re-run.
 * @template {ServiceOpts} O
 * @template R
 * @param {(prompt: string, opts: O) => Promise<R>} dispatch
 * @param {(message: string) => void} logLine
 * @param {() => boolean} [stopped]
 */
export function makeDefaultTypeFallback(dispatch, logLine, stopped = () => false) {
  let count = 0
  /** @param {string} prompt @param {O} opts @returns {Promise<R>} */
  async function run(prompt, opts) {
    const got = await dispatch(prompt, opts)
    if (opts.agentType !== SERVICE_AGENT_TYPE || fitsSchema(got, opts.schema) || stopped()) return got
    /** @type {O} */
    const rest = { ...opts }
    delete rest.agentType
    count++
    logLine(`⚠️ agent '${opts.label || '?'}' as ${SERVICE_AGENT_TYPE} ${got == null ? 'returned no result' : 'answered off its schema'} — re-running it once on the default agent type`)
    // The fallback never leaves the call worse off than the service agent did: a throw from it (a spent budget)
    // is the next dispatch's to raise, and this call answers what the service agent answered.
    try {
      return await dispatch(prompt, rest)
    } catch (e) {
      logLine(`⚠️ agent '${opts.label || '?'}' on the default agent type threw (${String(e).slice(0, 160)}) — keeping what ${SERVICE_AGENT_TYPE} answered`)
      return got
    }
  }
  /** @returns {{ agent: string, count: number }[]} the fallbacks so far, for agentUnavailableRecord */
  const fallbacks = () => (count ? [{ agent: SERVICE_AGENT_TYPE, count }] : [])
  return { run, fallbacks }
}
