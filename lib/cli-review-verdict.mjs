// The answer a cli-review run returns (lib/cli-review-steps.mjs): a `## Verdict` heading whose first line is the
// verdict, in the form every reader of a review report parses (lib/rust-audit-verdict.mjs, verdictLine), then where the
// report is. The line is the binary's own (the finished step's `line`, the report's verdict line, which says why when
// nothing or not everything was reviewed), marked with the glyph review's verdicts open with.

/** @typedef {{ run: string, report: string, verdict: string, line: string, degraded: boolean, stopped?: boolean }} Finished */

/**
 * The line with the glyph of its verdict, unless it opens with one already: a red verdict ⛔, a clean one ✅, any
 * other — a Warning, INCOMPLETE, PARTIAL COVERAGE — ⚠️.
 * @param {string} line @returns {string}
 */
function markedLine(line) {
  if (!/^[A-Za-z]/.test(line)) return line
  if (/^Block\b/.test(line)) return `⛔ ${line}`
  return /^Approve\b/.test(line) && !/INCOMPLETE|PARTIAL COVERAGE/.test(line) ? `✅ ${line}` : `⚠️ ${line}`
}

/** @param {string} line @param {string[]} rest @returns {string} */
const block = (line, rest) => ['## Verdict', '', markedLine(line), ...rest.flatMap(r => ['', r])].join('\n')

/**
 * The finished run: its verdict line and where its report is. No model copies the report: the caller reads the file.
 * @param {Finished} step @returns {string}
 */
export function finishedAnswer(step) {
  const weaker = step.degraded ? ['⚠️ Degraded: part of this review ran weaker than asked — the report\'s Degraded section says how.'] : []
  const resume = step.stopped ? [resumeHint(step.run)] : []
  return block(step.line || step.verdict, [`The report is ${step.report} — read that file for the findings (run ${step.run}).`, ...weaker, ...resume])
}

/**
 * How to resume the stopped run in `run`: this engine again with `run=`, or the binary's own submit, marked a resume so
 * an answer still missing is handed out again rather than counted as a failed attempt.
 * @param {string} run @returns {string}
 */
export const resumeHint = run => `To resume it once agents can answer again: the Workflow \`craft:cli-review run=${run}\`, or the binary \`craft review submit --run '${run.replace(/'/g, "'\\''")}' --resume\`.`

/** A run that did not finish: INCOMPLETE, and why. @param {string} why @returns {string} */
export const stoppedAnswer = why => block(`INCOMPLETE — ${why}`, [])
