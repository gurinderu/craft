// A `craft` command the harness's permission layer refused before it ran — auto mode's classifier, a deny rule —
// told apart from the binary's own refusals, and the stop the review driver says for it: who refused, the command,
// how to go on with the run, and which permission to allow (realm @nick/craft, node #479).
import { isObject } from './cli-review-step-fields.mjs'

// The harness's stable words for a refused tool call; the generic shape needs words between "permission" and
// "denied", so an OS's "Permission denied" (EACCES), which the command ran into, is not taken for it.
const MARKERS = [/Permission for this action was denied/i, /The command was not run/i, /\bpermission\b[^\n.]{1,80}?\b(?:was|has been|is)\s+denied\b/i]

/** The command the refusal quotes, '' when it quotes none. @param {string} text @returns {string} */
const deniedCommand = text => /Denied command:\s*(.+?)(?:\s*\(timeout [^)]*\))?(?:\.\s|\.?$)/m.exec(text)?.[1]?.trim().slice(0, 600) ?? ''

/**
 * The refused command when a service step's answer is the harness refusing it, else null. The binary's own refusal
 * (`craft: …` on stderr, main.rs) never is, whatever it says.
 * @param {unknown} got @returns {{ command: string } | null}
 */
export function harnessRefusal(got) {
  if (!isObject(got) || got['exitCode'] === 0) return null
  const stderr = typeof got['stderr'] === 'string' ? got['stderr'] : ''
  if (/^craft: /.test(stderr.trim())) return null
  const text = `${stderr}\n${typeof got['stdout'] === 'string' ? got['stdout'] : ''}`
  return MARKERS.some(m => m.test(text)) ? { command: deniedCommand(text) } : null
}

/** A shell-quoted path as it stands on disk. @param {string} quoted @returns {string} */
const unquoted = quoted => (/^'.*'$/s.test(quoted) ? quoted.slice(1, -1).replace(/'\\''/g, "'") : quoted)

/**
 * What a refused command stops the run with: the harness refused it, not craft, quoted; how to continue the run in
 * `run` ('' when none was started), whose steps so far are kept; and the Bash rule that allows the binary's review
 * commands. @param {string} command  '' when the refusal quoted none @param {string} bin  the binary, shell-quoted
 * @param {string} run @returns {string}
 */
export function harnessStop(command, bin, run) {
  const path = unquoted(bin)
  const what = command ? `\`${command}\`` : `a \`${path} review\` command`
  const next = run
    ? `The steps done so far are kept in ${run}: continue the review with the Workflow \`craft:review run=${run}\` once the command is allowed.`
    : 'No run was started: run the review again once the command is allowed.'
  return `the harness's permission check refused the command, not craft — it was not run: ${what}. ${next} To allow it, add a Bash permission rule for \`${path} review:*\` with \`/permissions\` (\`Bash(${path} review:*)\`).`
}
