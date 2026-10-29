// A Bash command as simple commands and their words — the one tokenizer of lib/ (realm @nick/craft, node #360): the
// push hook (lib/push-command.mjs; node #299) and the path touches of a transcript (lib/shell-touches.mjs) read
// through it. Not a shell parser: quotes, backslashes, operators, subshell and process-substitution parens,
// redirections and heredoc bodies are handled; expansions, functions and aliases are not.

// One token: a redirection (`2>&1`, `>&2`, `&>f`, `>f`, `2>>f`, `<f`, `<<EOF`), an operator, a subshell paren,
// blanks, a quoted string, an escaped character, or plain characters.
const TOKEN = /(\d*[<>]&(?:\d+|-)|&>>?|\d*(?:<<<|<<-?|>>|>\||<>|<|>))|(&&|\|\||\|&|[;|&\n])|([()])|([ \t]+)|'([^']*)'?|"([^"]*)"?|\\(.)|([^ \t'"\\;|&\n()<>]+)/g
// A redirection that names its target in itself (`2>&1`, `>&-`); every other one takes the next word.
const SELF_CONTAINED = /&(?:\d+|-)$/
// A shell, which runs a heredoc fed to it as commands; the words that run the command after them.
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash'])
const WRAPPERS = new Set(['rtk', 'command', 'env'])

/** @typedef {{ words: string[], piped: boolean, inputs: string[] }} Command */
/** @typedef {'word' | 'drop' | 'input' | 'heredoc' | 'heredoc-'} Next */

/**
 * What the word after a redirection is: a file `<` reads, a heredoc's closing word (`heredoc-` after `<<-`), a
 * target dropped, or (`2>&1`) a plain word. @param {string} redirect @returns {Next}
 */
function redirectTarget(redirect) {
  if (SELF_CONTAINED.test(redirect)) return 'word'
  const heredoc = /<<(-?)$/.exec(redirect)
  if (heredoc) return heredoc[1] ? 'heredoc-' : 'heredoc'
  return /^\d*<$/.test(redirect) ? 'input' : 'drop'
}

/**
 * Whether the command after `op` is fed by a pipe; a newline with no command yet before it continues the line.
 * @param {string} op @param {boolean} piped @param {boolean} empty @returns {boolean}
 */
const pipedAfter = (op, piped, empty) => (op === '\n' && empty ? piped : op === '|' || op === '|&')

/** Whether a command runs a shell, past `VAR=value` words and the `rtk`/`command`/`env` prefixes. @param {string[]} words */
function isShell(words) {
  const first = words.find(w => !/^\w+=/.test(w) && !WRAPPERS.has(w)) ?? ''
  return SHELLS.has(first.slice(first.lastIndexOf('/') + 1))
}

/**
 * A heredoc's body from `from`: the lines up to the one that is `word` (leading tabs allowed after `<<-`), and
 * where the text after that line starts; an unclosed body runs to the end.
 * @param {string} text @param {number} from @param {{ word: string, tabs: boolean }} doc
 */
function heredocBody(text, from, { word, tabs }) {
  /** @type {string[]} */
  const lines = []
  for (let pos = from; pos < text.length;) {
    const nl = text.indexOf('\n', pos)
    const line = text.slice(pos, nl < 0 ? text.length : nl)
    pos = nl < 0 ? text.length : nl + 1
    if ((tabs ? line.replace(/^\t+/, '') : line) === word) return { body: lines.join('\n'), end: pos }
    lines.push(line)
  }
  return { body: lines.join('\n'), end: text.length }
}

/**
 * The command as a list of simple commands, each a list of words, quotes and backslashes taken off and
 * redirections with their targets dropped; a subshell's `(` and `)` are commands of their own (`['(']`, `[')']`).
 * @param {string} text @returns {string[][]}
 */
export function simpleCommands(text) {
  return commands(text).map(c => c.words)
}

/**
 * The simple commands as simpleCommands reads them, each with whether a pipe (`|`, `|&`) feeds it — a newline
 * right after the pipe continues it — and the files its `<` redirections read (`inputs`; a here-string, a
 * heredoc's word and a `<&` duplication are not files). A heredoc starts only at a `<<` outside quotes; its body
 * is data, except fed to a shell (`bash <<EOF`), which runs it: then its commands follow as a subshell. A
 * process substitution (`<(…)`, `>(…)`) is a subshell too.
 * @param {string} text @returns {Command[]}
 */
export function commands(text) {
  /** @type {Command[]} */
  const out = [{ words: [], piped: false, inputs: [] }]
  /** @type {Array<{ word: string, tabs: boolean, cmd: Command }>} */
  const docs = []
  let piped = false
  /** @type {string | null} */
  let word = null
  /** @type {Next} */
  let next = 'word'
  const token = new RegExp(TOKEN.source, 'g')
  const last = () => /** @type {Command} */ (out[out.length - 1])
  const end = () => {
    if (word === null) return
    if (next === 'word') last().words.push(word)
    else if (next === 'input') last().inputs.push(word)
    else if (next !== 'drop') docs.push({ word, tabs: next === 'heredoc-', cmd: last() })
    next = 'word'
    word = null
  }
  /** At a newline, the bodies of the heredocs its line opened are skipped; a shell's are read as its commands. */
  const skipBodies = () => {
    for (const doc of docs.splice(0)) {
      const { body, end: after } = heredocBody(text, token.lastIndex, doc)
      token.lastIndex = after
      if (isShell(doc.cmd.words)) out.push({ words: ['('], piped: false, inputs: [] }, ...commands(body), { words: [')'], piped: false, inputs: [] })
    }
  }
  /** A redirection, an operator, a paren or blanks end the word; the first three also start what follows. */
  const separate = (/** @type {RegExpExecArray} */ m) => {
    const [, redirect, op, paren] = m
    end()
    // `<(`/`>(` is no redirection: the paren after it opens a subshell, read like any other.
    if (redirect && !(/^[<>]$/.test(redirect) && text[m.index + 1] === '(')) next = redirectTarget(redirect)
    if (op === '\n') skipBodies()
    if (op) piped = pipedAfter(op, piped, last().words.length === 0)
    if (paren) { next = 'word'; out.push({ words: [paren], piped, inputs: [] }) }
    if (op || paren) out.push({ words: [], piped, inputs: [] })
  }
  for (let m = token.exec(text); m; m = token.exec(text)) {
    if (m[1] || m[2] || m[3] || m[4]) separate(m)
    else word = (word ?? '') + (m.slice(5).find(v => v !== undefined) ?? '')
  }
  end()
  return out.filter(c => c.words.length > 0)
}
