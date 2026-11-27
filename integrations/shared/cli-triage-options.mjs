// The arguments of the triage engine (integrations/claude-code/src/triage-findings.js), read for the craft binary's
// `craft triage start` (realm @nick/craft, node #616): the ones the engine always took, which the binary judges —
// a source, the refs, the prior ledger, the launcher's records —, the repository, and the driver's own: the binary
// to run (craftBin), the plugin root (craftRoot) and a run to resume (run). An argument the engine does not take, or a
// repo= or a path no agent can quote, is refused before anything runs (realm @nick/craft, node #411).
import { UNKNOWN_OPTION_CLASS, unknownOptionsRefusal } from './workflow-args.mjs'
import { REPO_REFUSED_CLASS, readRepoArg } from './repo-arg.mjs'
import { absolutePath } from './cli-review-step.mjs'
import { shellWord } from './plugin-script.mjs'

/** @typedef {{ report: string, pr: string, base: string, prBase: string, repo: string, priorLedger: string, priorDecisions: string, craftBin: string | null, craftRoot: string, run: string }} TriageOptions  priorLedger and priorDecisions the JSON the binary reads, '' none; craftBin shell-quoted, null for the released binary; run the directory of a run to resume, '' to start one */

/** The arguments the engine takes. */
export const TRIAGE_KEYS = Object.freeze(['pr', 'report', 'base', 'prBase', 'priorLedger', 'priorDecisions', 'craftRoot', 'craftBin', 'repo', 'run'])

/** Why a path argument cannot be quoted to an agent. */
const PATH_REFUSED_CLASS = 'a path argument refused — not an absolute path an agent can quote, nothing ran'

/** Start-only arguments cannot change the saved run (realm @nick/craft, node #616). @param {Record<string, unknown>} a */
function startOnlyBesideRun(a) {
  if (!a['run']) return ''
  const given = ['pr', 'report', 'base', 'prBase', 'priorLedger', 'priorDecisions'].filter(k => a[k] !== undefined)
  return given.length
    ? `triage-findings cannot honour ${given.map(k => `\`${k}\``).join(', ')} beside run=: a resumed run keeps its start options. Drop them to resume it, or start a new triage to change them. Nothing ran.`
    : ''
}

/** A text argument: its string form when given (truthy), else ''. @param {unknown} v @returns {string} */
const textArg = v => (v ? String(v) : '')

/** The JSON the binary reads for a list argument, '' when none was given. @param {unknown} v @returns {string} */
const jsonArg = v => (v === undefined || v === null || v === '' ? '' : typeof v === 'string' ? v : JSON.stringify(v))

/**
 * A path argument as given: '' when absent, the path when absolute, else its refusal.
 * @param {Record<string, unknown>} a @param {string} key @returns {{ path: string } | { refused: string }}
 */
function pathArg(a, key) {
  if (!a[key]) return { path: '' }
  const path = absolutePath(a[key])
  return path === null ? { refused: `${key}=${JSON.stringify(a[key])} refused: not an absolute path. Nothing ran.` } : { path }
}

/**
 * The options, or every refusal at once with its class, so a caller fixing one does not meet the next on the
 * re-launch.
 * @param {Record<string, unknown>} a  normalizeArgs' result
 * @returns {{ options: TriageOptions } | { refused: Array<[string, string]> }}
 */
export function readTriageOptions(a) {
  const repo = readRepoArg(a['repo'])
  const paths = Object.fromEntries(['craftBin', 'craftRoot', 'run'].map(k => [k, pathArg(a, k)]))
  /** @type {Array<[string, string]>} */
  const all = [
    [unknownOptionsRefusal(a, TRIAGE_KEYS, 'triage-findings'), UNKNOWN_OPTION_CLASS],
    [startOnlyBesideRun(a), 'start options beside run= were refused, nothing ran'],
    [repo.refused, REPO_REFUSED_CLASS],
    ...Object.values(paths).map(p => /** @type {[string, string]} */ (['refused' in p ? p.refused : '', PATH_REFUSED_CLASS])),
  ]
  const refused = all.filter(([why]) => why)
  if (refused.length) return { refused }
  /** @param {string} k */
  const path = k => /** @type {{ path: string }} */ (paths[k]).path
  return {
    options: {
      report: textArg(a['report']),
      pr: textArg(a['pr']),
      base: textArg(a['base']),
      prBase: textArg(a['prBase']),
      repo: repo.repo,
      priorLedger: jsonArg(a['priorLedger']),
      priorDecisions: jsonArg(a['priorDecisions']),
      craftBin: path('craftBin') ? shellWord(path('craftBin')) : null,
      craftRoot: path('craftRoot'),
      run: path('run'),
    },
  }
}
