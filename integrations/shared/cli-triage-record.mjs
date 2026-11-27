// The run records the triage driver files itself (integrations/shared/cli-triage-steps.mjs; realm @nick/craft, node #616): only
// for a run the craft binary never finished — an argument refused before anything ran, a start or resume that did not
// go through, a step lost with no status to read, the round backstop. A run the binary finished files its own record
// (`craft triage start --record`), and one it stopped on the usage limit files it when the resumed run finishes, so it
// is never filed twice. Each is written by the shared logger (integrations/shared/run-logging.mjs), a write that did
// not land said in the answer.
import { argumentRefusal } from './run-record.mjs'
import { makeRunLogger, quietly, telemetryLossNoter } from './run-logging.mjs'
import { stopNotRun } from './cli-review-stop.mjs'
import { telemetryLostSection } from './review-coverage.mjs'

/** @typedef {import('./cli-review-stop.mjs').StopCause} StopCause */
/** @typedef {{ agent: (prompt: string, opts?: Record<string, unknown>) => Promise<unknown>, log: (message: string) => void, budget?: { spent: () => number | null } }} Filer */

const ENGINE = 'triage-findings'

/**
 * The recorder of one triage run: its records keyed to `at().repo` and filed through `at().craftRoot`, and the
 * section the answer carries for any write that did not land.
 * @param {Filer} sb @param {string} craftVersion @param {() => { craftRoot: string, repo: string }} at
 */
export function triageRecorder(sb, craftVersion, at) {
  /** @type {string[]} */
  const lost = []
  const logRun = makeRunLogger({ call: quietly(sb.agent), phase: 'Record', target: at, noteLoss: telemetryLossNoter(lost, sb.log) })
  const spent = () => sb.budget?.spent() ?? null
  return {
    /** An argument refused before anything ran, its classes in `notRun`; the refusal's report. @param {Array<[string, string]>} refused */
    refusal: async refused => {
      const r = argumentRefusal({
        engine: ENGINE,
        why: refused.map(([why]) => why).join(' '),
        notRun: refused.map(([, cls]) => cls),
        craftVersion,
        outputTokens: spent(),
      })
      await logRun(r.record)
      return r.report
    },
    /** A run the binary never finished, INCOMPLETE with the cause's lines in `notRun`. @param {StopCause} cause */
    unfinished: async cause => {
      const { record } = argumentRefusal({ engine: ENGINE, why: '', notRun: stopNotRun(cause), craftVersion, outputTokens: spent() })
      await logRun({ ...record, verdict: 'INCOMPLETE' })
    },
    /** The section naming each write that did not land, '' when all did. */
    notes: () => telemetryLostSection(lost).trim(),
  }
}
