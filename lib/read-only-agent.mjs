// The agent type an engine's read-only service agents run as (realm @nick/craft, node #442): Claude Code's
// built-in Explore subagent. Observed: it is handed no project instructions (CLAUDE.md, AGENTS.md), which every
// other agent type receives as an uncached block; it refuses a command that writes a file; as a Claude Code
// subagent it ran read-only node CLIs (craft-log-run prior-round, craft-units). So only an agent whose every
// command reads (git, grep, a read-only CLI, or no command at all) may take it — never a checkpoint, a record
// write, a build, a test or a cache fill. Not yet observed: a launch of it from the Workflow sandbox — hence
// makeReadOnlyFallback below.
export const READ_ONLY_AGENT_TYPE = 'Explore'

/** @typedef {{ agentType?: string | undefined, schema?: object | undefined, label?: string | undefined }} ReadOnlyOpts */

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
 * A dispatch that re-runs a READ_ONLY_AGENT_TYPE call once on the default agent type when the Explore agent
 * returned nothing (died, could not launch, was skipped) or an answer off its schema — the same prompt, model
 * and schema, only `agentType` dropped — like every other non-default type in the engines (lib/agent-fallback.mjs,
 * realm @nick/craft #113, #116). Each fallback is logged and counted for the run record's `agentFallbacks`.
 * `stopped`: the run dispatches no more work (a usage limit), so a null is not Explore's and is not re-run.
 * @template {ReadOnlyOpts} O
 * @template R
 * @param {(prompt: string, opts: O) => Promise<R>} dispatch
 * @param {(message: string) => void} logLine
 * @param {() => boolean} [stopped]
 */
export function makeReadOnlyFallback(dispatch, logLine, stopped = () => false) {
  let count = 0
  /** @param {string} prompt @param {O} opts @returns {Promise<R>} */
  async function run(prompt, opts) {
    const got = await dispatch(prompt, opts)
    if (opts.agentType !== READ_ONLY_AGENT_TYPE || fitsSchema(got, opts.schema) || stopped()) return got
    /** @type {O} */
    const rest = { ...opts }
    delete rest.agentType
    count++
    logLine(`⚠️ agent '${opts.label || '?'}' as ${READ_ONLY_AGENT_TYPE} ${got == null ? 'returned no result' : 'answered off its schema'} — re-running it once on the default agent type`)
    // The fallback never leaves the call worse off than Explore did: a throw from it (a spent budget) is the
    // next dispatch's to raise, and this call answers what Explore answered.
    try {
      return await dispatch(prompt, rest)
    } catch (e) {
      logLine(`⚠️ agent '${opts.label || '?'}' on the default agent type threw (${String(e).slice(0, 160)}) — keeping what ${READ_ONLY_AGENT_TYPE} answered`)
      return got
    }
  }
  /** @returns {{ agent: string, count: number }[]} the fallbacks so far, for agentUnavailableRecord */
  const fallbacks = () => (count ? [{ agent: READ_ONLY_AGENT_TYPE, count }] : [])
  return { run, fallbacks }
}
