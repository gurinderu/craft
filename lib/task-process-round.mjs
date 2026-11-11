// One step's tasks in a process-per-task review driver (lib/task-process-run.mjs; realm @nick/craft, node #453): in
// parallel up to the concurrency limit, each through the host's own `runTask` (the pi adapter: lib/pi-review-task.mjs),
// then what the next submit tells the binary (lib/cli-review-commands.mjs, Said). A task past its deadline
// goes to `--abandoned`, which the binary fails at once; one that failed or ended with no answer file is left for the
// binary to ask again, as a dead Claude Code agent is. Once a task ran into the account's usage limit no other is
// started, as the Claude Code driver stops (lib/cli-review-limit.mjs): the limit's text goes to `--limit`, which ends
// the run INCOMPLETE with how to resume it. Once a task found the host not logged in no other is started either, and
// the driver stops before the submit (`login`), naming the run to resume once the human has logged in.

/** @typedef {import('./cli-review-step.mjs').Task} Task */
/** @typedef {{ id: string, outcome: 'answered' | 'unanswered' | 'abandoned' | 'limit' | 'login', why: string, rubricless: string }} Outcome  why: what a failure said; rubricless: the agent the task named whose prompt body was not found ('' none) */
/** @typedef {(t: Task) => Promise<Outcome>} RunTask */
/** @typedef {{ concurrency: number, host: string, runTask: RunTask, log: (line: string) => void }} RoundContext  host: the agent host as the notes name it */
/** @typedef {{ abandoned: string[], degraded: string[], limit: string, login: string, dispatched: number }} RoundResult  login: why the host is not logged in, '' when it is */

/**
 * Each item through `work`, at most `limit` at once, in order of start; `stop()` checked before each start.
 * @template T, R @param {T[]} items @param {number} limit @param {(item: T) => Promise<R>} work @param {() => boolean} stop
 * @returns {Promise<R[]>}
 */
export async function pool(items, limit, work, stop) {
  /** @type {R[]} */
  const out = []
  let next = 0
  const lane = async () => {
    while (next < items.length && !stop()) {
      const item = /** @type {T} */ (items[next++])
      out.push(await work(item))
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, lane))
  return out
}

/**
 * The degraded notes of a round: each agent whose prompt body was not found, and how many of its tasks ran without it.
 * @param {number} round @param {Outcome[]} outcomes @param {string} host @returns {string[]}
 */
function degradedNotes(round, outcomes, host) {
  /** @type {Map<string, number>} */
  const missing = new Map()
  for (const o of outcomes) if (o.rubricless) missing.set(o.rubricless, (missing.get(o.rubricless) ?? 0) + 1)
  return [...missing].map(([agent, n]) => `round ${round}: ${n} task(s) named \`${agent}\`, whose prompt body the ${host} driver did not find, and ran on the bare task prompt — this run is weaker than a normal one, not broken.`)
}

/**
 * Run a step's tasks and say what came of them.
 * @param {Task[]} tasks @param {number} round @param {RoundContext} ctx
 * @param {{ limit: string, login: string }} watch  the run's stops: the usage limit's text and the missing login's, '' until seen
 * @returns {Promise<RoundResult>}
 */
export async function runRound(tasks, round, ctx, watch) {
  const outcomes = await pool(tasks, ctx.concurrency, async t => {
    const got = await ctx.runTask(t)
    if (got.outcome === 'limit' && !watch.limit) watch.limit = got.why
    if (got.outcome === 'login' && !watch.login) watch.login = got.why
    if (got.outcome !== 'answered') ctx.log(`⚠️ task ${t.label}: ${got.outcome} — ${got.why}`)
    return got
  }, () => !!(watch.limit || watch.login))
  if (watch.limit) ctx.log(`⛔ usage limit reached (${watch.limit}) — no further task is started; the run reports what it has as INCOMPLETE`)
  const abandoned = outcomes.filter(o => o.outcome === 'abandoned').map(o => o.id)
  return { abandoned, degraded: degradedNotes(round, outcomes, ctx.host), limit: watch.limit, login: watch.login, dispatched: outcomes.length }
}
