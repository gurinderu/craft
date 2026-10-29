// A Bash command as simple commands and their words — the one tokenizer of lib/ (realm @nick/craft, node #360): the
// push hook (lib/push-command.mjs; node #299) and the path touches of a transcript (lib/shell-touches.mjs) read
// through it. Not a shell parser: quotes, backslashes, operators, subshell and process-substitution parens,
// redirections, heredoc bodies and `#` comments are handled; expansions, functions and aliases are not.
import { heredocs } from './shell-heredocs.mjs'

// One token: a redirection (`2>&1`, `>&2`, `&>f`, `>f`, `2>>f`, `<f`, `<<EOF`), an operator, a subshell paren,
// blanks, a quoted string, an escaped character, or plain characters.
const TOKEN = /(\d*[<>]&(?:\d+|-)|&>>?|\d*(?:<<<|<<-?|>>|>\||<>|<|>))|(&&|\|\||\|&|[;|&\n])|([()])|([ \t]+)|'([^']*)'?|"([^"]*)"?|\\(.)|([^ \t'"\\;|&\n()<>]+)/g
// A redirection that names its target in itself (`2>&1`, `>&-`); every other one takes the next word.
const SELF_CONTAINED = /&(?:\d+|-)$/
// A shell, which runs a heredoc fed to it as its script.
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash'])
// Words that run the command after them: `rtk`, `env`, `command`; `timeout` takes a duration first.
const PREFIXES = new Set(['rtk', 'env', 'command'])
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/

/** @typedef {{ words: string[], piped: boolean, inputs: string[] }} Command */
/** @typedef {'word' | 'drop' | 'input'} Next */

/**
 * The index of the word that names the command run, past `VAR=value` words and the simple prefixes (PREFIXES,
 * `timeout <duration>`); options of a prefix are not read.
 * @param {string[]} words @returns {number}
 */
export function commandStart(words) {
  let i = 0
  for (let w = words[0] ?? ''; ; w = words[i] ?? '') {
    if (ASSIGNMENT.test(w) || PREFIXES.has(w)) i++
    else if (w === 'timeout') i += 2
    else return i
  }
}

/** What the word after a redirection is: a file `<` reads, a target dropped, or (`2>&1`) a plain word. @param {string} redirect @returns {Next} */
const redirectTarget = redirect => (SELF_CONTAINED.test(redirect) ? 'word' : /^\d*<$/.test(redirect) ? 'input' : 'drop')

/**
 * Whether the command after `op` is fed by a pipe; a newline with no command yet before it continues the line.
 * @param {string} op @param {boolean} piped @param {boolean} empty @returns {boolean}
 */
const pipedAfter = (op, piped, empty) => (op === '\n' && empty ? piped : op === '|' || op === '|&')

/**
 * Whether a command is a shell that runs its stdin as its script: no `-c` (then stdin is data), and no operand
 * naming a script file, unless `-s` says to read stdin anyway. A heredoc piped into a shell (`cat <<EOF | bash`)
 * is not followed: the body belongs to `cat`. @param {string[]} words
 */
function isShell(words) {
  const i = commandStart(words)
  const name = words[i] ?? ''
  if (!SHELLS.has(name.slice(name.lastIndexOf('/') + 1))) return false
  const args = words.slice(i + 1)
  const opts = args.filter(a => a.startsWith('-'))
  if (opts.some(o => /^-[A-Za-z]*c/.test(o))) return false
  return opts.some(o => /^-[A-Za-z]*s/.test(o)) || opts.length === args.length
}

/**
 * The command as a list of simple commands, each a list of words, quotes and backslashes taken off and
 * redirections with their targets dropped; a subshell's `(` and `)` are commands of their own (`['(']`, `[')']`).
 * @param {string} text @returns {string[][]}
 */
export function simpleCommands(text) {
  return commands(text).map(c => c.words)
}

/** @param {string[]} words @param {boolean} piped @returns {Command} */
const command = (words, piped) => ({ words, piped, inputs: [] })

/**
 * The simple commands as simpleCommands reads them, each with whether a pipe (`|`, `|&`) feeds it — a newline
 * right after the pipe continues it — and the files its `<` redirections read (`inputs`; a here-string, a
 * heredoc's word and a `<&` duplication are not files). Heredoc bodies are found by lib/shell-heredocs.mjs; a
 * body is data, except fed to a shell (`bash <<EOF`), which runs it: then its commands follow as a subshell. A
 * process substitution (`<(…)`, `>(…)`) is a subshell too, after which its command goes on (`cat a <(x) b`).
 * @param {string} source @returns {Command[]}
 */
export function commands(source) {
  const { text, bodies } = heredocs(source)
  let cur = command([], false)
  const out = [cur]
  /** @type {Array<Command | null>} the command a process substitution's `(` interrupted, null for a subshell's */
  const parens = []
  /** @type {Array<{ cmd: Command, body: string }>} */
  const fed = []
  let piped = false
  let procSub = false
  /** @type {string | null} */
  let word = null
  /** @type {Next} */
  let next = 'word'
  const push = (/** @type {Command} */ c) => { out.push(c); cur = c }
  const end = () => {
    if (word === null) return
    if (next === 'word') cur.words.push(word)
    else if (next === 'input') cur.inputs.push(word)
    next = 'word'
    word = null
  }
  const redirection = (/** @type {string} */ redirect, /** @type {number} */ at) => {
    // `<(`/`>(` is no redirection: the paren after it opens a process substitution.
    if (/^[<>]$/.test(redirect) && text[at + 1] === '(') { procSub = true; return }
    next = redirectTarget(redirect)
    const body = bodies.get(at + redirect.indexOf('<'))
    if (body !== undefined && /^\d*<<-?$/.test(redirect)) fed.push({ cmd: cur, body })
  }
  /** At a newline, a shell's heredoc bodies are read as its commands. */
  const runBodies = () => {
    for (const { cmd, body } of fed.splice(0)) {
      if (isShell(cmd.words)) out.push(command(['('], false), ...commands(body), command([')'], false))
    }
  }
  const paren = (/** @type {string} */ p) => {
    next = 'word'
    out.push(command([p], piped))
    const outer = p === ')' ? parens.pop() : undefined
    if (p === '(') parens.push(procSub ? cur : null)
    procSub = false
    // After a process substitution its command goes on; after anything else a new one starts.
    if (outer) cur = outer
    else push(command([], piped))
  }
  /** A redirection, an operator, a paren or blanks end the word; the first three also start what follows. */
  const separate = (/** @type {RegExpExecArray} */ m) => {
    const [, redirect, op, p] = m
    end()
    if (redirect) redirection(redirect, m.index)
    if (op === '\n') runBodies()
    if (op) { piped = pipedAfter(op, piped, cur.words.length === 0); push(command([], piped)) }
    if (p) paren(p)
  }
  const token = new RegExp(TOKEN.source, 'g')
  for (let m = token.exec(text); m; m = token.exec(text)) {
    if (m[1] || m[2] || m[3] || m[4]) separate(m)
    else word = (word ?? '') + (m.slice(5).find(v => v !== undefined) ?? '')
  }
  end()
  return out.filter(c => c.words.length > 0)
}
