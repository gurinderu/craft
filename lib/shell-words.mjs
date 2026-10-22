// A Bash command as simple commands and their words, for the push hook (lib/push-command.mjs; realm @nick/craft,
// node #299). Not a shell parser: quotes, backslashes, operators, subshell parens, redirections and heredoc bodies
// are handled; expansions, functions and aliases are not.

// One token: a redirection (`2>&1`, `>&2`, `&>f`, `>f`, `2>>f`, `<f`, `<<EOF`), an operator, a subshell paren,
// blanks, a quoted string, an escaped character, or plain characters.
const TOKEN = /(\d*[<>]&(?:\d+|-)|&>>?|\d*(?:<<<|<<-?|>>|>\||<>|<|>))|(&&|\|\||[;|&\n])|([()])|([ \t]+)|'([^']*)'?|"([^"]*)"?|\\(.)|([^ \t'"\\;|&\n()<>]+)/g
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

/**
 * The command as a list of simple commands, each a list of words, quotes and backslashes taken off and
 * redirections with their targets dropped; a subshell's `(` and `)` are commands of their own (`['(']`, `[')']`).
 * @param {string} text @returns {string[][]}
 */
export function simpleCommands(text) {
  /** @type {string[][]} */
  const out = [[]]
  /** @type {string | null} */
  let word = null
  // Whether the next word is a redirection's target rather than a word of the command.
  let target = false
  const end = () => {
    if (word === null) return
    if (!target) out[out.length - 1]?.push(word)
    target = false
    word = null
  }
  /** A redirection, an operator, a paren or blanks end the word; the first three also start what follows. */
  const separate = (/** @type {RegExpMatchArray} */ m) => {
    const [, redirect, op, paren] = m
    end()
    if (redirect) target = !SELF_CONTAINED.test(redirect)
    if (paren) out.push([paren])
    if (op || paren) out.push([])
  }
  for (const m of withoutHeredocs(text).matchAll(TOKEN)) {
    if (m[1] || m[2] || m[3] || m[4]) separate(m)
    else word = (word ?? '') + (m.slice(5).find(v => v !== undefined) ?? '')
  }
  end()
  return out.filter(c => c.length > 0)
}
