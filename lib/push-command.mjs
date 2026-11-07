// Which `git push` a Bash command makes, read from its text alone (realm @nick/craft, node #299): the push hook
// (lib/push-hook.mjs) asks this before it touches git. The words come from lib/shell-words.mjs — quotes are honoured,
// `&&`, `||`, `;`, `|`, `&` and newlines split commands, a `#` comment runs to its line's end, a heredoc's body is
// no command unless a shell is fed it, `( … )` is a subshell, redirections (`2>&1`, `>file`) are dropped with their
// targets, `cd <dir>` moves the directory the next commands in the same shell run in, leading `VAR=value` words and
// the `rtk`, `env`, `command` and `timeout <n>` prefixes are passed over, and `git -C <dir>` / `-c <k=v>` are read.
import path from 'node:path'
import { simpleCommands, commandStart } from './shell-words.mjs'

/**
 * `dir` is where the push runs; `remote` and `refspecs` its positional words ('' and [] when absent); `skip` names
 * why the push moves no branch head the hook can judge (`tags`, `delete`, `prune`, `all`, `mirror`, `dry-run`), ''
 * when it does.
 * @typedef {{ dir: string, remote: string, refspecs: string[], skip: string }} Push
 */

// git's global options that take the next word as their value.
const GIT_VALUE_OPTS = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path'])
// push's options that take the next word as their value.
const PUSH_VALUE_OPTS = new Set(['--repo', '-o', '--push-option', '--receive-pack', '--exec'])
/** @type {Record<string, string>} */
const SKIPS = { '--tags': 'tags', '--delete': 'delete', '-d': 'delete', '--all': 'all', '--branches': 'all', '--mirror': 'mirror', '--dry-run': 'dry-run', '-n': 'dry-run', '--prune': 'prune' }

/**
 * Where git runs and the index of its subcommand, past git's global options (from `i`, the word after `git`).
 * @param {string[]} words @param {number} i @param {string} dir @returns {{ at: number, where: string }}
 */
function gitOptions(words, i, dir) {
  let at = i
  let where = dir
  for (let opt = words[at] ?? ''; opt.startsWith('-'); opt = words[at] ?? '') {
    if (opt === '-C') where = path.resolve(where, words[at + 1] ?? '')
    at += GIT_VALUE_OPTS.has(opt) ? 2 : 1
  }
  return { at, where }
}

/**
 * push's positional words and why it moves no branch head: `--prune` only when no refspec names what to push.
 * @param {string[]} args @returns {{ positional: string[], skip: string }}
 */
function pushArgs(args) {
  /** @type {string[]} */
  const positional = []
  /** @type {string[]} */
  const skips = []
  for (let j = 0; j < args.length; j++) {
    const w = args[j] ?? ''
    if (PUSH_VALUE_OPTS.has(w)) j++
    else if (w.startsWith('-')) skips.push(SKIPS[w.split('=')[0] ?? ''] ?? '')
    else positional.push(w)
  }
  const named = positional.length > 1
  return { positional, skip: skips.find(s => s !== '' && !(s === 'prune' && named)) ?? '' }
}

/**
 * The push one simple command makes, run in `dir`; null when it is not a `git push`.
 * @param {string[]} words @param {string} dir @returns {Push | null}
 */
function pushOf(words, dir) {
  const i = commandStart(words)
  if (path.basename(words[i] ?? '') !== 'git') return null
  const { at, where } = gitOptions(words, i + 1, dir)
  if (words[at] !== 'push') return null
  const { positional, skip } = pushArgs(words.slice(at + 1))
  return { dir: where, remote: positional[0] ?? '', refspecs: positional.slice(1), skip }
}

/** Where `cd <to>` leaves the shell; `~`, `-` and a bare `cd` are not followed. @param {string} dir @param {string} to */
const cdTo = (dir, to) => (to && to !== '-' && !to.startsWith('~') ? path.resolve(dir, to) : dir)

/**
 * Every `git push` in a Bash command, in order, each with the directory it runs in (`cwd` moved by any `cd`
 * before it in the same shell; a subshell's `cd` ends with it).
 * @param {string} command @param {string} cwd @returns {Push[]}
 */
export function pushesIn(command, cwd) {
  /** @type {Push[]} */
  const pushes = []
  /** @type {string[]} */
  const outer = []
  let dir = cwd
  for (const words of simpleCommands(command)) {
    const [first = '', to = ''] = words
    if (first === '(') outer.push(dir)
    else if (first === ')') dir = outer.pop() ?? dir
    else if (first === 'cd') dir = cdTo(dir, to)
    else {
      const push = pushOf(words, dir)
      if (push) pushes.push(push)
    }
  }
  return pushes
}
