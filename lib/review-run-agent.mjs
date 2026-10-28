// The review engine's one dispatch path (src/review.js): every prompt goes through `ragent`, which retargets it
// at the reviewed checkout, races it against one deadline budget, re-dispatches a fast death once and stops
// dispatching review work after a usage limit.
import { shq, quietly } from './run-logging.mjs'
import { makeDeadlineBudget, DEADLINE_HIT } from './agent-deadline.mjs'
import { makeLimitStop } from './usage-limit.mjs'
import { deadlineMsFor, retryFloorMs } from './review-deadlines.mjs'

/**
 * @template T
 * @typedef {import('./review-schemas.mjs').Schema<T>} Schema
 */
/**
 * @typedef {ReturnType<typeof import('./agent-retry.mjs').makeDeathBreaker>} Breaker  the verification window's death breaker
 * @typedef {{ label?: string | undefined, phase?: string | undefined, schema?: object | undefined, model?: string | undefined,
 *   effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max' | undefined, isolation?: 'worktree' | undefined, agentType?: string | undefined }} AgentOptions  what the sandbox's agent() takes (lib/workflow-sandbox.d.ts)
 * @typedef {AgentOptions & { deadlineMs?: number | undefined, breaker?: Breaker | null | undefined, inSessionDir?: boolean | undefined, bookkeeping?: boolean | undefined }} AgentOpts  agent() options plus the four this engine strips (inSessionDir: no `repo` cd, the agent works where the session started; bookkeeping: a record write, dispatched even after a usage limit); closed, so a misspelt option is a type error
 */

// The options ragent takes on top of agent()'s, stripped before the dispatch.
/** @type {ReadonlyArray<'deadlineMs' | 'breaker' | 'inSessionDir' | 'bookkeeping'>} */
const ENGINE_OPTIONS = ['deadlineMs', 'breaker', 'inSessionDir', 'bookkeeping']

/**
 * The run's dispatch path.
 * @param {{ runAgent: (prompt: string, opts?: AgentOptions) => Promise<unknown>, logLine: (message: string) => void, repoArg: string, deadlineArg: number }} sb
 *   the sandbox's agent() and log(), the reviewed checkout (`repo`, '' for the session's own) and the caller's `deadlineMs` (0 when absent)
 */
export function makeReviewAgent({ runAgent, logLine, repoArg, deadlineArg }) {
// ---- resilient agent call ----
// agent() returns null when the subagent dies on a terminal API error (after the harness's own
// retries) or is skipped. A single quiet re-dispatch recovers most API deaths. Budget-exceeded
// THROWS and is deliberately not caught — retrying it would just throw again.
const AGENT_TRIES = 2
// Every prompt in this workflow goes through ragent, so this is the one place that can retarget the
// whole review at another checkout. Prepended (not appended) because it has to win over the git
// commands the individual prompts spell out; shq() because the path is an argument to a real `cd`.
const REPO_DIRECTIVE = repoDirective()
function repoDirective() {
  return repoArg
    ? `WORKING DIRECTORY: this review targets the repository at ${shq(repoArg)} — NOT the directory you start in. Before ANY git / cargo / nix / file command, \`cd\` there (or pass \`git -C\`). Every file path in this review is relative to that root. If that directory does not exist or is not a git repository, say so and stop rather than reviewing whatever repo you happen to be sitting in.\n\n`
    : ''
}
// The run's stop (realm @nick/craft, nodes #299, #300): once one agent failed on the usage limit, or a
// dispatch round the engine runs through `limitStop.round` died whole (raceLimited counts each attempt),
// ragent dispatches no more review work and re-dispatches none; only the bookkeeping writes still go, so
// the record is attempted (on the same account, so under an account-wide limit it stays in `.partial`
// for `craft-log-run recover`).
const limitStop = makeLimitStop(logLine)
/**
 * With a tagged `schema`, the validated answer or `null` (dead, skipped, or past its deadline); without
 * one, the agent's final text or `null` — `unknown`, since nothing here validates it.
 * @template [T=unknown]
 * @param {string} prompt
 * @param {AgentOpts & { schema?: Schema<T> | undefined }} [opts]
 * @returns {Promise<T | null>}
 */
async function ragent(prompt, opts = {}) {
  // deadlineMs, breaker, inSessionDir and bookkeeping are ours, not agent()'s -- strip them so none reaches the harness
  // as an unknown option.
  const { breaker, bookkeeping } = opts
  /** @type {AgentOpts} */
  const agentOpts = { ...opts }
  for (const own of ENGINE_OPTIONS) delete agentOpts[own]
  if (!bookkeeping && limitStop.seen()) return null
  const ms = deadlineMsFor(opts, deadlineArg)
  // ONE budget for the whole call, not one per attempt. The worst case of a hanging dispatch is
  // therefore `ms` of waiting in total rather than `ms` per attempt — which, in the Verify window,
  // is the difference between one slot held for 30 minutes and one held for an hour.
  // ARMED, not measured: the sandbox has no clock at all (see the module), so every attempt races
  // the SAME timer rather than a fresh one computed from elapsed time.
  const deadlineBudget = makeDeadlineBudget(ms, { floorMs: retryFloorMs(ms) })
  try {
    // The one place the sandbox's `unknown` becomes the schema's type: agent() validates against the
    // schema it was handed, and `opts.schema` is that schema with the type it validates into.
    return /** @type {T | null} */ (await withBudget(prompt, agentOpts, deadlineBudget, breaker, opts))
  } finally {
    // The armed timers outlive the answer otherwise, holding the run open for the whole deadline.
    deadlineBudget.dispose()
  }
}

/** @param {string} prompt @param {AgentOptions} agentOpts @param {ReturnType<typeof makeDeadlineBudget>} deadlineBudget @param {Breaker | null | undefined} breaker @param {AgentOpts} opts @returns {Promise<unknown>} */
async function withBudget(prompt, agentOpts, deadlineBudget, breaker, opts) {
  for (let attempt = 1; ; attempt++) {
    const o = attempt === 1 ? agentOpts : { ...agentOpts, label: `retry:${agentOpts.label || 'agent'}` }
    // The SHARED deadline promise, not a per-attempt timer. A second attempt inherits what is left
    // of the first one's wait by construction — there is nothing to subtract and no clock to read.
    // inSessionDir: the one step that must read the session's own project, not the `repo` under review.
    const res = await raceLimited(prompt, o, deadlineBudget, opts)
    if (res === LIMIT_HIT) return null
    // Asked AFTER the race, so it reflects the state the attempt actually ended in. A re-dispatch
    // launched below the floor would fire the deadline before the agent could answer, costing a
    // harness slot to produce nothing.
    const spentOut = deadlineBudget.belowFloor()
    if (res === DEADLINE_HIT) {
      logDeadlineFire(o, deadlineBudget)
      return null
    }
    if (res !== null && res !== undefined) {
      // A live answer enters the window as one observation of a reachable API: an outage that ended
      // slides out of the window and the re-dispatch comes back for the next isolated failure.
      if (breaker) breaker.recordLive()
      return res
    }
    if (!redispatchAfterDeath(attempt, spentOut, deadlineBudget, breaker, opts)) return null
  }
}

const LIMIT_HIT = { craftUsageLimit: true }
/** One attempt raced against the deadline; LIMIT_HIT when it failed on a usage limit (thrown or answered). @param {string} prompt @param {AgentOptions} o @param {ReturnType<typeof makeDeadlineBudget>} deadlineBudget @param {AgentOpts} opts @returns {Promise<unknown>} */
async function raceLimited(prompt, o, deadlineBudget, opts) {
  // Each attempt of review work is one dispatch of the open rounds and, coming back null, one death; a
  // bookkeeping write is not review work and counts for nothing.
  if (!opts.bookkeeping) limitStop.observeDispatch()
  try {
    const res = await Promise.race([runAgent(`${opts.inSessionDir ? '' : REPO_DIRECTIVE}${prompt}`, o), deadlineBudget.hit])
    if (res == null && !opts.bookkeeping) limitStop.observeDeath()
    return limitStop.observeAnswer(res) ? LIMIT_HIT : res
  } catch (e) {
    if (limitStop.observeError(e)) return LIMIT_HIT
    throw e
  }
}

/** A deadline fire, logged against the budget it spent. @param {AgentOptions} o @param {ReturnType<typeof makeDeadlineBudget>} deadlineBudget */
function logDeadlineFire(o, deadlineBudget) {
  // Deliberately neither counted by the breaker nor a reset of it: a deadline fire cannot be
  // told apart from a live agent taking too long, and feeding that into the window would let slow
  // work suppress the retry that real work depends on. The breaker reads deaths, never durations.
  // THE BUDGET, NOT WHAT THIS ATTEMPT WAITED, and the log says which. With no clock there is no
  // honest per-attempt figure — an earlier version printed one and it was wrong by most of the
  // deadline on a second attempt. A number nobody computed is worse than a coarser number that
  // is true, because the transcript is the only carrier this run's clock is ever measured from
  // and a reader calibrates deadlines against what it says.
  // Sub-minute budgets print as seconds rather than rounding up to "1min": `deadlineMs=30000` is
  // a documented diagnostic value, and a log calling it "0min" or "1min" hides the very setting
  // whose effects the reader is trying to see.
  const ms = deadlineBudget.total()
  const waited = ms >= 60000 ? `${Math.round(ms / 60000)}min budget` : `${Math.max(1, Math.round(ms / 1000))}s budget`
  // A DEADLINE FIRE NEVER RE-DISPATCHES, and this is an identity rather than a policy: the timer
  // is armed ONCE, for the whole budget, when the budget is created — so its firing IS the budget
  // running out, and one budget shared by the attempts leaves the next one nothing to wait in. The branch that used to re-dispatch here
  // is unreachable under that arithmetic, so it is gone rather than left as reassuring dead text.
  // The re-dispatch survives for the case it was always really for: the FAST death, which spends
  // almost none of the budget. A hang is evidence about the request; a fast death is evidence
  // about reachability, and only the second is worth asking twice.
  logLine(`⏱️ agent '${o.label || '?'}' exhausted its ${waited} with no response — abandoning the wait (the deadline is one budget shared by the attempts and a fire spends it, so there is nothing left to re-dispatch into; treated as a dead agent)`)
}

/**
 * After an attempt that came back empty: whether to re-dispatch (true) or treat the agent as dead (false).
 * @param {number} attempt @param {boolean} spentOut @param {ReturnType<typeof makeDeadlineBudget>} deadlineBudget
 * @param {Breaker | null | undefined} breaker @param {AgentOpts} opts @returns {boolean}
 */
function redispatchAfterDeath(attempt, spentOut, deadlineBudget, breaker, opts) {
  // A stopped run re-dispatches no review work; a bookkeeping write still gets its second attempt.
  if (!opts.bookkeeping && limitStop.seen()) return false
  if (attempt >= AGENT_TRIES) return false
  // A death that arrived slowly can exhaust the budget too, and then the re-dispatch buys nothing.
  if (spentOut) {
    // Says how much was left and what it was measured against, rather than the flat "nothing left"
    // that used to be printed over a remainder that was merely below the floor. The transcript is
    // the only carrier this run's clock is ever measured from, and "spent" and "below the floor"
    // are different events that a future reader has to be able to tell apart.
    logLine(`⏱️ agent '${opts.label || '?'}' returned no result with less than the ${Math.round(retryFloorMs(deadlineBudget.total()) / 1000)}s floor left of its ${Math.round(deadlineBudget.total() / 1000)}s deadline budget — NOT re-dispatching (a second attempt would time out before it could answer); treated as a dead agent`)
    return false
  }
  // The dead-agent route, and the expensive one: `agent()` resolved null after the harness spent
  // its own retry ladder on an unreachable API, and the re-dispatch below spends a second ladder
  // inside the same verification window slot. On a one-off failure that is worth the clock; once
  // half of the recent windowed dispatches are coming back empty it is not, and the breaker's
  // window is what says which this is.
  //
  // The log says exactly what the breaker counted and nothing more. Only a FIRST attempt reaches
  // this line (the line above returns on the last one), so the window holds one observation per
  // dispatched unit of work — never per harness call. A message phrased as "the Nth death in a
  // row" claimed both a consecutive run the window does not track and a count of dispatches it
  // does not hold: with one re-dispatch per death, an outage of N observed deaths has already
  // cost up to 2N−(suppressed) harness dispatches.
  if (breaker && !breaker.deathAllowsRedispatch()) {
    logLine(`⛔ agent '${opts.label || '?'}' returned no result — ${breaker.deaths()} of the last ${breaker.observed()} windowed verification dispatches returned nothing, so this one is NOT re-dispatched (the re-dispatch is for a one-off failure, and at this rate it is not one); treated as a dead agent, reported as unverified exactly like every other death`)
    return false
  }
  logLine(`⚠️ agent '${opts.label || '?'}' returned no result (API death or skip) — re-dispatching once`)
  return true
}
// The bookkeeping calls — the run record, the phase checkpoints, the prior-round read — must not
// take the run down when they throw. `quietly` is the shared wrapper (lib/run-logging.mjs); here it is bound to `ragent` so the retry-once behaviour still applies underneath.
// The wrapper is generic over the callback, so what it yields is ragent's answer, null, or the throw.
/**
 * ragent for a bookkeeping write: still dispatched after a usage limit stopped the review work.
 * @template [T=unknown]
 * @param {string} p
 * @param {AgentOpts & { schema?: Schema<T> | undefined }} o
 * @returns {Promise<T | null>}
 */
function ragentBookkeeping(p, o) {
  return ragent(p, { ...o, bookkeeping: true })
}
const ragentQuietly = quietly(ragentBookkeeping)
/**
 * A quiet call's outcome split in two: the answer (null when the agent died OR threw), and the throw's
 * message ('' when it did not throw).
 * @template T
 * @param {T | { __threw: string } | null} res
 * @returns {{ answer: T | null, threw: string }}
 */
function splitThrew(res) {
  if (res && typeof res === 'object' && '__threw' in res) return { answer: null, threw: String(res.__threw) }
  return { answer: /** @type {T | null} */ (res), threw: '' }
}
return { AGENT_TRIES, REPO_DIRECTIVE, limitStop, ragent, ragentQuietly, splitThrew }
}
