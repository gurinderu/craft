// Which `git push` a Bash command makes, read from its text alone (realm @nick/craft, node #299): the push hook
// (lib/push-hook.mjs) asks this before it touches git. A shell is not parsed in full — quotes are honoured,
// `&&`, `||`, `;`, `|`, `&` and newlines split commands, a heredoc's body is no command, `( … )` is a subshell,
// `cd <dir>` moves the directory the next commands in the same shell run in, leading `VAR=value` words and an `rtk`
// proxy are passed over, and `git -C <dir>` / `-c <k=v>` are read.
import path from 'node:path'

/**
 * `dir` is where the push runs; `remote` and `refspecs` its positional words ('' and [] when absent); `skip` names
 * why the push moves no branch head the hook can judge (`tags`, `delete`, `prune`, `all`, `mirror`, `dry-run`), ''
 * when it does.
 * @typedef {{ dir: string, remote: string, refspecs: string[], skip: string }} Push
 */

// One token: an operator, a subshell paren, blanks, a quoted string, an escaped character, or plain characters.
const TOKEN = /(&&|\|\||[;|&\n])|([()])|([ \t]+)|'([^']*)'?|"([^"]*)"?|\\(.)|([^ \t'"\\;|&\n()]+)/g
// A heredoc's start (`<<EOF`, `<<-EOF`, `<<'EOF'`, `<<"EOF"`), not a here-string (`<<<`).
const HEREDOC = /(?<!<)<<(-?)[ \t]*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\2/g
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/
// git's global options that take the next word as their value.
const GIT_VALUE_OPTS = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path'])
// push's options that take the next word as their value.
const PUSH_VALUE_OPTS = new Set(['--repo', '-o', '--push-option', '--receive-pack', '--exec'])
/** @type {Record<string, string>} */
const SKIPS = { '--tags': 'tags', '--delete': 'delete', '-d': 'delete', '--all': 'all', '--branches': 'all', '--mirror': 'mirror', '--dry-run': 'dry-run', '-n': 'dry-run', '--prune': 'prune' }

/**
 * The text with every heredoc body taken out: from the line after `<<WORD` up to the line that is WORD (leading
 * tabs allowed after `<<-`); an unclosed body runs to the end.
 * @param {string} text @returns {string}
 */
export function withoutHeredocs(text) {
  /** @type {string[]} */
  const kept = []
  /** @type {Array<{ word: string, tabs: boolean }>} */
  const pending = []
  for (const line of text.split('\n')) {
    const open = pending[0]
    if (open) {
      if ((open.tabs ? line.replace(/^\t+/, '') : line) === open.word) pending.shift()
      continue
    }
    kept.push(line)
    for (const m of line.matchAll(HEREDOC)) pending.push({ word: m[3] ?? '', tabs: m[1] === '-' })
  }
  return kept.join('\n')
}

/**
 * The command as a list of simple commands, each a list of words, quotes and backslashes taken off; a subshell's
 * `(` and `)` are commands of their own (`['(']`, `[')']`).
 * @param {string} text @returns {string[][]}
 */
export function simpleCommands(text) {
  /** @type {string[][]} */
  const out = [[]]
  /** @type {string | null} */
  let word = null
  const end = () => { if (word !== null) out[out.length - 1]?.push(word); word = null }
  for (const m of withoutHeredocs(text).matchAll(TOKEN)) {
    if (m[1] || m[2] || m[3]) {
      end()
      if (m[2]) out.push([m[2]])
      if (!m[3]) out.push([])
      continue
    }
    word = (word ?? '') + (m.slice(4).find(v => v !== undefined) ?? '')
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
  let i = words.findIndex(w => !ASSIGNMENT.test(w))
  if (words[i] === 'rtk') i++
  if (i < 0 || path.basename(words[i] ?? '') !== 'git') return null
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
