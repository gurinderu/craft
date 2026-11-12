// A `craft` command the harness's permission layer refused before it ran — auto mode's classifier, a deny rule —
// told apart from the binary's own refusals (realm @nick/craft, node #479), and the stop the review driver says for
// it: who refused, the command, how to go on with the run, and which permission to allow (realm @nick/craft, node #485).
import { isObject } from './cli-review-step-fields.mjs'

// The harness's stable words for a refused tool call; the generic shape needs words between "permission" and
// "denied", so an OS's "Permission denied" (EACCES), which the command ran into, is not taken for it.
const MARKERS = [/Permission for this action was denied/i, /The command was not run/i, /\bpermission\b[^\n.]{1,80}?\b(?:was|has been|is)\s+denied\b/i]

/**
 * The command the refusal quotes, '' when it quotes none: the rest of the `Denied command:` line, less a trailing
 * ` (timeout …)` — never cut at a `. ` inside it, which a quoted argument can hold. @param {string} text @returns {string}
 */
const deniedCommand = text =>
  /Denied command:[ \t]*(.*)$/m
    .exec(text)?.[1]
    ?.replace(/\s*\(timeout [^)]*\)[\s\S]*$/, '')
    .trim()
    .slice(0, 600) ?? ''

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

/**
 * Who refused `command` ('' when the refusal quoted none: `what` stands for it). @param {string} command
 * @param {string} what @returns {string}
 */
const refusedSentence = (command, what) =>
  `the harness's permission check refused the command, not craft — it was not run: ${command ? `\`${command}\`` : what}.`

/**
 * The Bash rule that allows the binary's review commands, its prefix spelled as the commands spell the binary (bare,
 * or quoted when its path needs it: lib/plugin-script.mjs, shellWord), since a rule matches the command's text.
 * @param {string} bin  the binary as the commands spell it @returns {string}
 */
const allowSentence = bin =>
  `To allow it, add a Bash permission rule for \`${bin} review:*\` with \`/permissions\` (\`Bash(${bin} review:*)\`). The binary's path changes with each plugin update, so the rule must be added again then.`

/**
 * A refused command with no run to go on with — the gate alone, a publication, the fetch of the binary: who refused it
 * and what to allow; with no binary yet (`bin` null, the fetch), to allow the command itself.
 * @param {string} command  '' when the refusal quoted none @param {string | null} bin  the binary as the commands spell it
 * @returns {string}
 */
export function harnessRefused(command, bin) {
  if (bin === null)
    return `${refusedSentence(command, 'the fetch of the craft binary')} To allow it, approve the command when the harness asks, or add a Bash permission rule for it with \`/permissions\`.`
  return `${refusedSentence(command, `a \`${bin} review\` command`)} ${allowSentence(bin)}`
}

/**
 * What a refused command stops a review with: who refused it, quoted; how to continue the run in `run` ('' when none
 * was started), whose steps so far are kept; and the Bash rule that allows the binary's review commands.
 * @param {string} command  '' when the refusal quoted none @param {string} bin  the binary as the commands spell it
 * @param {string} run @returns {string}
 */
export function harnessStop(command, bin, run) {
  const next = run
    ? `The steps done so far are kept in ${run}: continue the review with the Workflow \`craft:review run=${run}\` once the command is allowed.`
    : 'No run was started: run the review again once the command is allowed.'
  return `${refusedSentence(command, `a \`${bin} review\` command`)} ${next} ${allowSentence(bin)}`
}
