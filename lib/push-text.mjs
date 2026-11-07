// The line craft's PreToolUse hook speaks on a push with no complete verdict (lib/push-hook.mjs; realm @nick/craft,
// node #299, point 4), and which checkout it names for the review.
import path from 'node:path'

/**
 * The line the hook adds, in the harness's words: Codex has no Workflow tool, so its session reviews the fix itself.
 * Claude Code hands a PreToolUse hook's context to the model only after the tool ran (observed, Claude Code
 * 2.1.296, `claude -p --include-hook-events`; realm @nick/craft, #289), so the line speaks of a push already made.
 * `dir` is the pushed checkout when it is not the session's own: the review must read that one, not the session's.
 * @param {string} sha @param {string} [who] @param {string} [dir] @returns {string}
 */
export function pushText(sha, who = 'claude-code', dir = '') {
  const short = sha.slice(0, 8)
  const engine = dir ? `craft:review with repo: ${JSON.stringify(dir)}` : 'craft:review'
  const how = who === 'codex' ? `review the pushed fix commits${dir ? ` in ${dir}` : ''} yourself (the diff since the last reviewed head)` : `review the pushed fix commits (a light re-review: ${engine} on any language, which routes the source files outside its profiles to a nested adversarial review)`
  return `craft: this push had no complete craft verdict on ${short}; ${how} before replying or requesting review.`
}

/**
 * The pushed checkout's top level when it is another one than the session's (`git -C <dir> push`, `cd <dir> &&`), else ''.
 * @param {string} dir @param {string} cwd @param {(args: string[], cwd: string) => string | null} git @returns {string}
 */
export function otherCheckout(dir, cwd, git) {
  if (path.resolve(dir) === path.resolve(cwd)) return ''
  const top = (/** @type {string} */ d) => git(['rev-parse', '--show-toplevel'], d) ?? path.resolve(d)
  const pushed = top(dir)
  return pushed === top(cwd) ? '' : pushed
}
