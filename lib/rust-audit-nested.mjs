// What rust-audit (src/rust-audit.js) reads off a nested review answer beyond its verdict line
// (lib/cli-review-verdict.mjs writes it): the `## Findings` list as findings, the Degraded notes as the nested
// review's agents that ran on the default type (realm @nick/craft, node #153), and the gate alone's answer as the
// audit's one `gate` dimension (lib/cli-review-gate.mjs; realm @nick/craft, node #150).
import { reviewResult, verdictLine } from './rust-audit-verdict.mjs'
import { DEGRADED_LINE } from './cli-review-verdict.mjs'

/** @typedef {{ severity: string, title: string, location: string, detail: string }} Finding */

// One row of the answer's findings list: `- [<severity>] <file>[:<line>] — <title>[ (<tier>)]`.
const ROW = /^- \[([^\]]*)\] (.*?) — (.*)$/

/**
 * The text of `answer` under the heading `heading` (the line itself excluded), up to the next `## ` heading.
 * @param {string} answer @param {string} heading @returns {string | null}
 */
function under(answer, heading) {
  const at = answer.indexOf(`\n${heading}\n`)
  const start = answer.startsWith(`${heading}\n`) ? heading.length + 1 : at < 0 ? -1 : at + heading.length + 2
  if (start < 0) return null
  const rest = answer.slice(start)
  const next = rest.search(/^## /m)
  return next < 0 ? rest : rest.slice(0, next)
}

/**
 * The findings a nested review answer lists, one per row; [] when it lists none.
 * @param {unknown} answer @returns {Finding[]}
 */
export function cliFindings(answer) {
  const body = under(String(answer ?? ''), '## Findings') ?? ''
  return body.split('\n').flatMap(l => {
    const m = ROW.exec(l.trim())
    return m ? [{ severity: String(m[1]), title: String(m[3]), location: String(m[2]), detail: 'reported by the nested CLI review' }] : []
  })
}

/** The answer before its findings list, the verdict block whole. @param {string} answer @returns {string} */
function beforeFindings(answer) {
  const at = answer.indexOf('\n## Findings\n')
  return at < 0 ? answer : answer.slice(0, at)
}

/**
 * A nested review's answer as a dimension result: its verdict read as every nested review's is (reviewResult), the
 * verdict block — with the path of the report the binary wrote — as the one Info entry, then each finding it lists.
 * @param {string} dimension @param {unknown} answer
 */
export function cliReviewResult(dimension, answer) {
  const text = String(answer ?? '')
  const r = reviewResult(dimension, beforeFindings(text))
  // The nested memory line — and under it what the decisions and rules did, how many were given, set aside and raised
  // again (the binary's `prior decisions:` / `project rules:` notes) — rides with what memory set aside: the audit's
  // own memory line says each nested review reports how many it applied, and this is where it does. Lifted only when
  // the nested review set something aside or applied a record, so an audit whose reviews applied none adds no section.
  const line = (under(text, '## Memory') ?? '').trim()
  const applied = /^- (prior decisions|project rules): /m.test(line)
  const lifted = [r._priorDecisions ?? '', line && (applied || r._priorDecisions) ? `## Memory\n${line}` : ''].filter(Boolean).join('\n\n')
  return { ...r, findings: [...r.findings, ...cliFindings(text)], ...(lifted ? { _priorDecisions: lifted } : {}) }
}

// A note the review driver hands the binary (lib/cli-review-task.mjs, degradedNote): tasks of one agent that ran
// on the default type, or tasks naming an agent the plugin does not ship.
const SHIPPED = /^round \d+: (\d+) task\(s\) on `([^`]+)` ran on the default agent type instead, without its rubric \((.*)\) — /
const UNSHIPPED = /^round \d+: (\d+) task\(s\) named `([^`]+)`, which this plugin does not ship/

/**
 * The nested review's agents that ran weaker than asked, as the audit's section takes them: each note of the answer's
 * Degraded block read as an agent and its count; a note in wording this does not know is kept whole as one dispatch.
 * @param {unknown} answer @returns {{ agent: string, count: number, error?: string }[]}
 */
export function cliDegraded(answer) {
  const text = String(answer ?? '')
  const at = text.indexOf(`${DEGRADED_LINE}\n`)
  if (at < 0) return []
  const notes = []
  for (const line of text.slice(at + DEGRADED_LINE.length + 1).split('\n')) {
    if (!line.startsWith('- ')) break
    notes.push(line.slice(2))
  }
  return notes.map(n => {
    const m = SHIPPED.exec(n) ?? UNSHIPPED.exec(n)
    if (!m) return { agent: /`([^`]+)`/.exec(n)?.[1] || 'a task agent', count: 1, error: n.slice(0, 160) }
    return { agent: String(m[2]), count: Number(m[1]), ...(m[3] ? { error: String(m[3]) } : {}) }
  })
}

/**
 * The gate's verdict from its line: red a Block, a gate that did not run `INCOMPLETE (gate not established)` (it checked
 * nothing the audit can lean on), green an Approve; a gate whose signal stayed unknown says Warning (realm @nick/craft,
 * node #487), and a missing or unreadable line is a Warning too.
 * @param {string | null} line @returns {string}
 */
function gateVerdict(line) {
  if (line == null) return 'Warning'
  if (/⛔|\bBlock\b/.test(line)) return 'Block'
  // Not `INCOMPLETE (not run)`, which the audit reads as a tool not installed: a gate that did not run failed on a
  // fetch, its budget or a tool's run, and its summary says which.
  if (/INCOMPLETE/.test(line)) return 'INCOMPLETE (gate not established)'
  return /^✅ Approve\b|^Approve\b/.test(line) ? 'Approve' : 'Warning'
}

/**
 * The gate alone's answer as the audit's `gate` dimension: red is a Block whose summary is the review's own line,
 * green an Approve, a gate that did not run INCOMPLETE, one not established a Warning, an answer with no verdict a Warning that says so. The gate's section
 * rides as `_gateSection` — led by its line unless red, whose line leads the whole report — which the audit appends to
 * its report once and never hands the synthesis; the directory its result and seeds are kept in as `_gateDir`, which
 * each review takes (`gateFrom`).
 * @param {unknown} answer
 * @returns {{ dimension: string, verdict: string, summary: string, findings: Finding[], _gateSection?: string, _gateDir?: string }}
 */
export function gateResult(answer) {
  const text = String(answer ?? '')
  const line = verdictLine(text)
  const section = under(text, '## Gate')
  const verdict = gateVerdict(line)
  const dir = /Its result and seeds are kept in (\/.+?): a review of this change takes them/.exec(text)?.[1] ?? ''
  return {
    dimension: 'gate',
    verdict,
    summary: line ?? 'The mechanical gate\'s answer carried no verdict — the gate is unverified, not green.',
    findings: [],
    ...(section == null ? {} : { _gateSection: `## Gate\n\n${line && verdict !== 'Block' ? `${line}\n\n` : ''}${section.trim()}\n` }),
    ...(dir ? { _gateDir: dir } : {}),
  }
}
