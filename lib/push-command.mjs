// Which `git push` a Bash command makes, read from its text alone (realm @nick/craft, node #299): the push hook
// (lib/push-hook.mjs) asks this before it touches git. A shell is not parsed in full — quotes are honoured,
// `&&`, `||`, `;`, `|`, `&` and newlines split commands, `cd <dir>` moves the directory the next commands run
// in, leading `VAR=value` words and an `rtk` proxy are passed over, and `git -C <dir>` / `-c <k=v>` are read.
import path from 'node:path'

/**
 * `dir` is where the push runs; `remote` and `refspecs` its positional words ('' and [] when absent); `skip` names
 * why the push moves no branch head the hook can judge (`tags`, `delete`, `all`, `mirror`, `dry-run`), '' when it does.
 * @typedef {{ dir: string, remote: string, refspecs: string[], skip: string }} Push
 */

// One token: an operator, blanks, a quoted string, an escaped character, or a run of plain characters.
const TOKEN = /(&&|\|\||[;|&\n])|([ \t]+)|'([^']*)'?|"([^"]*)"?|\\(.)|([^ \t'"\\;|&\n]+)/g
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/
// git's global options that take the next word as their value.
const GIT_VALUE_OPTS = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path'])
// push's options that take the next word as their value.
const PUSH_VALUE_OPTS = new Set(['--repo', '-o', '--push-option', '--receive-pack', '--exec'])
/** @type {Record<string, string>} */
const SKIPS = { '--tags': 'tags', '--delete': 'delete', '-d': 'delete', '--all': 'all', '--branches': 'all', '--mirror': 'mirror', '--dry-run': 'dry-run', '-n': 'dry-run', '--prune': 'delete' }

/**
 * The command as a list of simple commands, each a list of words; quotes and backslashes are taken off.
 * @param {string} text @returns {string[][]}
 */
export function simpleCommands(text) {
  /** @type {string[][]} */
  const out = [[]]
  /** @type {string | null} */
  let word = null
  const end = () => { if (word !== null) out[out.length - 1]?.push(word); word = null }
  for (const m of text.matchAll(TOKEN)) {
    if (m[1] || m[2]) {
      end()
      if (m[1]) out.push([])
      continue
    }
    word = (word ?? '') + (m.slice(3).find(v => v !== undefined) ?? '')
  }
  end()
  return out.filter(c => c.length > 0)
}

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
 * push's positional words and the first option that makes it move no branch head.
 * @param {string[]} args @returns {{ positional: string[], skip: string }}
 */
function pushArgs(args) {
  /** @type {string[]} */
  const positional = []
  let skip = ''
  for (let j = 0; j < args.length; j++) {
    const w = args[j] ?? ''
    if (PUSH_VALUE_OPTS.has(w)) j++
    else if (w.startsWith('-')) skip ||= SKIPS[w.split('=')[0] ?? ''] ?? ''
    else positional.push(w)
  }
  return { positional, skip }
}

/**
 * The push one simple command makes, run in `dir`; null when it is not a `git push`.
 * @param {string[]} words @param {string} dir @returns {Push | null}
 */
function pushOf(words, dir) {
  let i = words.findIndex(w => !ASSIGNMENT.test(w))
  if (words[i] === 'rtk') i++
  if (i < 0 || path.basename(words[i] ?? '') !== 'git') return null
  const { at, where } = gitOptions(words, i + 1, dir)
  if (words[at] !== 'push') return null
  const { positional, skip } = pushArgs(words.slice(at + 1))
  return { dir: where, remote: positional[0] ?? '', refspecs: positional.slice(1), skip }
}

/**
 * Every `git push` in a Bash command, in order, each with the directory it runs in (`cwd` moved by any `cd`
 * before it).
 * @param {string} command @param {string} cwd @returns {Push[]}
 */
export function pushesIn(command, cwd) {
  /** @type {Push[]} */
  const pushes = []
  let dir = cwd
  for (const words of simpleCommands(command)) {
    if (words[0] === 'cd') {
      const to = words[1]
      if (to && to !== '-' && !to.startsWith('~')) dir = path.resolve(dir, to)
      continue
    }
    const push = pushOf(words, dir)
    if (push) pushes.push(push)
  }
  return pushes
}
