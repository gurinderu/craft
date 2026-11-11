// One step's tasks run in Codex (realm @nick/craft, node #491): in parallel up to the concurrency limit, each its
// own `codex exec` (lib/codex-review-task.mjs), then what the next submit tells the binary (lib/cli-review-commands.mjs,
// Said). Only a task past its deadline goes to `--abandoned`, which the binary fails at once; a failed one leaves no
// answer, which the binary hands out again with its usual retries, as the Claude Code driver's dead agent does. Once a task ran
// into the account's usage limit no other is started, as the Claude Code driver stops (lib/cli-review-limit.mjs):
// those never started leave no answer, and the limit's text goes to `--limit`, which ends the run INCOMPLETE with how
// to resume it.
import { runTask } from './codex-review-task.mjs'

/** @typedef {import('./cli-review-step.mjs').Task} Task */
/** @typedef {import('./codex-review-task.mjs').Outcome} Outcome  one task's end, as every host's task runner reports it */
/** @typedef {{ abandoned: string[], degraded: string[], limit: string, dispatched: number }} RoundResult */

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
 * @param {number} round @param {Outcome[]} outcomes @param {string} host whose driver ran them @returns {string[]}
 */
function degradedNotes(round, outcomes, host) {
  /** @type {Map<string, number>} */
  const missing = new Map()
  for (const o of outcomes) if (o.rubricless) missing.set(o.rubricless, (missing.get(o.rubricless) ?? 0) + 1)
  return [...missing].map(([agent, n]) => `round ${round}: ${n} task(s) named \`${agent}\`, whose prompt body the ${host} driver did not find, and ran on the bare task prompt — this run is weaker than a normal one, not broken.`)
}

/**
 * Run a step's tasks through `runOne` and say what came of them: the round any host runs, its tasks its own.
 * @param {Task[]} tasks @param {number} round @param {{ concurrency: number, log: (line: string) => void }} ctx
 * @param {{ limit: string }} watch  the run's usage-limit watch, '' until one is seen
 * @param {(t: Task) => Promise<Outcome>} runOne @param {string} host whose driver runs them, for the degraded note
 * @returns {Promise<RoundResult>}
 */
export async function roundOf(tasks, round, ctx, watch, runOne, host) {
  const outcomes = await pool(tasks, ctx.concurrency, async t => {
    const got = await runOne(t)
    if (got.outcome === 'limit' && !watch.limit) watch.limit = got.why
    if (got.outcome !== 'answered') ctx.log(`⚠️ task ${t.label}: ${got.outcome} — ${got.why}`)
    return got
  }, () => !!watch.limit)
  if (watch.limit) ctx.log(`⛔ usage limit reached (${watch.limit}) — no further task is started; the run reports what it has as INCOMPLETE`)
  const abandoned = outcomes.filter(o => o.outcome === 'abandoned').map(o => o.id)
  return { abandoned, degraded: degradedNotes(round, outcomes, host), limit: watch.limit, dispatched: outcomes.length }
}

/**
 * Run a step's tasks in Codex and say what came of them.
 * @param {Task[]} tasks @param {number} round @param {{ concurrency: number, log: (line: string) => void } & import('./codex-review-task.mjs').TaskContext} ctx
 * @param {{ limit: string }} watch  the run's usage-limit watch, '' until one is seen
 * @returns {Promise<RoundResult>}
 */
export const runRound = (tasks, round, ctx, watch) => roundOf(tasks, round, ctx, watch, t => runTask(t, ctx), 'Codex')
