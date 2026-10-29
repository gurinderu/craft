// The heredoc bodies of a Bash command, found where the shell finds them, for lib/shell-words.mjs (realm
// @nick/craft, node #360). A `<<` opens a heredoc only where the shell reads commands: outside quotes, or inside a
// `$(…)` — also one within double quotes, the `git commit -m "$(cat <<'EOF' … EOF)"` idiom, whose body may hold
// any quote. Not inside quotes as text (`echo "x <<EOF"`), not in arithmetic (`$((1<<2))`), not as a here-string
// (`<<<`), and only before an identifier (`<<EOF`, `<<-EOF`, `<<'EOF'`, `<<"EOF"`, `<<\EOF`). A body starts after
// the newline that ends its line, outside quotes, and runs to the line that is its word (leading tabs allowed
// after `<<-`); an unclosed one runs to the end. Where commands are read, a `#` that starts a word starts a comment
// to the end of its line, taken out of the text, so a quote or `<<` in it opens nothing (realm @nick/craft, node
// #390): at the line's start or after a blank or `;&|()`, not after an escape or a substitution's closing `)`
// (`$(x)#`, `<(x)#`).

const START = /<<(-?)[ \t]*(?:'([A-Za-z_]\w*)'|"([A-Za-z_]\w*)"|\\?([A-Za-z_]\w*))/y
// What ends a word, so a `#` after it starts one.
const WORD_END = /[ \t\n;&|()]/

/**
 * @typedef {{ src: string, i: number, out: string, stack: string[], open: Array<{ word: string, tabs: boolean, at: number }>,
 *   bodies: Map<number, string>, glued: number }} Scan
 */

/** Copies `n` characters, after pushing `ctx` when given. @param {Scan} s @param {number} n @param {string} [ctx] */
function take(s, n, ctx) {
  if (ctx) s.stack.push(ctx)
  s.out += s.src.slice(s.i, s.i + n)
  s.i += n
}

/** What every context but single quotes shares: an escape, and a command or arithmetic substitution opening. @param {Scan} s */
function common(s) {
  if (s.src[s.i] === '\\') glue(s, 2)
  else if (s.src.startsWith('$((', s.i)) take(s, 3, 'arith')
  else if (s.src.startsWith('$(', s.i)) take(s, 2, 'cmd')
  else return false
  return true
}

/** Copies `n` characters that the word goes on after (`glued`: an escape, a substitution's end). @param {Scan} s @param {number} n */
function glue(s, n) {
  take(s, n)
  s.glued = s.i
}

/** A `)` closes the innermost substitution or nested paren; a top-level subshell's changes nothing here. @param {Scan} s */
function closing(s) {
  const ctx = s.stack.length > 1 ? s.stack.pop() : 'top'
  // A substitution is part of a word (`$(x)#y`, `<(x)#y`); a subshell is not.
  if (ctx === 'cmd' || ctx === 'psub') glue(s, 1)
  else take(s, 1)
}

/** Where the line the scan stands on ends: its newline, or the end of the text. @param {Scan} s */
function lineEnd(s) {
  const nl = s.src.indexOf('\n', s.i)
  return nl < 0 ? s.src.length : nl
}

/** Whether a `#` here starts a word, so a comment. @param {Scan} s */
function comment(s) {
  return s.src[s.i] === '#' && (s.i === 0 || (s.glued !== s.i && WORD_END.test(s.src[s.i - 1] ?? '')))
}

/** A single-quoted string, copied whole. @param {Scan} s */
function singleQuoted(s) {
  const j = s.src.indexOf("'", s.i + 1)
  take(s, (j < 0 ? s.src.length : j + 1) - s.i)
}

/** Where commands are read: quotes, parens, a here-string, a heredoc's start, the newline that starts its body. @param {Scan} s */
function commandStep(s) {
  const c = s.src[s.i]
  if (comment(s)) s.i = lineEnd(s)
  else if (c === "'") singleQuoted(s)
  else if (c === '"') take(s, 1, 'dq')
  else if (s.src.startsWith('((', s.i)) take(s, 2, 'arith')
  else if (c === '(') opener(s)
  else if (c === ')') closing(s)
  else if (s.src.startsWith('<<<', s.i)) take(s, 3)
  else if (s.src.startsWith('<<', s.i)) opening(s)
  else {
    take(s, 1)
    if (c === '\n') skipBodies(s)
  }
}

/** A `(` opens a process substitution after `<` or `>`, a subshell elsewhere. @param {Scan} s */
function opener(s) {
  take(s, 1, /[<>]/.test(s.src[s.i - 1] ?? '') ? 'psub' : 'paren')
}

/** A `<<` before an identifier opens a heredoc; any other is an operator. @param {Scan} s */
function opening(s) {
  START.lastIndex = s.i
  const m = START.exec(s.src)
  if (m) s.open.push({ word: m[2] ?? m[3] ?? m[4] ?? '', tabs: m[1] === '-', at: s.out.length })
  take(s, m ? m[0].length : 2)
}

/** Inside double quotes: only the closing quote. @param {Scan} s */
function quotedStep(s) {
  if (s.src[s.i] === '"') s.stack.pop()
  take(s, 1)
}

/** Inside arithmetic: parens nest, and `))` closes it. @param {Scan} s */
function arithStep(s) {
  const ctx = s.stack[s.stack.length - 1]
  if (s.src[s.i] === '(') take(s, 1, 'apar')
  else if (ctx === 'apar' && s.src[s.i] === ')') closing(s)
  else if (ctx === 'arith' && s.src.startsWith('))', s.i)) {
    s.stack.pop()
    glue(s, 2)
  } else take(s, 1)
}

/** One body, from where the scan stands to its closing line, which is consumed too. @param {Scan} s @param {{ word: string, tabs: boolean }} doc */
function body(s, { word, tabs }) {
  /** @type {string[]} */
  const lines = []
  while (s.i < s.src.length) {
    const end = lineEnd(s)
    const line = s.src.slice(s.i, end)
    s.i = Math.min(end + 1, s.src.length)
    if ((tabs ? line.replace(/^\t+/, '') : line) === word) break
    lines.push(line)
  }
  return lines.join('\n')
}

/** The bodies the line just ended opened, taken out of the text and kept by where their `<<` stands. @param {Scan} s */
function skipBodies(s) {
  for (const doc of s.open.splice(0)) s.bodies.set(doc.at, body(s, doc))
}

/**
 * The command with every heredoc body and comment taken out, and each body by the offset of its `<<` in that text.
 * @param {string} src @returns {{ text: string, bodies: Map<number, string> }}
 */
export function heredocs(src) {
  /** @type {Scan} */
  const s = { src, i: 0, out: '', stack: ['top'], open: [], bodies: new Map(), glued: -1 }
  while (s.i < src.length) {
    const ctx = s.stack[s.stack.length - 1]
    if (common(s)) continue
    if (ctx === 'dq') quotedStep(s)
    else if (ctx === 'arith' || ctx === 'apar') arithStep(s)
    else commandStep(s)
  }
  return { text: s.out, bodies: s.bodies }
}
