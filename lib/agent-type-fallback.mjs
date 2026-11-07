import { isAgentTypeMissing } from './agent-fallback.mjs'

// The soft path a dispatch on a non-default agent type takes when that type fails: the call re-run once on the
// default type, and the type retired for the rest of the run when it cannot launch. One implementation for every
// such dispatch: the engines' service steps (lib/service-agent.mjs, realm @nick/craft, node #397) and the CLI
// driver's typed tasks (lib/cli-review-task.mjs, node #465).

/** @typedef {{ agentType?: string | undefined, schema?: object | undefined, label?: string | undefined }} TypedOpts */

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
 * A dispatch that re-runs a call on `agentType` once on the default agent type — the same prompt, model and
 * schema, only `agentType` dropped — like every other non-default type in the engines (lib/agent-fallback.mjs,
 * realm @nick/craft #113, #116): when the typed agent threw, returned nothing, or answered off its schema.
 * A throw alone is not a failed launch: agent({schema}) also throws when a launched agent ends without its
 * structured answer (lib/run-logging.mjs, realm @nick/craft #247), so it reruns that one call only. The type is
 * retired for the rest of the run — every later call on it straight to the default type (`route` does the same
 * for a dispatch made outside `run`), logged once — when a throw reads as an unregistered type
 * (isAgentTypeMissing), or, as a backstop since the sandbox's wording for that is unobserved (#152), on a second
 * failure on the type in a row — a throw, a null or an off-schema answer, since an unregistered agent comes back
 * empty on some runtimes (lib/agent-fallback.mjs) — with no fitting answer on the type between them. A deadline
 * fire neither counts nor resets. A call on any other type passes through untouched.
 * Each call the default type answered in its place is counted by reason: `<type> (launch failed)` — the type
 * could not launch, this call and every later one — or `<type> (step rerun)` — it launched and this one call
 * failed; each its own key in a run record's `agentFallbacks`.
 * `stopped`: the run dispatches no more work (a usage limit), so a null or a throw is not the typed agent's and
 * is not re-run. `isDeadline`: the dispatch's own marker for a deadline fire, which is never re-dispatched — a rerun
 * would double the call's worst-case wait; it comes back as null.
 * @template {TypedOpts} O
 * @template R
 * @param {{ agentType: string, what: string }} kind  the type, and what one call on it is named in the log ("service step")
 * @param {(prompt: string, opts: O) => Promise<R>} dispatch
 * @param {(message: string) => void} logLine
 * @param {() => boolean} [stopped]
 * @param {(got: unknown) => boolean} [isDeadline]
 */
export function makeTypeFallback(kind, dispatch, logLine, stopped = () => false, isDeadline = () => false) {
  const { agentType: TYPE, what } = kind
  const FALLBACK_LAUNCH = `${TYPE} (launch failed)`
  const FALLBACK_STEP = `${TYPE} (step rerun)`
  /** @type {Record<string, number>} */
  const counts = { [FALLBACK_LAUNCH]: 0, [FALLBACK_STEP]: 0 }
  let launchFailed = false
  let failuresInARow = 0
  /** @param {R} got @returns {R | null} */
  const settle = got => (isDeadline(got) ? null : got)
  /** @param {O} opts @returns {O} */
  const withoutType = opts => {
    const rest = { ...opts }
    delete rest.agentType
    return rest
  }
  /** The options a dispatch outside `run` goes with: the type dropped once it failed to launch. @param {O} opts @returns {O} */
  const route = opts => (launchFailed && opts.agentType === TYPE ? withoutType(opts) : opts)
  /** @param {string} prompt @param {O} opts @returns {Promise<R | null>} */
  async function run(prompt, opts) {
    if (opts.agentType !== TYPE) return settle(await dispatch(prompt, opts))
    if (launchFailed) return onDefault(prompt, opts, FALLBACK_LAUNCH)
    /** @type {{ got: R } | { threw: unknown }} */
    const first = await dispatch(prompt, opts).then(answer => ({ got: answer }), threw => ({ threw }))
    if ('threw' in first) return afterThrow(prompt, opts, first.threw)
    const got = first.got
    if (isDeadline(got)) return null
    if (fitsSchema(got, opts.schema)) {
      failuresInARow = 0
      return got
    }
    if (stopped()) return got
    return rerun(prompt, opts, got)
  }
  /** The call on the default type in the typed agent's place, counted under its reason. @param {string} prompt @param {O} opts @param {string} reason @returns {Promise<R | null>} */
  async function onDefault(prompt, opts, reason) {
    counts[reason] = (counts[reason] || 0) + 1
    return settle(await dispatch(prompt, withoutType(opts)))
  }
  /** The typed agent threw: this call on the default type; the type retired on a missing type or a second failure in a row. @param {string} prompt @param {O} opts @param {unknown} e @returns {Promise<R | null>} */
  async function afterThrow(prompt, opts, e) {
    if (stopped()) throw e
    const said = `agent '${opts.label || '?'}' as ${TYPE} threw (${String(e).replace(/\s+/g, ' ').slice(0, 160)})`
    if (launchFailed) return onDefault(prompt, opts, FALLBACK_LAUNCH)
    const reason = failed(said, isAgentTypeMissing(e, TYPE))
    if (reason === FALLBACK_STEP) logLine(`⚠️ ${said} — re-running this step once on the default agent type; later ${what}s still try ${TYPE}`)
    return onDefault(prompt, opts, reason)
  }
  /**
   * One more failure on the type in a row; returns the reason the default type answers this call under: the type
   * retired (logged here) on a recognised missing type or a second failure in a row, else this one call only.
   * @param {string} said @param {boolean} missing @returns {string}
   */
  function failed(said, missing) {
    if (launchFailed) return FALLBACK_LAUNCH // retired meanwhile by a concurrent call: already logged
    failuresInARow++
    if (!missing && failuresInARow < 2) return FALLBACK_STEP
    launchFailed = true
    logLine(`⚠️ ${said} — ${TYPE} could not launch: it and every later ${what} of this run go to the default agent type`)
    return FALLBACK_LAUNCH
  }
  /** The typed agent answered nothing or off its schema: one rerun on the default type. @param {string} prompt @param {O} opts @param {R} got @returns {Promise<R | null>} */
  async function rerun(prompt, opts, got) {
    const said = `agent '${opts.label || '?'}' as ${TYPE} ${got == null ? 'returned no result' : 'answered off its schema'}`
    const reason = failed(said, false)
    if (reason === FALLBACK_STEP) logLine(`⚠️ ${said} — re-running it once on the default agent type`)
    // The fallback never leaves the call worse off than the typed agent did: a throw from it (a spent budget)
    // is the next dispatch's to raise, and this call answers what the typed agent answered.
    try {
      return await onDefault(prompt, opts, reason)
    } catch (e) {
      logLine(`⚠️ agent '${opts.label || '?'}' on the default agent type threw (${String(e).slice(0, 160)}) — keeping what ${TYPE} answered`)
      return got
    }
  }
  /** @returns {{ agent: string, count: number }[]} the fallbacks so far by reason, for agentUnavailableRecord */
  const fallbacks = () => Object.entries(counts).filter(([, count]) => count > 0).map(([type, count]) => ({ agent: type, count }))
  return { run, route, fallbacks }
}
