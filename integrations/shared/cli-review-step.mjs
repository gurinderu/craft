// The step the `craft` binary prints, as the review driver (integrations/shared/cli-review-steps.mjs) and the binary's own record
// writer (cli/crates/craft-store, held to integrations/shared/binary-filing-replay.mjs) read it: a pending step's tasks, or a finished step's verdict, findings,
// ledger, publication and lens figures, each field checked and defaulted the one way both read it.
import { isTaskModel } from './cli-review-task.mjs'
import { millis } from './cli-review-clock.mjs'
import { hasControl } from './cli-review-keys.mjs'
import { harnessRefusal } from './cli-review-refusal.mjs'
import { chainOf, findingsOf, heldOf, isObject, publicationOf, roundOf, stepText, stopNoteOf, strings, telemetryOf } from './cli-review-step-fields.mjs'

export { isObject }

/** @typedef {{ id: string, label: string, model: string, promptFile: string, schemaFile: string, answerFile: string, agentType?: string, consumerAgent?: string, kind?: string }} Task  consumerAgent: the reviewed repository's own agent, by the name it gives it; kind: what the task is for, by which its deadline is set */
/** @typedef {import('./cli-review-record.mjs').Finding} Finding */
/** @typedef {{ runDir: string, rejoin: boolean, lost: string[], record: string }} Filing  what the binary's telemetry write after this step did (cli/crates/craft-review/src/filing.rs): the run directory its checkpoints went to ('' none yet), whether a later write re-enters it, each write that did not land as `<what> — <why>`, and on a finished step the record: `filed`, `failed`, '' when none was attempted */
/** @typedef {import('./cli-review-record.mjs').LedgerRow} LedgerRow */
/** @typedef {{ run: string, done: true, report: string, verdict: string, line: string, degraded: boolean, degradedNotes: string[], memorySections: string, head: string, base: string, path: string, findings: Finding[], unverifiedLow: { count: number, file: string } | null, uncovered: string[], notRun: string[], capped: string[], round: number, lensScope: 'delta' | 'full', ledger: LedgerRow[] | null, reReview: Record<string, unknown> | null, memory: Record<string, unknown> | null, strict: boolean, stopped: boolean, stopNote: string, repo: string, worktree: string, sorting: Record<string, unknown> | null, memoryContradictions: Record<string, unknown> | null, prComments: Record<string, unknown> | null, dimensions: Record<string, unknown>[], verification: Record<string, unknown> | null, lensRounds: Record<string, unknown>[] | null, seedYield: Record<string, unknown> | null, unattributedYield: Record<string, unknown> | null, unattributedConfirmed: number | null, at: number | null, took: number | null, filing: Filing | null }} Finished  unverifiedLow the unverified Low and Info findings the binary held apart from the report (realm @nick/craft, node #636), null when none; ledger, memory, sorting, memoryContradictions and prComments null when the binary sent none (sorting and prComments: a run without comment; ledger: always null on a step the binary prints for the host — it goes only to its own filing, cli/crates/craft-store; realm @nick/craft, node #522); stopped when the binary held the run on the usage limit, to be resumed, stopNote that stop as a parent reads it ('' when none); memorySections the report's memory part verbatim — what memory set aside, the `## Memory` line, what was refused, the tools' finding titles — '' when the binary sent none; path the directory the run was confined to ('' for the whole change); degradedNotes the binary's notes of how the run ran weaker than asked, as the host handed them in; repo the repository the run reviews, '' when the binary named none; worktree the line naming craft's own worktree of the PR given the run reviews in, '' when it reviews the checkout it started in; dimensions, verification and lensRounds what its lenses yielded and verification judged, seedYield, unattributedYield and unattributedConfirmed what the rounds' yield leaves beside them ([] and null when the binary sent none); at and took the binary's clock (integrations/shared/cli-review-clock.mjs), null when it sent none; filing what the binary's own telemetry write did, null when it wrote none */
/** @typedef {{ run: string, done: false, tasks: Task[], head: string, repo: string, phase: string, round: number, lensScope: 'delta' | 'full', base: string, path: string, at: number | null, took: number | null, filing: Filing | null } | Finished} Step  phase: the binary's phase the tasks run in, '' when it names none; round, lensScope, base and path as a finished step's, round 1, full and '' from a binary that sends none on a pending one */

/**
 * An absolute path an agent can quote into a command, else null: POSIX, or a Windows drive path (`C:\…\craft.exe`,
 * as craft-bin prints it there), which the harness's Git Bash runs single-quoted as it stands.
 * @param {unknown} v @returns {string | null}
 */
export const absolutePath = v => (typeof v === 'string' && (v.startsWith('/') || /^[A-Za-z]:[\\/]/.test(v)) && !hasControl(v) ? v : null)

/** @param {unknown} t @returns {t is Task} */
export function isTask(t) {
  if (!isObject(t)) return false
  const s = /** @param {string} k */ k => typeof t[k] === 'string'
  const file = /** @param {string} k */ k => absolutePath(t[k]) !== null
  const optional = /** @param {string} k */ k => t[k] === undefined || s(k)
  return (
    s('id') &&
    s('label') &&
    isTaskModel(t['model']) &&
    file('promptFile') &&
    file('schemaFile') &&
    file('answerFile') &&
    optional('agentType') &&
    optional('consumerAgent') &&
    optional('kind')
  )
}

/** Why a service step's answer is no command output: it carried none. */
export const NO_OUTPUT = 'the service agent returned no command output'

/** How the limit's note opens: it says itself that the run stopped. */
export const STOPPED = 'stopped: '

/**
 * The command's output from a service answer, or why there is none; `harness` the refused command ('' unquoted) when
 * the harness's permission layer refused it before it ran (realm @nick/craft, node #479).
 * @param {unknown} got @returns {{ stdout: string } | { error: string, harness?: string }}
 */
export function commandOutput(got) {
  // The note a parent reads a nested run's stop by (limitInReport, integrations/shared/limit-report.mjs).
  if (isObject(got) && typeof got['limit'] === 'string') return { error: `${STOPPED}usage limit reached (${got['limit']})` }
  const refused = harnessRefusal(got)
  if (refused)
    return { error: `the harness's permission check refused the command, not craft: ${refused.command || 'it quoted none'}`, harness: refused.command }
  if (!isObject(got) || typeof got['stdout'] !== 'string') return { error: unread(got) }
  if (got['exitCode'] !== 0)
    return {
      error: `the command exited ${String(got['exitCode'])}: ${String(got['stderr'] ?? '')
        .trim()
        .slice(0, 400)}`,
    }
  return { stdout: got['stdout'] }
}

/**
 * Why an answer carries no command output: a paged step whose pages could not all be read
 * (integrations/shared/cli-review-paged.mjs), or none at all. @param {unknown} got @returns {string}
 */
const unread = got => (isObject(got) && typeof got['cut'] === 'string' ? `${UNREAD_WHOLE}: ${got['cut']}` : NO_OUTPUT)

/** Why a paged step's answer carries no output: its pages could not all be read (integrations/shared/cli-review-paged.mjs). */
export const UNREAD_WHOLE = "the command's output could not be read whole"

/** The exit of a `craft` command that refused an argument before any work, as clap's own usage errors exit (main.rs). */
const ARGUMENT_REFUSED = 2

/**
 * Why the binary refused an argument it was given — the command ran and exited 2, its reason on stderr — said as the
 * driver says its own refused arguments; null for any other outcome, a harness refusal included (realm @nick/craft,
 * node #523).
 * @param {unknown} got @param {string} [engine]  the engine whose start refused it, as its answers name it @returns {string | null}
 */
export function argumentRefused(got, engine = 'review') {
  if (!isObject(got) || got['exitCode'] !== ARGUMENT_REFUSED || harnessRefusal(got)) return null
  const why = String(got['stderr'] ?? '')
    .trim()
    .replace(/^craft: /, '')
    .slice(0, 600)
  return why ? `${engine}: ${why}. Nothing ran.` : null
}

/**
 * The step the binary printed, or why it cannot be read.
 * @param {unknown} got @returns {{ step: Step } | { error: string, harness?: string }}
 */
export function readStep(got) {
  const out = commandOutput(got)
  if ('error' in out) return out
  /** @type {unknown} */
  let v
  try {
    v = JSON.parse(out.stdout)
  } catch {
    return { error: `the command printed no JSON: ${out.stdout.slice(0, 200)}` }
  }
  if (!isObject(v) || absolutePath(v['run']) === null) return { error: 'the step names no run directory' }
  return v['done'] === true ? finishedStep(v) : pendingStep(v)
}

/** @param {Record<string, unknown>} v  a step with a run directory @returns {{ step: Finished } | { error: string }} */
export function finishedStep(v) {
  const report = absolutePath(v['report'])
  const verdict = v['verdict']
  if (report === null || typeof verdict !== 'string') return { error: 'a finished step names no report or verdict' }
  return {
    step: {
      run: /** @type {string} */ (v['run']),
      done: true,
      report,
      verdict,
      line: stepText(v['line']),
      degraded: strings(v['degraded']).length > 0,
      degradedNotes: strings(v['degraded']),
      memorySections: stepText(v['memorySections']),
      head: stepText(v['head']),
      base: stepText(v['base']),
      path: stepText(v['path']),
      findings: findingsOf(v['findings']),
      unverifiedLow: heldOf(v['unverifiedLow']),
      uncovered: strings(v['uncovered']),
      notRun: strings(v['notRun']),
      capped: strings(v['capped']),
      memory: isObject(v['memory']) ? v['memory'] : null,
      strict: v['strict'] === true,
      stopped: isObject(v['stopped']),
      stopNote: stopNoteOf(v['stopped']),
      repo: stepText(v['repo']),
      worktree: stepText(v['worktree']),
      ...roundOf(v),
      ...publicationOf(v),
      ...telemetryOf(v),
      ...clockOf(v),
    },
  }
}

/** The binary's clock on a step — when it printed it and how long its command ran — and its telemetry write. @param {Record<string, unknown>} v */
const clockOf = v => ({ at: millis(v['at']), took: millis(v['took']), filing: filingOf(v['filing']) })

/** What the binary's telemetry write did, null when it sent none. @param {unknown} v @returns {Filing | null} */
export const filingOf = v =>
  isObject(v) ? { runDir: stepText(v['runDir']), rejoin: v['rejoin'] === true, lost: strings(v['lost']), record: stepText(v['record']) } : null

/**
 * The tasks of a pending step, any kind's — at least one, each well-formed —, or why there are none.
 * @param {Record<string, unknown>} v @returns {{ tasks: Task[] } | { error: string }}
 */
export function pendingTasks(v) {
  const tasks = v['tasks']
  return v['done'] !== false || !Array.isArray(tasks) || !tasks.length || !tasks.every(isTask) ? { error: 'the step carries no well-formed tasks' } : { tasks }
}

/** @param {Record<string, unknown>} v  a step with a run directory @returns {{ step: Step } | { error: string }} */
function pendingStep(v) {
  const read = pendingTasks(v)
  if ('error' in read) return read
  const { tasks } = read
  return {
    step: {
      run: /** @type {string} */ (v['run']),
      done: false,
      tasks,
      head: stepText(v['head']),
      repo: stepText(v['repo']),
      phase: stepText(v['phase']),
      ...chainOf(v),
      base: stepText(v['base']),
      path: stepText(v['path']),
      ...clockOf(v),
    },
  }
}
