// The nested adversarial review's part of one review answer (realm @nick/craft, node #420): what the nested run
// returned, read into one shape; the worse of two verdicts; the labelled report section and the record field.
// Pure: no agent, no log, no workflow state.
import { VERDICT_WORD, honestVerdict, verdictLineAt } from './honest-verdict.mjs'
import { summarizeFindings } from './run-record.mjs'

/** The nested engine, by its bare name: the record and the report name it so. */
export const NESTED_ENGINE = 'adversarial-review'
// The notRun classes the nested part adds. Fixed strings, no file names: lib/analyze-runs.mjs ranks notRun by
// exact string, and a per-run spelling would sink a repeated failure into count-1 rows.
export const NESTED_DIED = 'the nested adversarial-review of the files outside every profile died or returned nothing — those files were NOT reviewed'
export const NESTED_THREW = 'the nested adversarial-review of the files outside every profile could not be launched — those files were NOT reviewed'
export const NESTED_PARTIAL = 'the nested adversarial-review of the files outside every profile is INCOMPLETE — part of it did not run'

/**
 * @typedef {{ title?: unknown, file?: unknown, line?: unknown, severity?: unknown, description?: unknown, fix?: unknown }} NestedFinding
 * @typedef {{ ran: boolean, files: string[], verdict: string, core: 'Block' | 'Warning' | 'Approve' | 'INCOMPLETE',
 *   confirmed: NestedFinding[], suspected: NestedFinding[], notRun: string[], own: string[], why: string }} NestedOutcome
 *   `verdict` the nested engine's own verdict string; `core` its verdict word; `notRun` its own list as it returned it;
 *   `own` the classes this part adds to the combined notRun; `why` what went wrong when it did not run
 */

/** @param {unknown} v @returns {unknown[]} */
const nestedList = v => (Array.isArray(v) ? v : [])

/**
 * The nested run's answer read into one shape: an object with a string verdict is a run; anything else (null, a
 * refusal's report string, an object without a verdict) is a run that did not happen.
 * @param {unknown} answer @param {string[]} files @param {string} [threw]  the launch's error message, when it threw
 * @returns {NestedOutcome}
 */
export function readNested(answer, files, threw = '') {
  const r = /** @type {Record<string, unknown> | null} */ (answer && typeof answer === 'object' ? answer : null)
  if (threw || !r || typeof r['verdict'] !== 'string') return notRunOutcome(answer, files, threw)
  const verdict = String(r['verdict'])
  const core = verdictCore(verdict)
  const incomplete = /INCOMPLETE/i.test(verdict)
  return {
    ran: true, files, verdict, core,
    confirmed: /** @type {NestedFinding[]} */ (nestedList(r['confirmed'])), suspected: /** @type {NestedFinding[]} */ (nestedList(r['suspected'])),
    notRun: nestedList(r['notRun']).map(String), own: incomplete ? [NESTED_PARTIAL] : [], why: '',
  }
}

/** A nested run that did not happen, with why. @param {unknown} answer @param {string[]} files @param {string} threw @returns {NestedOutcome} */
function notRunOutcome(answer, files, threw) {
  const why = threw ? `the launch threw: ${threw}` : answer == null ? 'it returned nothing' : 'its answer carried no verdict'
  return { ran: false, files, verdict: '', core: 'INCOMPLETE', confirmed: [], suspected: [], notRun: [], own: [threw ? NESTED_THREW : NESTED_DIED], why }
}

/** The verdict word of a verdict string: Block, Warning, Approve (also Healthy, Clean) or INCOMPLETE. @param {string} v */
function verdictCore(v) {
  const verdictWord = (VERDICT_WORD.exec(v)?.[1] ?? '').toLowerCase()
  if (verdictWord === 'block') return 'Block'
  if (verdictWord === 'warning') return 'Warning'
  if (verdictWord === 'incomplete' || verdictWord === '') return 'INCOMPLETE'
  return 'Approve'
}

/** @type {Record<string, number>} */
const VERDICT_RANK = { Block: 0, Warning: 1, Approve: 2, INCOMPLETE: 2 }

/**
 * The worse of a verdict string and the nested part's: the nested word replaces the leading one when it is worse
 * (an INCOMPLETE marker kept), and the nested part's own classes then make it honest.
 * @param {string} own  the review's verdict, suffix included @param {NestedOutcome} nested @returns {string}
 */
export function combinedVerdict(own, nested) {
  return honestVerdict(raisedVerdict(own, nested), nested.own)
}

/** @param {string} own @param {NestedOutcome} nested @returns {string} */
function raisedVerdict(own, nested) {
  const ownCore = verdictCore(own)
  if ((VERDICT_RANK[nested.core] ?? 2) >= (VERDICT_RANK[ownCore] ?? 2)) return own
  if (ownCore === 'INCOMPLETE') return `${nested.core} (INCOMPLETE)`
  return own.replace(/\b(?:Approve|Healthy|Clean|Warning)\b/i, nested.core)
}

/**
 * A rendered report with its verdict line raised to the nested part's verdict when that is worse.
 * @param {string} text @param {NestedOutcome} nested @returns {string}
 */
export function raiseVerdictLine(text, nested) {
  const lines = String(text).split('\n')
  const at = verdictLineAt(lines)
  if (at < 0) return text
  const line = String(lines[at])
  const lineCore = verdictCore(line.replace(/^[\s#*_>-]*verdict\b/i, ''))
  if ((VERDICT_RANK[nested.core] ?? 2) >= (VERDICT_RANK[lineCore] ?? 2)) return text
  const mark = nested.core === 'Block' ? '⛔ Block' : '⚠️ Warning'
  const to = lineCore === 'INCOMPLETE' ? `${mark} (INCOMPLETE)` : mark
  lines[at] = `${line.replace(/(?:(?:✅|⚠️?|⛔)\s*)?\b(?:Approve|Healthy|Clean|Warning|INCOMPLETE)\b/i, to)} · raised by the nested adversarial-review of the files outside every profile`
  return lines.join('\n')
}

/** @param {NestedFinding} f */
const capitalized = f => ({ ...f, severity: typeof f.severity === 'string' ? f.severity.charAt(0).toUpperCase() + f.severity.slice(1) : f.severity })
/** @param {NestedFinding} f */
const nestedFindingLine = f => `- ${capitalized(f).severity} · \`${String(f.file ?? '?')}:${Number(f.line) || 0}\` · ${String(f.title ?? '')} · ${String(f.description ?? '')} · Fix: ${String(f.fix ?? '')} · [${NESTED_ENGINE}]`

/**
 * The labelled section of the report the nested part brings.
 * @param {NestedOutcome} nested @param {boolean} posting  the run posts its findings on a PR @returns {string}
 */
export function nestedSection(nested, posting) {
  const head = `\n\n## Files outside every profile — nested ${NESTED_ENGINE}\n`
  const files = `Files: ${nested.files.join(', ')}`
  if (!nested.ran) return `${head}⚠️ It did not run (${nested.why}); these files were NOT reviewed. ${files}\n`
  return `${head}Its verdict: ${nested.verdict} · ${files}\n`
    + `\n### Confirmed\n${nested.confirmed.length ? nested.confirmed.map(nestedFindingLine).join('\n') : '- none'}\n`
    + (nested.suspected.length ? `\n### Suspected (needs confirmation)\n${nested.suspected.map(nestedFindingLine).join('\n')}\n` : '')
    + (nested.notRun.length ? `\n### Not run in it\n${nested.notRun.map(n => `- ${n}`).join('\n')}\n` : '')
    + (posting ? '\nThese findings are not posted on the PR: only the profile review\'s are.\n' : '')
}

/** The run record's `nestedReview` field. @param {NestedOutcome} nested */
export function nestedRecord(nested) {
  return {
    name: NESTED_ENGINE, ran: nested.ran, files: nested.files, verdict: nested.ran ? nested.verdict : null,
    findings: summarizeFindings([...nested.confirmed, ...nested.suspected].map(capitalized)), notRun: nested.notRun,
  }
}
