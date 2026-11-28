// The arguments of the triage engine (integrations/claude-code/src/triage-findings.js), read for the craft binary's
// `craft triage start` (realm @nick/craft, node #616): the ones the engine always took, which the binary judges —
// a source, the refs, the prior ledger, the launcher's records —, and those every kind's driver takes
// (integrations/shared/cli-step-options.mjs): the repository, the binary, the plugin root and a run to resume. An
// argument the engine does not take, or a repo= or a path no agent can quote, is refused before anything runs (realm
// @nick/craft, node #411).
import { COMMON_KEYS, readCommonOptions } from './cli-step-options.mjs'

/** @typedef {{ report: string, pr: string, base: string, prBase: string, repo: string, priorLedger: string, priorDecisions: string, craftBin: string | null, craftRoot: string, run: string }} TriageOptions  priorLedger and priorDecisions the JSON the binary reads, '' none; craftBin shell-quoted, null for the released binary; run the directory of a run to resume, '' to start one */

/** The arguments only a start takes: a resumed run keeps its own. */
const START_ONLY = Object.freeze(['pr', 'report', 'base', 'prBase', 'priorLedger', 'priorDecisions'])

/** The arguments the engine takes. */
export const TRIAGE_KEYS = Object.freeze([...START_ONLY, ...COMMON_KEYS])

/** A text argument: its string form when given (truthy), else ''. @param {unknown} v @returns {string} */
const textArg = v => (v ? String(v) : '')

/** The JSON the binary reads for a list argument, '' when none was given. @param {unknown} v @returns {string} */
const jsonArg = v => (v === undefined || v === null || v === '' ? '' : typeof v === 'string' ? v : JSON.stringify(v))

/**
 * The options, or every refusal at once with its class, so a caller fixing one does not meet the next on the
 * re-launch.
 * @param {Record<string, unknown>} a  normalizeArgs' result
 * @returns {{ options: TriageOptions } | { refused: Array<[string, string]> }}
 */
export function readTriageOptions(a) {
  const { common, refused } = readCommonOptions(a, { engine: 'triage-findings', keys: TRIAGE_KEYS, startOnly: START_ONLY })
  if (refused.length) return { refused }
  return {
    options: {
      ...common,
      report: textArg(a['report']),
      pr: textArg(a['pr']),
      base: textArg(a['base']),
      prBase: textArg(a['prBase']),
      priorLedger: jsonArg(a['priorLedger']),
      priorDecisions: jsonArg(a['priorDecisions']),
    },
  }
}
