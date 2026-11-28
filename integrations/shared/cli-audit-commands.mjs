// The start of the audit on the CLI's step protocol (realm @nick/craft, node #588), as shell text for the service
// agent's Bash: `craft audit start` with the engine's arguments; the submit and status every kind shares
// (integrations/shared/cli-step-commands.mjs).
import { shq } from './plugin-script.mjs'
import { flag } from './cli-step-commands.mjs'

/** @typedef {import('./cli-audit-options.mjs').AuditOptions} AuditOptions */

/** How the service agent runs the start, which lists the repository's tracked files and sizes them. */
export const auditStartTimeout = () => "in one Bash call with a timeout of 300000 ms (it lists and sizes the repository's tracked files)"

/**
 * The start: over the repository `o.repo` names (`--cwd`) or the session's checkout, each path given as one `--path`
 * (written `--path=…`, so a path that begins with a dash is not read as a flag), the budgets only when given, the
 * prompts naming the skills under the plugin root `root` (`--craft-root`; a fetched binary finds none above itself, and
 * its lens and verifier prompts would then name no skill file), the run filed under `version` (`--record`) through the
 * plugin root `recordRoot` when one is known.
 * @param {string} bin @param {AuditOptions} o @param {string} version @param {string} recordRoot @param {string} root
 * @returns {string}
 */
export const auditStart = (bin, o, version, recordRoot, root) =>
  `${bin} audit start${flag('--cwd', o.repo)}${o.paths.map(p => ` --path=${shq(p)}`).join('')}${flag('--batch-bytes', o.batchBytes)}${flag('--lens-agents', o.lensAgents)}${flag('--craft-root', root)} --record ${shq(version)}${flag('--record-root', recordRoot)}`
