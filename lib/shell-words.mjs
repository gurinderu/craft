// A Bash command as simple commands and their words — the one tokenizer of lib/ (realm @nick/craft, node #360): the
// push hook (lib/push-command.mjs; node #299) and the path touches of a transcript (lib/shell-touches.mjs) read
// through it. Not a shell parser: quotes, backslashes, operators, subshell parens, redirections and heredoc bodies
// are handled; expansions, functions and aliases are not.

// One token: a redirection (`2>&1`, `>&2`, `&>f`, `>f`, `2>>f`, `<f`, `<<EOF`), an operator, a subshell paren,
// blanks, a quoted string, an escaped character, or plain characters.
const TOKEN = /(\d*[<>]&(?:\d+|-)|&>>?|\d*(?:<<<|<<-?|>>|>\||<>|<|>))|(&&|\|\||\|&|[;|&\n])|([()])|([ \t]+)|'([^']*)'?|"([^"]*)"?|\\(.)|([^ \t'"\\;|&\n()<>]+)/g
// A redirection that names its target in itself (`2>&1`, `>&-`); every other one takes the next word.
const SELF_CONTAINED = /&(?:\d+|-)$/
// A heredoc's start (`<<EOF`, `<<-EOF`, `<<'EOF'`, `<<"EOF"`), not a here-string (`<<<`).
const HEREDOC = /(?<!<)<<(-?)[ \t]*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\2/g

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

/** @typedef {{ words: string[], piped: boolean, inputs: string[] }} Command */

/** What the word after a redirection is: a file `<` reads, a target dropped, or (`2>&1`) a plain word. @param {string} redirect */
const redirectTarget = redirect => (SELF_CONTAINED.test(redirect) ? 'word' : /^\d*<$/.test(redirect) ? 'input' : 'drop')

/**
 * Whether the command after `op` is fed by a pipe; a newline with no command yet before it continues the line.
 * @param {string} op @param {boolean} piped @param {boolean} empty @returns {boolean}
 */
const pipedAfter = (op, piped, empty) => (op === '\n' && empty ? piped : op === '|' || op === '|&')

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
 * heredoc's word and a `<&` duplication are not files).
 * @param {string} text @returns {Command[]}
 */
export function commands(text) {
  /** @type {Command[]} */
  const out = [{ words: [], piped: false, inputs: [] }]
  let piped = false
  /** @type {string | null} */
  let word = null
  // What the next word is: a word of the command, a redirection's target dropped, or a file `<` reads.
  /** @type {'word' | 'drop' | 'input'} */
  let next = 'word'
  const last = () => /** @type {Command} */ (out[out.length - 1])
  const end = () => {
    if (word === null) return
    if (next === 'word') last().words.push(word)
    else if (next === 'input') last().inputs.push(word)
    next = 'word'
    word = null
  }
  /** A redirection, an operator, a paren or blanks end the word; the first three also start what follows. */
  const separate = (/** @type {RegExpMatchArray} */ m) => {
    const [, redirect, op, paren] = m
    end()
    if (redirect) next = redirectTarget(redirect)
    if (op) piped = pipedAfter(op, piped, last().words.length === 0)
    if (paren) out.push({ words: [paren], piped, inputs: [] })
    if (op || paren) out.push({ words: [], piped, inputs: [] })
  }
  for (const m of withoutHeredocs(text).matchAll(TOKEN)) {
    if (m[1] || m[2] || m[3] || m[4]) separate(m)
    else word = (word ?? '') + (m.slice(5).find(v => v !== undefined) ?? '')
  }
  end()
  return out.filter(c => c.words.length > 0)
}
