// One task's process in a process-per-task review driver (realm @nick/craft, node #453), whatever its host: the
// answer file cleared, the host's command run in the reviewed repository until its kind's deadline
// (lib/cli-review-deadline.mjs, the table the Claude Code driver races), then the one rule both hosts follow. Past the
// deadline the task is abandoned, which the binary fails at once. A failed process that says the account's usage limit
// (lib/usage-limit.mjs) or that the host is not logged in stops the run; any other failure, and a process that wrote
// no answer, is left unanswered, which the binary hands out again — as the Claude Code driver's dead agent is.
import fs from 'node:fs'
import path from 'node:path'
import { taskDeadlineMs } from './cli-review-deadline.mjs'
import { usageLimitText } from './usage-limit.mjs'
import { notLoggedIn } from './task-process-agents.mjs'
import { runProcess } from './task-process-spawn.mjs'

/** @typedef {import('./cli-review-step.mjs').Task} Task */
/** @typedef {import('./task-process-round.mjs').Outcome} Outcome */
/** @typedef {import('./task-process-spawn.mjs').Ran} Ran */
/** @typedef {{ name: string, login: RegExp, how: string }} HostWords  name: as the outcomes name it; login: what it says when not logged in; how: how to log in */
/** @typedef {{ repo: string, env: NodeJS.ProcessEnv, deadlineMs?: (kind: string | undefined) => number }} Place */

/**
 * @param {string} id @param {Outcome['outcome']} outcome @param {string} why @param {string} rubricless
 * @param {string} [said]  the last line the process wrote on stderr, '' none @returns {Outcome}
 */
export const outcomeOf = (id, outcome, why, rubricless, said = '') => ({ id, outcome, why, rubricless, ...(said ? { said } : {}) })

/** The last non-empty line a process wrote on stderr, '' none. @param {Ran} ran */
const lastError = ran => ran.stderr.split('\n').map(l => l.trim()).filter(Boolean).at(-1)?.slice(0, 300) ?? ''

/** The last lines of what a process said. @param {Ran} ran */
const tail = ran => `${ran.stderr}\n${ran.stdout}`.trim().split('\n').slice(-3).join(' ').slice(0, 300)

/**
 * A failed process's outcome: the usage limit and a missing login stop the run; anything else is left unanswered.
 * @param {Task} t @param {Ran} ran @param {string} rubricless @param {HostWords} host @returns {Outcome}
 */
function failedOutcome(t, ran, rubricless, host) {
  const said = `${ran.stderr}\n${ran.stdout}`
  const limit = usageLimitText(said)
  if (limit) return outcomeOf(t.id, 'limit', limit, rubricless)
  const login = host.login.exec(said)
  if (login) return outcomeOf(t.id, 'login', notLoggedIn(host.name, login[0], host.how), rubricless)
  return outcomeOf(t.id, 'unanswered', `${host.name} exited ${ran.exitCode}: ${tail(ran)}`, rubricless, lastError(ran))
}

/**
 * Run the task's process to its outcome; `settle(ran)` reads the answer the process wrote or printed into the task's
 * answer file, false when there is none.
 * @param {Task} t @param {{ file: string, args: string[], stdin?: string }} command @param {Place} place
 * @param {{ host: HostWords, rubricless: string, settle: (ran: Ran) => boolean }} how @returns {Promise<Outcome>}
 */
export async function runTaskProcess(t, command, place, { host, rubricless, settle }) {
  fs.rmSync(t.answerFile, { force: true })
  fs.mkdirSync(path.dirname(t.answerFile), { recursive: true })
  const ran = await runProcess(command.file, command.args, { cwd: place.repo, env: place.env, stdin: command.stdin ?? '', timeoutMs: (place.deadlineMs ?? taskDeadlineMs)(t.kind) })
  if (ran.timedOut) return outcomeOf(t.id, 'abandoned', 'past its deadline', rubricless)
  if (ran.exitCode !== 0) {
    // No answer from a failed process, whatever it wrote: the binary asks for it again.
    fs.rmSync(t.answerFile, { force: true })
    return failedOutcome(t, ran, rubricless, host)
  }
  return settle(ran) ? outcomeOf(t.id, 'answered', '', rubricless) : outcomeOf(t.id, 'unanswered', `${host.name} gave no answer: ${tail(ran)}`, rubricless, lastError(ran))
}
