// The step the `craft` binary prints, as the review driver (lib/cli-review-steps.mjs) and the run-record adapter
// the binary runs (lib/cli-review-file.mjs) read it: a pending step's tasks, or a finished step's verdict, findings,
// ledger, publication and lens figures, each field checked and defaulted the one way both read it.
import { isTaskModel } from './cli-review-task.mjs'
import { millis } from './cli-review-clock.mjs'
import { hasControl } from './cli-review-keys.mjs'
import { harnessRefusal } from './cli-review-refusal.mjs'
import { findingsOf, isObject, publicationOf, roundOf, stepText, stopNoteOf, strings, telemetryOf } from './cli-review-step-fields.mjs'

export { isObject }

/** @typedef {{ id: string, label: string, model: string, promptFile: string, schemaFile: string, answerFile: string, agentType?: string, consumerAgent?: string, kind?: string }} Task  consumerAgent: the reviewed repository's own agent, by the name it gives it; kind: what the task is for, by which its deadline is set */
/** @typedef {import('./cli-review-record.mjs').Finding} Finding */
/** @typedef {{ runDir: string, rejoin: boolean, lost: string[], record: string }} Filing  what the binary's telemetry write after this step did (cli/crates/craft-review/src/filing.rs): the run directory its checkpoints went to ('' none yet), whether a later write re-enters it, each write that did not land as `<what> — <why>`, and on a finished step the record: `filed`, `failed`, '' when none was attempted */
/** @typedef {import('./cli-review-record.mjs').LedgerRow} LedgerRow */
/** @typedef {{ run: string, done: true, report: string, verdict: string, line: string, degraded: boolean, degradedNotes: string[], memorySections: string, head: string, base: string, findings: Finding[], uncovered: string[], notRun: string[], round: number, lensScope: 'delta' | 'full', ledger: LedgerRow[] | null, reReview: Record<string, unknown> | null, memory: Record<string, unknown> | null, strict: boolean, stopped: boolean, stopNote: string, repo: string, sorting: Record<string, unknown> | null, memoryContradictions: Record<string, unknown> | null, prComments: Record<string, unknown> | null, dimensions: Record<string, unknown>[], verification: Record<string, unknown> | null, lensRounds: Record<string, unknown>[] | null, at: number | null, took: number | null, filing: Filing | null }} Finished  ledger, memory, sorting, memoryContradictions and prComments null when the binary sent none (sorting and prComments: a run without comment); stopped when the binary held the run on the usage limit, to be resumed, stopNote that stop as a parent reads it ('' when none); memorySections the report's memory part verbatim — what memory set aside, the `## Memory` line, what was refused, the tools' finding titles — '' when the binary sent none; degradedNotes the binary's notes of how the run ran weaker than asked, as the host handed them in; repo the repository the run reviews, '' when the binary named none; dimensions, verification and lensRounds what its lenses yielded and verification judged ([] and null when the binary sent none); at and took the binary's clock (lib/cli-review-clock.mjs), null when it sent none; filing what the binary's own telemetry write did, null when it wrote none */
/** @typedef {{ run: string, done: false, tasks: Task[], head: string, repo: string, phase: string, at: number | null, took: number | null, filing: Filing | null } | Finished} Step  phase: the binary's phase the tasks run in, '' when it names none */

/**
 * An absolute path an agent can quote into a command, else null: POSIX, or a Windows drive path (`C:\…\craft.exe`,
 * as craft-bin prints it there), which the harness's Git Bash runs single-quoted as it stands.
 * @param {unknown} v @returns {string | null}
 */
export const absolutePath = v => (typeof v === 'string' && (v.startsWith('/') || /^[A-Za-z]:[\\/]/.test(v)) && !hasControl(v) ? v : null)

/** @param {unknown} t @returns {t is Task} */
function isTask(t) {
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

/**
 * The command's output from a service answer, or why there is none; `harness` the refused command ('' unquoted) when
 * the harness's permission layer refused it before it ran (realm @nick/craft, node #479).
 * @param {unknown} got @returns {{ stdout: string } | { error: string, harness?: string }}
 */
export function commandOutput(got) {
  // The note a parent reads a nested run's stop by (limitInReport, lib/limit-report.mjs).
  if (isObject(got) && typeof got['limit'] === 'string') return { error: `stopped: usage limit reached (${got['limit']})` }
  const refused = harnessRefusal(got)
  if (refused)
    return { error: `the harness's permission check refused the command, not craft: ${refused.command || 'it quoted none'}`, harness: refused.command }
  if (!isObject(got) || typeof got['stdout'] !== 'string') return { error: 'the service agent returned no command output' }
  if (got['exitCode'] !== 0)
    return {
      error: `the command exited ${String(got['exitCode'])}: ${String(got['stderr'] ?? '')
        .trim()
        .slice(0, 400)}`,
    }
  return { stdout: got['stdout'] }
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
      findings: findingsOf(v['findings']),
      uncovered: strings(v['uncovered']),
      notRun: strings(v['notRun']),
      memory: isObject(v['memory']) ? v['memory'] : null,
      strict: v['strict'] === true,
      stopped: isObject(v['stopped']),
      stopNote: stopNoteOf(v['stopped']),
      repo: stepText(v['repo']),
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
const filingOf = v =>
  isObject(v) ? { runDir: stepText(v['runDir']), rejoin: v['rejoin'] === true, lost: strings(v['lost']), record: stepText(v['record']) } : null

/** @param {Record<string, unknown>} v  a step with a run directory @returns {{ step: Step } | { error: string }} */
function pendingStep(v) {
  const tasks = v['tasks']
  if (v['done'] !== false || !Array.isArray(tasks) || !tasks.length || !tasks.every(isTask)) return { error: 'the step carries no well-formed tasks' }
  return {
    step: {
      run: /** @type {string} */ (v['run']),
      done: false,
      tasks,
      head: stepText(v['head']),
      repo: stepText(v['repo']),
      phase: stepText(v['phase']),
      ...clockOf(v),
    },
  }
}
