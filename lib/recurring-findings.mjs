// Findings that recur across branches of one project, read from craft's run store — what
// addressing-findings shows the author before asking whether a recurrence is a lesson worth recording
// (realm @nick/craft, node #205: lessons come from recurrence, the author decides; this reader only
// finds and never writes). Deterministic: no model, no network, the Node standard library only.
//
// A finding recurs when the review ledgers of at least two DIFFERENT branches hold it (the grouping:
// lib/recurring-groups.mjs). The same branch reviewed twice is one occurrence. Only runs of the current
// project count: the record's `project` is the main checkout root (repoKey, the key the logger files it under). Partial runs (a
// reconstructed, unverified ledger) and runs with no branch are left out and counted.
//
// Run: `node lib/recurring-findings.mjs [--store <dir>] [--project <dir>] [--path <p>]...` — the store
// defaults to ~/.craft/runs, the project to the working directory. Prints one JSON object.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parseJsonObject } from './json-object.mjs'
import { decisionScopeParts } from './prior-decision-record.mjs'
import { recurringGroups, RECURRING_GROUPS_MAX } from './recurring-groups.mjs'
import { repoKey } from './craft-log-run.mjs'
import { outputLines, runIfMain } from './script-main.mjs'

// The newest run records read; older ones are counted and named in `note`, never silently dropped.
export const RECURRING_RUNS_MAX = 500

/**
 * @typedef {import('./recurring-groups.mjs').Row} Row
 * @typedef {import('./recurring-groups.mjs').Run} Run
 */

/** @param {unknown} v @returns {string} */
const text = v => (typeof v === 'string' ? v.trim() : '')

/**
 * Whether `file` is one of `paths` or inside one of them; every file when no path is given.
 * @param {string} file @param {string[]} paths
 */
function touched(file, paths) {
  if (!paths.length) return true
  const f = decisionScopeParts(file)
  return paths.some(p => {
    const s = decisionScopeParts(p)
    return s.length <= f.length && s.every((x, i) => x === f[i])
  })
}

// Only a finding that was real is a lesson's material: a row the author rejected as wrong, one the
// verifiers refuted, a row the author justified ("not a defect here" — live or as a dismissed tombstone,
// alike) and a deferred row (a known defect carried round to round under an open question: counting it
// would offer the same known defect as a recurrence on every branch touching its file) are left out;
// open, confirmed and resolved rows count.
export const REAL_FINDING_RULE = 'rejected, refuted, justified, deferred and dismissed findings are not counted — only findings that were real and not already settled'

// The dispositions that settle a row without it being a fresh, real occurrence.
const NOT_REAL = new Set(['rejected', 'justified', 'deferred'])

/** Whether a ledger row records a finding that was real (REAL_FINDING_RULE). @param {Record<string, unknown>} o */
function wasReal(o) {
  if (NOT_REAL.has(text(o['disposition'])) || text(o['tier']) === 'refuted') return false
  return !(text(o['disposition']) === 'closed' && /^dismissed /.test(text(o['why'])))
}

/**
 * The ledger rows of one record that can be grouped: a file and a title, under the touched paths, of a
 * finding that was real.
 * @param {unknown} ledger @param {string[]} paths @returns {Row[]}
 */
function ledgerRows(ledger, paths) {
  return (Array.isArray(ledger) ? ledger : []).flatMap(e => {
    const o = /** @type {Record<string, unknown>} */ (e && typeof e === 'object' ? e : {})
    const row = { file: text(o['file']), title: text(o['title']), severity: text(o['severity']) }
    return row.file && row.title && wasReal(o) && touched(row.file, paths) ? [row] : []
  })
}

/**
 * Reads the store: the newest RECURRING_RUNS_MAX records, those of `project` kept as runs.
 * @param {string} store @param {string} project @param {string[]} paths
 */
export function readRuns(store, project, paths) {
  const skipped = { otherProject: 0, partial: 0, noBranch: 0, noLedger: 0, unreadable: 0 }
  /** @type {Run[]} */
  const runs = []
  const names = fs.readdirSync(store).filter(f => f.endsWith('.json')).sort().reverse()
  const read = names.slice(0, RECURRING_RUNS_MAX)
  for (const name of read) {
    /** @type {Record<string, unknown>} */
    let rec
    try { rec = parseJsonObject(fs.readFileSync(path.join(store, name), 'utf8')) } catch { skipped.unreadable++; continue }
    if (rec['project'] !== project) skipped.otherProject++
    else if (rec['partial']) skipped.partial++
    else if (!text(rec['branch'])) skipped.noBranch++
    else if (!Array.isArray(rec['ledger'])) skipped.noLedger++
    else runs.push({ file: name, ts: text(rec['ts']), branch: text(rec['branch']), rows: ledgerRows(rec['ledger'], paths) })
  }
  return { runs, skipped, runsRead: read.length, runsNotRead: names.length - read.length }
}

/**
 * The flags: `--store`, `--project`, `--path` (repeatable). A flag without its value → an error line.
 * @param {string[]} argv @returns {{ store: string, project: string, paths: string[] } | string}
 */
function parseArgs(argv) {
  const o = { store: '', project: '', paths: /** @type {string[]} */ ([]) }
  for (let i = 0; i < argv.length; i++) {
    const a = /** @type {string} */ (argv[i])
    if (!['--store', '--project', '--path'].includes(a)) return `unknown argument ${JSON.stringify(a)} — use --store <dir>, --project <dir>, --path <p>`
    const v = argv[++i]
    if (v == null || v.startsWith('--')) return `${a} needs a value`
    if (a === '--path') o.paths.push(v)
    else o[a === '--store' ? 'store' : 'project'] = v
  }
  return o
}

/**
 * The reader's command line; prints one JSON object. Exit 2 only on an unreadable command line.
 * @param {string[]} argv @param {NodeJS.ProcessEnv} _env  unused: the home directory comes from `home`
 * @param {string} [home] where ~/.craft/runs lives
 * @returns {Promise<import('./script-main.mjs').ScriptResult>}
 */
export async function run(argv, _env, home = os.homedir()) {
  const o = outputLines()
  const args = parseArgs(argv)
  if (typeof args === 'string') {
    o.stderr.push(`recurring-findings: ${args}`)
    return { exitCode: 2, ...o }
  }
  const store = args.store || path.join(home, '.craft', 'runs')
  const project = repoKey(args.project || process.cwd())
  const base = { store, project, paths: args.paths }
  if (!fs.existsSync(store)) {
    o.stdout.push(JSON.stringify({ ...base, runsRead: 0, runsNotRead: 0, groups: [], groupsCut: 0, note: `no run store at ${store} — no recurrence to show` }, null, 2))
    return { exitCode: 0, ...o }
  }
  const { runs, skipped, runsRead, runsNotRead } = readRuns(store, project, args.paths)
  const { groups, groupsCut } = recurringGroups(runs)
  const notes = [
    `${runs.length} run(s) of this project read`,
    REAL_FINDING_RULE,
    runsNotRead ? `${runsNotRead} older run(s) past the bound of ${RECURRING_RUNS_MAX} were not read` : '',
    groupsCut ? `${groupsCut} more recurring group(s) past the bound of ${RECURRING_GROUPS_MAX} not listed` : '',
  ].filter(Boolean)
  o.stdout.push(JSON.stringify({ ...base, runsRead, runsNotRead, skipped, groups, groupsCut, note: notes.join('; ') }, null, 2))
  return { exitCode: 0, ...o }
}

await runIfMain(import.meta.url, run)
