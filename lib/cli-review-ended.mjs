// How a run ended as the binary's `craft review status` says it (cli/crates/craft-review/src/status.rs, `filing`), for
// the review driver when it could not read the step that ended it (lib/cli-review-steps.mjs, recovered): the step
// the run's segment ended with, as the binary filed it, and whether its record is to be filed again.
import { NO_OUTPUT, absolutePath, commandOutput, finishedStep, isObject } from './cli-review-step.mjs'
import { stepText, stopNoteOf, strings } from './cli-review-step-fields.mjs'
import { hasControl } from './cli-review-keys.mjs'

/** @typedef {import('./cli-review-step.mjs').Finished} Finished */
/** @typedef {{ run: string, report: string, verdict: string, line: string, stopped: boolean, done: boolean, record: string, stopNote: string, degradedNotes: string[], worktree: string, prComments: Record<string, unknown> | null, sorting: Record<string, unknown> | null, lost: string[], pending: number }} Brief  a run the binary ended as its brief status says it (cli/crates/craft-review/src/status.rs, brief): record `filed`, `failed`, '' when none was attempted; stopNote, degradedNotes, worktree, prComments and sorting as a finished step's (lib/cli-review-step.mjs; sorting only its counts); lost each telemetry write after its last step that did not land; pending how many stopped parts' records still wait */

/** The status JSON a service step printed, null when none. @param {unknown} got @returns {Record<string, unknown> | null} */
function statusOf(got) {
  const out = commandOutput(got)
  if ('error' in out) return null
  try {
    /** @type {unknown} */
    const v = JSON.parse(out.stdout)
    return isObject(v) ? v : null
  } catch {
    return null
  }
}

/**
 * The step the run's segment ended with, null when the binary says it has not ended (or said nothing readable).
 * `refile`: a finished run whose record did not land — a resume files it again; a stopped run's is filed by the
 * resume that goes on with it, so it ends as it stands. `unrecorded`: a run the binary finished but whose finished
 * step it never kept — cut between its end and its record — so nothing is left to file its record from.
 * @param {unknown} got @returns {{ finished: Finished, refile: boolean } | { unrecorded: string } | null}
 */
export function endedOf(got) {
  const status = statusOf(got)
  const filing = status?.['filing']
  if (!isObject(filing)) return null
  if (!isObject(filing['finished'])) return status?.['done'] === true ? { unrecorded: unrecordedWhy(status) } : null
  const read = finishedStep(filing['finished'])
  if ('error' in read) return null
  return { finished: read.step, refile: status?.['done'] === true && filing['record'] !== 'filed' }
}

/**
 * Whether the status command ran but left no status that could be read — its output empty, missing or not whole: the
 * service agent could not copy it — the finished step it embeds grows with the findings — and the brief status may be
 * read where it was not (realm @nick/craft, node #522). A harness refusal, the usage limit and a failed command keep
 * their own paths.
 * @param {unknown} got @returns {boolean}
 */
export function statusUnreadable(got) {
  const out = commandOutput(got)
  return 'error' in out ? out.error === NO_OUTPUT : statusOf(got) === null
}

/**
 * The run's segment as the binary's brief status says it ended, null when it says it has not (or said nothing
 * readable): `unread` when the binary kept the step it ended with — its record filed, or to be filed again
 * (`refile`) — and `unrecorded` as endedOf says it.
 * @param {unknown} got @returns {{ unread: Brief, refile: boolean } | { unrecorded: string } | null}
 */
export function briefOf(got) {
  const status = statusOf(got)
  const filing = status?.['filing']
  if (!status || !isObject(filing)) return null
  if (filing['kept'] !== true) return status['done'] === true ? { unrecorded: unrecordedWhy(status) } : null
  const ended = briefRead(status, filing)
  return ended ? { unread: ended, refile: ended.done && ended.record !== 'filed' } : null
}

/** The brief status's run, null when it names no run, report or verdict. @param {Record<string, unknown>} status @param {Record<string, unknown>} filing @returns {Brief | null} */
function briefRead(status, filing) {
  const run = absolutePath(status['run'])
  const report = absolutePath(status['report'])
  const verdict = status['verdict']
  if (run === null || report === null || typeof verdict !== 'string') return null
  const said = status['line']
  const line = typeof said === 'string' && said && !hasControl(said) ? said : verdict
  const record = typeof filing['record'] === 'string' ? filing['record'] : ''
  return { run, report, verdict, line, stopped: status['stopped'] === true, done: status['done'] === true, record, ...briefParts(status, filing) }
}

/**
 * What the brief status says beside the verdict, none of it growing with the findings: the stop, the degraded notes,
 * the worktree line, the publication's counts, and the telemetry's lost writes and waiting parts.
 * @param {Record<string, unknown>} status @param {Record<string, unknown>} filing
 */
const briefParts = (status, filing) => ({
  stopNote: stopNoteOf(status['stop']),
  degradedNotes: strings(status['degraded']),
  worktree: stepText(status['worktree']),
  prComments: isObject(status['prComments']) ? status['prComments'] : null,
  sorting: isObject(status['sorting']) ? status['sorting'] : null,
  lost: strings(filing['lost']),
  pending: Number.isInteger(filing['pending']) && Number(filing['pending']) > 0 ? Number(filing['pending']) : 0,
})

/** Why a finished run has no record, naming its verdict and report. @param {Record<string, unknown> | null} status */
const unrecordedWhy = status =>
  `the craft binary finished the run (${String(status?.['verdict'] ?? 'no verdict')}; its report is ${String(status?.['report'] ?? 'not named')}) but kept no finished step to file its record from, so the run store has no record of it`

/**
 * Where an unfinished run stands as the binary says it — `round N, phase P`, each only when the status names it — for
 * a stop that claims no round or phase the binary does not report (realm @nick/craft, node #485); '' when it says none.
 * @param {unknown} got @returns {string}
 */
export function standingOf(got) {
  const status = statusOf(got)
  const atRound = status?.['round']
  const inPhase = status?.['phase']
  const said = [
    Number.isInteger(atRound) && Number(atRound) > 0 ? `round ${String(atRound)}` : '',
    typeof inPhase === 'string' && inPhase && inPhase.length <= 60 && !hasControl(inPhase) ? `phase ${inPhase}` : '',
  ]
  return said.filter(Boolean).join(', ')
}
