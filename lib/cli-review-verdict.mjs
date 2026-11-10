// The answer a review run returns (lib/cli-review-steps.mjs): a `## Verdict` heading whose first line is the
// verdict, in the form every reader of a review report parses (lib/rust-audit-verdict.mjs, verdictLine), then where the
// report is. The line is the binary's own (the finished step's `line`, the report's verdict line, which says why when
// nothing or not everything was reviewed), marked with the glyph review's verdicts open with; with `comment`, what
// landed on the PR and how many findings wait for the reviewer — the caller asked for comments, so whether they landed
// is part of the answer. Then a `## Findings` list built from the binary's JSON, so a parent reading the answer
// (rust-audit's reviewResult, lib/rust-audit-verdict.mjs) has each finding without any model copying the report; and a
// run the binary held on the usage limit says `stopped: usage limit reached (<text>)`, the words a parent reads the
// stop by (limitInReport, lib/limit-report.mjs).

/** @typedef {import('./cli-review-record.mjs').Finding} Finding */
/** @typedef {{ run: string, report: string, verdict: string, line: string, degraded: boolean, degradedNotes?: string[], memorySections?: string, stopped?: boolean, stopNote?: string, findings?: Finding[], sorting?: Record<string, unknown> | null, prComments?: Record<string, unknown> | null }} Finished  stopNote: the binary's stop as a parent reads it, '' when none */

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

/** @param {unknown} v @returns {number} */
const tally = v => (typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : 0)

/**
 * What came of publishing on the PR, nothing without `comment`: the comments posted — marked when not every defect is on
 * the PR —, and the doubtful findings held back.
 * @param {Finished} step @returns {string[]}
 */
function publication(step) {
  if (!step.prComments) return []
  const held = tally(step.sorting?.['doubtful'])
  return [postedLine(step.prComments), ...(held ? [`Doubtful: ${held} finding(s) held back from the PR — the report's Doubtful section lists them for the human to choose; post a chosen one only through the craft:addressing-findings posting script.`] : [])]
}

/** The posting's outcome, marked when gh failed or not every defect is on the PR. @param {Record<string, unknown>} p @returns {string} */
function postedLine(p) {
  const error = typeof p['error'] === 'string' && p['error'] ? p['error'] : ''
  const short = tally(p['posted']) + tally(p['already']) < tally(p['requested'])
  const gh = error && error !== p['reason'] ? ` (gh: ${error})` : ''
  return `${error || short ? '⚠️ ' : ''}PR comments: ${tally(p['posted'])} of ${tally(p['requested'])} defect(s) posted, ${tally(p['already'])} already on the PR — ${String(p['reason'] ?? '')}${gh}.`
}

/**
 * The finished run: its verdict line and where its report is. No model copies the report: the caller reads the file.
 * @param {Finished} step @returns {string}
 */
export function finishedAnswer(step) {
  const weaker = step.degraded ? [degradedBlock(step.degradedNotes ?? [])] : []
  const line = step.line || step.verdict
  const stop = step.stopNote && !line.includes(step.stopNote) ? [`${step.stopNote}.`] : []
  const resume = step.stopped ? [resumeHint(step.run)] : []
  const verdict = block(line, [`The report is ${step.report} — read that file for the findings (run ${step.run}).`, ...publication(step), ...weaker, ...stop, ...resume])
  // The report's memory part, verbatim and before the findings list, so a parent lifts what memory set aside and the
  // nested memory line as it lifts a review's (lib/prior-decision-report.mjs; realm @nick/craft, node #196).
  const memory = (step.memorySections ?? '').trim()
  return `${verdict}\n\n${memory ? `${memory}\n\n` : ''}${findingsList(step.findings ?? [])}`
}

/**
 * The Degraded line, then each of the binary's notes verbatim, one bullet each: a parent reads them as its nested
 * review's agents that ran on the default type (rust-audit, lib/rust-audit-verdict.mjs, cliDegraded; realm @nick/craft,
 * node #153).
 * @param {string[]} notes @returns {string}
 */
const degradedBlock = notes => [DEGRADED_LINE, ...notes.map(n => `- ${oneLine(n)}`)].join('\n')

/** The line a degraded run's answer says it by; its notes follow as bullets. */
export const DEGRADED_LINE = '⚠️ Degraded: part of this review ran weaker than asked — the report\'s Degraded section says how.'

/** @param {unknown} v @returns {string} */
const oneLine = v => String(v ?? '').replace(/\s+/g, ' ').trim()

/**
 * The reported findings, one line each: severity, `file:line`, title and tier, as the binary's finished step names them.
 * @param {Finding[]} findings @returns {string}
 */
export function findingsList(findings) {
  const rows = findings.map(f => `- [${oneLine(f.severity) || 'unrated'}] ${oneLine(f.file)}${f.line ? `:${f.line}` : ''} — ${oneLine(f.title)}${f.tier ? ` (${oneLine(f.tier)})` : ''}`)
  return ['## Findings', '', ...(rows.length ? rows : ['None reported.'])].join('\n')
}

/**
 * How to resume the stopped run in `run`: this engine again with `run=`, or the binary's own submit, marked a resume so
 * an answer still missing is handed out again rather than counted as a failed attempt.
 * @param {string} run @returns {string}
 */
export const resumeHint = run => `To resume it once agents can answer again: the Workflow \`craft:review run=${run}\`, or the binary \`craft review submit --run '${run.replace(/'/g, "'\\''")}' --resume\`.`

/** A run that did not finish: INCOMPLETE, and why. @param {string} why @returns {string} */
export const stoppedAnswer = why => block(`INCOMPLETE — ${why}`, [])
