// The `repo` argument, read the same way by every engine that takes it (src/review.js, src/triage-findings.js;
// realm @nick/craft, node #411): the absolute path of the checkout the run's agents work in when it is not the
// session's own, and the directive that points each agent there.
import { shq } from './run-logging.mjs'

// An absolute path, as the agents' `cd` reads it. `~` is not one here: the path reaches every `cd` single-quoted
// (shq), where the shell never expands it, so a `~/x` repo would be a directory named `~`.
const ABSOLUTE_REPO = /^(\/|[A-Za-z]:[\\/])/
/** Whether `s` holds a control character (C0 or DEL). @param {string} s */
const hasControl = s => [...s].some(c => c.charCodeAt(0) < 0x20 || c.charCodeAt(0) === 0x7f)

/**
 * The repo the run targets, '' when none was given (absent, '', null, false). A value the run cannot honour
 * throws before anything is dispatched, naming the argument: not a string, blank, holding a control character
 * (it would break the directive line the agents read), or not absolute (nothing in the sandbox can say what a
 * relative one is relative to).
 * @param {unknown} raw  the argument as it arrived @returns {string}
 */
export function readRepoArg(raw) {
  if (raw === undefined || raw === null || raw === '' || raw === false) return ''
  const shown = JSON.stringify(raw)
  /** @param {string} why */
  const refuse = why => { throw new Error(`repo=${shown} refused: ${why}. Nothing ran — pass repo=<absolute path of the repository's checkout>, or leave it out to work in the session's own checkout.`) }
  if (typeof raw !== 'string') return refuse('it is not a path')
  if (!raw.trim()) return refuse('it is blank')
  if (hasControl(raw)) return refuse('it holds a control character')
  if (!ABSOLUTE_REPO.test(raw)) return refuse('it is not an absolute path')
  return raw
}

/**
 * The line every agent of the run reads first when `repo` is given, '' otherwise. Prepended, not appended: it
 * has to win over the git commands the individual prompts spell out; shq() because the path is an argument to a
 * real `cd`.
 * @param {string} repo  readRepoArg's result @param {string} work  what the run is, as the agent reads it ('review', 'triage')
 * @returns {string}
 */
export function repoDirective(repo, work) {
  return repo
    ? `WORKING DIRECTORY: this ${work} targets the repository at ${shq(repo)} — NOT the directory you start in. Before ANY git / cargo / nix / file command, \`cd\` there (or pass \`git -C\`). Every file path in this ${work} is relative to that root. If that directory does not exist or is not a git repository, say so and stop rather than reviewing whatever repo you happen to be sitting in.\n\n`
    : ''
}
