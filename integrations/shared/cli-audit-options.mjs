// The arguments of the audit engine (integrations/claude-code/src/audit.js), read for the craft binary's
// `craft audit start` (realm @nick/craft, node #588): the paths to audit (`--path`, each from the repository root, as
// given), the bytes one lens agent reads (`--batch-bytes`) and the lens agents one pass buys (`--lens-agents`) — which
// the binary judges past their form —, and those every kind's driver takes (integrations/shared/cli-step-options.mjs):
// the repository (`--cwd`), the binary, the plugin root and a run to resume. A value no agent can quote, or a budget
// that is no positive whole number, is refused before anything runs.
import { COMMON_KEYS, readCommonOptions } from './cli-step-options.mjs'
import { hasControl } from './cli-review-keys.mjs'

/** @typedef {import('./cli-step-read.mjs').KindOptions & { paths: string[], batchBytes: string, lensAgents: string }} AuditOptions  paths: [] for the whole project; batchBytes, lensAgents: the digits the binary reads, '' for its default */

/** The arguments only a start takes: a resumed run keeps its own. */
const START_ONLY = Object.freeze(['path', 'batchBytes', 'lensAgents'])

/** The arguments the engine takes. */
const AUDIT_KEYS = Object.freeze([...START_ONLY, ...COMMON_KEYS])

/** Why a `path` cannot be handed on. */
const AUDIT_PATH_CLASS = '`path` refused — not a path an agent can quote, nothing ran'
/** Why a budget cannot be handed on. */
const BUDGET_CLASS = 'a budget argument refused — not a positive whole number, nothing ran'

/** A path as given, when it is one an agent can quote. @param {unknown} v @returns {string | null} */
const onePath = v => {
  const p = typeof v === 'number' && Number.isFinite(v) ? String(v) : v
  return typeof p === 'string' && p.trim() !== '' && !hasControl(p) ? p : null
}

/**
 * The paths given: one or a list, each as it stands; [] when none was given (absent or null, as every optional
 * argument here). A path given empty — '', blank, an empty list — is refused, not read as the whole project: whoever
 * passed it meant a part.
 * @param {unknown} v @returns {{ paths: string[] } | { refused: string }}
 */
function pathsOf(v) {
  if (v === undefined || v === null) return { paths: [] }
  const given = Array.isArray(v) ? v : [v]
  const paths = given.map(onePath)
  if (paths.length && paths.every(p => p !== null)) return { paths: /** @type {string[]} */ (paths) }
  return { refused: `path=${JSON.stringify(v)} refused: each path must be a non-blank string with no control character. Nothing ran.` }
}

/**
 * A budget as the digits the binary reads, '' when absent or null, as every optional argument here; given empty or
 * blank, it is refused like any other value that is no positive whole number.
 * @param {Record<string, unknown>} a @param {string} key @returns {{ value: string } | { refused: string }}
 */
function budgetOf(a, key) {
  const v = a[key]
  if (v === undefined || v === null) return { value: '' }
  const text = typeof v === 'number' || typeof v === 'string' ? String(v).trim() : ''
  return /^[1-9]\d{0,15}$/.test(text) ? { value: text } : { refused: `${key}=${JSON.stringify(v)} refused: not a positive whole number. Nothing ran.` }
}

/** The refusal of a read, '' when it holds a value. @param {{ refused: string } | object} r */
const refusalOf = r => ('refused' in r ? r.refused : '')

/**
 * The options, or every refusal at once with its class, so a caller fixing one does not meet the next on the
 * re-launch.
 * @param {Record<string, unknown>} a  normalizeArgs' result
 * @returns {{ options: AuditOptions } | { refused: Array<[string, string]> }}
 */
export function readAuditOptions(a) {
  const paths = pathsOf(a['path'])
  const batchBytes = budgetOf(a, 'batchBytes')
  const lensAgents = budgetOf(a, 'lensAgents')
  /** @type {Array<[string, string]>} */
  const extra = [
    [refusalOf(paths), AUDIT_PATH_CLASS],
    [refusalOf(batchBytes), BUDGET_CLASS],
    [refusalOf(lensAgents), BUDGET_CLASS],
  ]
  const { common, refused } = readCommonOptions(a, { engine: 'audit', keys: AUDIT_KEYS, startOnly: START_ONLY, extra })
  if (refused.length || !('paths' in paths) || !('value' in batchBytes) || !('value' in lensAgents)) return { refused }
  return { options: { ...common, paths: paths.paths, batchBytes: batchBytes.value, lensAgents: lensAgents.value } }
}
