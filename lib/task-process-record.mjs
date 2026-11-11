// A process-per-task review driver's side of a run's telemetry (Codex, pi; realm @nick/craft, node #456): the binary files every run it
// finishes, and stopped ones, itself; the driver files only the INCOMPLETE record of a run the binary never finished
// and an argument's refusal, as the Claude Code driver does (lib/cli-review-record.mjs, cliRecorder). There a logger
// agent runs the one write path; here the driver is Node, so it calls that write path, lib/craft-log-run.mjs, in
// process, as the binary's adapter does (lib/cli-review-file.mjs), with the records' own builders (cliRecord,
// argumentRefusal). Every write the binary or the driver could not land is said in the answer (telemetryLostSection).
import { run as craftLogRun } from './craft-log-run.mjs'
import { cliRecord, heardLosses, settledNotes } from './cli-review-record.mjs'
import { telemetryLostSection } from './review-coverage.mjs'
import { logRunOutcome, telemetryLossNoter } from './run-logging.mjs'

/** @typedef {import('./cli-review-step.mjs').Step} Step */
/** @typedef {import('./cli-review-step.mjs').Finished} Finished */
/** @typedef {{ craftVersion: string, repo: string, depth: string, strict: boolean, via: string, store?: string, cwd: string, log: (line: string) => void, driver: (run: string) => string }} RecorderOpts  repo: the repository given, '' for none, the record then keyed to `cwd`, the session's checkout; store: the run store, by default craft-log-run's own */

/**
 * The recorder of one run: `heard(step)` takes what the binary's own telemetry write after a step did; `settled(finished)`
 * the notes a finished run's answer carries; `missing(why)` those of a run whose record no one can file;
 * `unfinished(resumed, outcome)` the INCOMPLETE record of a run the binary never finished, into the directory its
 * checkpoints went to; `refusal(record)`
 * a refused argument's record; `notes()` the telemetry section. A write that does not land never fails the run.
 * @param {RecorderOpts} o
 */
export function taskProcessRecorder({ craftVersion, repo: given, depth, strict, via, store = '', cwd, log, driver }) {
  let repo = given
  /** @type {string[]} */
  const lost = []
  const noteLoss = telemetryLossNoter(lost, log)
  let filing = { runDir: '', rejoin: false }
  /** @param {string} command @param {Record<string, unknown>} record @param {string[]} dirFlags */
  async function write(command, record, dirFlags) {
    const project = repo || cwd
    const r = await craftLogRun([command, ...dirFlags, '--project', project, ...(store ? ['--store', store] : [])], {}, project, () => JSON.stringify(record))
    const landed = logRunOutcome({ ok: r.exitCode === 0, output: [...r.stdout, ...r.stderr] })
    if (!landed.ok) noteLoss('the run record', landed.reason, false)
    else if (landed.reason) noteLoss('the run directory (the record itself landed)', landed.reason, true)
  }
  /** @param {Step} step */
  function heard(step) {
    if (step.filing) filing = step.filing
    heardLosses(step, lost, log)
  }
  /** @param {Finished} finished */
  const settled = finished => settledNotes(finished, lost, noteLoss, driver(finished.run))
  /** @param {import('./cli-review-record.mjs').Outcome} outcome */
  const file = outcome => write('finalize', cliRecord(outcome, { craftVersion, depth, strict, via: via || null, outputTokens: null }), [...(filing.runDir ? ['--dir', filing.runDir] : []), ...(filing.rejoin ? ['--rejoin'] : [])])
  /**
   * The INCOMPLETE record of a run the binary never finished, filed unless the run is a resume (`resumed`) whose
   * repository neither repo= nor the binary named: filed under the session's checkout it would land in another
   * repository's history, so it is not filed and the note says why ('' when filed).
   * @param {boolean} resumed @param {import('./cli-review-record.mjs').Outcome} outcome @returns {Promise<string>}
   */
  async function unfinished(resumed, outcome) {
    if (resumed && !repo) return 'No run record was filed: the resumed run\'s repository is unknown (the resume ended before the binary named it, and no repo= was given).'
    await file(outcome)
    return ''
  }
  return {
    heard, settled, unfinished,
    missing: (/** @type {string} */ why) => { noteLoss('the run record', why, false); return telemetryLostSection(lost) },
    refusal: (/** @type {Record<string, unknown>} */ record) => write('write', { ...record, driver: 'cli' }, []),
    keyTo: (/** @type {string} */ r) => { repo = r },
    notes: () => telemetryLostSection(lost),
  }
}

/** @typedef {ReturnType<typeof taskProcessRecorder>} Recorder */
