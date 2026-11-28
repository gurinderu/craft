// The start of the triage on the CLI's step protocol (realm @nick/craft, node #616), as shell text for the service
// agent's Bash: `craft triage start` with the engine's arguments; the submit and status every kind shares
// (integrations/shared/cli-step-commands.mjs). The prior ledger and the launcher's records reach the binary as files
// read through process substitution — the binary refuses both from stdin at once — each one line of JSON the shell
// quotes whole.
import { shq } from './plugin-script.mjs'
import { flag } from './cli-step-commands.mjs'

/** @typedef {import('./cli-triage-options.mjs').TriageOptions} TriageOptions */

// A start reads the report and asks gh for the PR's threads; past a Bash call's default two minutes, so five.
const START_TIMEOUT = "in one Bash call with a timeout of 300000 ms (it may read the PR's review threads through gh)"

/** How the service agent runs the start: the JSON inside each `printf` copied as it stands. @param {TriageOptions} o */
export const triageStartTimeout = o =>
  o.priorLedger || o.priorDecisions ? `${START_TIMEOUT}, the JSON inside each \`printf\` copied character for character` : START_TIMEOUT

/** A list argument as a file the binary reads: its JSON through process substitution; '' when none. @param {string} flagName @param {string} json */
const listed = (flagName, json) => (json ? ` ${flagName} <(printf '%s' ${shq(json)})` : '')

/**
 * The start: the run filed under `version` (`--record`) through the plugin root `recordRoot` when one is known, over
 * the repository `o.repo` names or the session's checkout.
 * @param {string} bin @param {TriageOptions} o @param {string} version @param {string} recordRoot @returns {string}
 */
export const triageStart = (bin, o, version, recordRoot) =>
  `${bin} triage start${flag('--repo', o.repo)}${flag('--report', o.report)}${flag('--pr', o.pr)}${flag('--base', o.base)}${flag('--pr-base', o.prBase)}${listed('--prior-ledger', o.priorLedger)}${listed('--prior-decisions', o.priorDecisions)} --record ${shq(version)}${flag('--record-root', recordRoot)}`
