// The `repo` argument, read the same way by every engine that takes it (src/review.js, src/triage-findings.js;
// realm @nick/craft, node #411): the absolute path of the checkout the run's agents work in when it is not the
// session's own, and the directive that points each agent there.
import { shq } from './run-logging.mjs'

// A `~` path is refused: it reaches every `cd` single-quoted (shq), where the shell never expands it, so it would
// name a directory called `~`. A relative path is passed as is — the agents and the logger all start in the
// session's directory, and resolve it there.
const TILDE = /^~(\/|$)/
/** Whether `s` holds a control character (C0 or DEL). @param {string} s */
const hasControl = s => [...s].some(c => c.charCodeAt(0) < 0x20 || c.charCodeAt(0) === 0x7f)
// The class a refused `repo` files in the run record's `notRun`, without the caller's value: `notRun` is ranked
// by exact string (lib/analyze-runs.mjs).
export const REPO_REFUSED_CLASS = '`repo` argument refused — not a path an agent can `cd` to, nothing ran'

/**
 * The repo the run targets ('' when none was given: absent, '', null, false), or, for a value no agent could
 * `cd` to, `refused`: the sentence naming the argument, the value and why — not a string, blank, holding a
 * control character (it would break the directive line the agents read), or a `~` path. The engine files it
 * as an INCOMPLETE record and returns it before any work agent (realm @nick/craft, nodes #159, #411).
 * @param {unknown} raw  the argument as it arrived @returns {{ repo: string, refused: string }}
 */
export function readRepoArg(raw) {
  if (raw === undefined || raw === null || raw === '' || raw === false) return { repo: '', refused: '' }
  /** @param {string} why */
  const refuse = why => ({ repo: '', refused: `repo=${JSON.stringify(raw)} refused: ${why}. Nothing ran — pass repo=<path of the repository's checkout> (absolute, or relative to the session's directory), or leave it out to work in the session's own checkout.` })
  if (typeof raw !== 'string') return refuse('it is not a path')
  if (!raw.trim()) return refuse('it is blank')
  if (hasControl(raw)) return refuse('it holds a control character')
  if (TILDE.test(raw)) return refuse('`~` is not expanded inside the quoted `cd` the agents run — spell the path out')
  return { repo: raw, refused: '' }
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
