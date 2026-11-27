// The command lines of the triage on the CLI's step protocol (realm @nick/craft, node #616), as shell text for the
// service agent's Bash: `craft triage start` with the engine's arguments, and the submit and status every kind shares
// (integrations/shared/cli-step-commands.mjs). The prior ledger and the launcher's records reach the binary as files
// read through process substitution — the binary refuses both from stdin at once — each one line of JSON the shell
// quotes whole.
import { shq } from './plugin-script.mjs'
import { stepCommands } from './cli-step-commands.mjs'

/** @typedef {import('./cli-triage-options.mjs').TriageOptions} TriageOptions */

/** The rounds after which the driver gives up, a backstop: the binary decides when the run is done. */
export const MAX_ROUNDS = 12

const commands = stepCommands('triage')
/** The submit of a triage run. */
export const triageSubmit = commands.submit
/** Where a triage run stands. */
export const triageStatus = commands.status

/** A flag with its value, quoted; '' when the value is ''. @param {string} name @param {string} value */
const flag = (name, value) => (value ? ` ${name} ${shq(value)}` : '')

/** A list argument as a file the binary reads: its JSON through process substitution; '' when none. @param {string} flagName @param {string} json */
const listed = (flagName, json) => (json ? ` ${flagName} <(printf '%s' ${shq(json)})` : '')

/**
 * The start: the run filed under `version` (`--record`) through the plugin root `recordRoot` when one is known, over
 * the repository `o.repo` names or the session's checkout.
 * @param {string} bin @param {TriageOptions} o @param {string} version @param {string} recordRoot @returns {string}
 */
export const triageStart = (bin, o, version, recordRoot) =>
  `${bin} triage start${flag('--repo', o.repo)}${flag('--report', o.report)}${flag('--pr', o.pr)}${flag('--base', o.base)}${flag('--pr-base', o.prBase)}${listed('--prior-ledger', o.priorLedger)}${listed('--prior-decisions', o.priorDecisions)} --record ${shq(version)}${flag('--record-root', recordRoot)}`
