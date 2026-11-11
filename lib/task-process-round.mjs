// One step's tasks in a process-per-task review driver (lib/task-process-run.mjs; realm @nick/craft, node #453): in
// parallel up to the concurrency limit, each through the host's own `runTask` (lib/codex-review-task.mjs, lib/pi-review-task.mjs),
// then what the next submit tells the binary (lib/cli-review-commands.mjs, Said). A task past its deadline
// goes to `--abandoned`, which the binary fails at once; one that failed or ended with no answer file is left for the
// binary to ask again, as a dead Claude Code agent is. Once a task ran into the account's usage limit no other is
// started, as the Claude Code driver stops (lib/cli-review-limit.mjs): the limit's text goes to `--limit`, which ends
// the run INCOMPLETE with how to resume it. Once a task found the host not logged in no other is started either, and
// the driver stops before the submit (`login`), naming the run to resume once the human has logged in.

/** @typedef {import('./cli-review-step.mjs').Task} Task */
/** @typedef {{ id: string, outcome: 'answered' | 'unanswered' | 'abandoned' | 'limit' | 'login', why: string, rubricless: string, said?: string, degraded?: string }} Outcome  why: what a failure said; rubricless: the agent the task named whose prompt body was not found ('' none); said: the last line a process that gave no answer wrote on stderr; degraded: how else the host ran the task weaker than asked, in its own words (OpenCode's missing agent, lib/opencode-review-task.mjs) */
/** @typedef {(t: Task) => Promise<Outcome>} RunTask */
/** @typedef {{ concurrency: number, host: string, runTask: RunTask, log: (line: string) => void }} RoundContext  host: the agent host as the notes name it */
/** @typedef {{ abandoned: string[], degraded: string[], limit: string, login: string, dispatched: number, errors: string[], allDied: boolean }} RoundResult  errors: the last stderr line of each task that gave no answer; allDied: no task of the round answered  login: why the host is not logged in, '' when it is */

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
  /** @type {Map<string, number>} */
  const other = new Map()
  for (const o of outcomes) {
    if (o.rubricless) missing.set(o.rubricless, (missing.get(o.rubricless) ?? 0) + 1)
    if (o.degraded) other.set(o.degraded, (other.get(o.degraded) ?? 0) + 1)
  }
  return [
    ...[...missing].map(([agent, n]) => `round ${round}: ${n} task(s) named \`${agent}\`, whose prompt body the ${host} driver did not find, and ran on the bare task prompt — this run is weaker than a normal one, not broken.`),
    ...[...other].map(([note, n]) => `round ${round}: ${n} task(s) ${note} — this run is weaker than a normal one, not broken.`),
  ]
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
  const errors = outcomes.flatMap(o => (o.said ? [o.said] : []))
  const allDied = outcomes.length > 0 && !outcomes.some(o => o.outcome === 'answered')
  return { abandoned, degraded: degradedNotes(round, outcomes, ctx.host), limit: watch.limit, login: watch.login, dispatched: outcomes.length, errors, allDied }
}

// How many distinct error lines the answer's section names.
const SAID_SHOWN = 3

/**
 * What the run's dead agents said, for an answer the binary can only blame on a limit or an outage: the distinct last
 * error lines, the most frequent first, at most three, each with its count; '' when none was heard.
 * @param {Map<string, number>} said @returns {string}
 */
export function saidSection(said) {
  if (!said.size) return ''
  const lines = [...said].sort((a, b) => b[1] - a[1]).slice(0, SAID_SHOWN).map(([line, n]) => `- ${n} task(s): \`${line.replace(/`/g, "'")}\``)
  return `## What the agents said\n\nThe tasks that gave no answer last wrote:\n\n${lines.join('\n')}`
}

/**
 * A round's tasks counted into the run's: those dispatched, each dead task's last error line, and whether none answered.
 * @param {{ spent: { agents: number }, said: Map<string, number>, allDied: boolean }} r @param {RoundResult} said
 */
export function heardRound(r, said) {
  r.spent.agents += said.dispatched
  for (const line of said.errors) r.said.set(line, (r.said.get(line) ?? 0) + 1)
  if (said.allDied) r.allDied = true
}
