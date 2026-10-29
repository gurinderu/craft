// The heredoc bodies of a Bash command, found where the shell finds them, for lib/shell-words.mjs (realm
// @nick/craft, node #360). A `<<` opens a heredoc only where the shell reads commands: outside quotes, or inside a
// `$(…)` — also one within double quotes, the `git commit -m "$(cat <<'EOF' … EOF)"` idiom, whose body may hold
// any quote. Not inside quotes as text (`echo "x <<EOF"`), not in arithmetic (`$((1<<2))`), not as a here-string
// (`<<<`), and only before an identifier (`<<EOF`, `<<-EOF`, `<<'EOF'`, `<<"EOF"`, `<<\EOF`). A body starts after
// the newline that ends its line, outside quotes, and runs to the line that is its word (leading tabs allowed
// after `<<-`); an unclosed one runs to the end.

const START = /<<(-?)[ \t]*(?:'([A-Za-z_]\w*)'|"([A-Za-z_]\w*)"|\\?([A-Za-z_]\w*))/y

/**
 * @typedef {{ src: string, i: number, out: string, stack: string[], open: Array<{ word: string, tabs: boolean, at: number }>,
 *   bodies: Map<number, string> }} Scan
 */

/** Copies `n` characters, after pushing `ctx` when given. @param {Scan} s @param {number} n @param {string} [ctx] */
function take(s, n, ctx) {
  if (ctx) s.stack.push(ctx)
  s.out += s.src.slice(s.i, s.i + n)
  s.i += n
}

/** What every context but single quotes shares: an escape, and a command or arithmetic substitution opening. @param {Scan} s */
function common(s) {
  if (s.src[s.i] === '\\') take(s, 2)
  else if (s.src.startsWith('$((', s.i)) take(s, 3, 'arith')
  else if (s.src.startsWith('$(', s.i)) take(s, 2, 'cmd')
  else return false
  return true
}

/** A `)` closes the innermost substitution or nested paren; a top-level subshell's changes nothing here. @param {Scan} s */
function closing(s) {
  if (s.stack.length > 1) s.stack.pop()
  take(s, 1)
}

/** A single-quoted string, copied whole. @param {Scan} s */
function singleQuoted(s) {
  const j = s.src.indexOf("'", s.i + 1)
  take(s, (j < 0 ? s.src.length : j + 1) - s.i)
}

/** Where commands are read: quotes, parens, a here-string, a heredoc's start, the newline that starts its body. @param {Scan} s */
function commandStep(s) {
  const c = s.src[s.i]
  if (c === "'") singleQuoted(s)
  else if (c === '"') take(s, 1, 'dq')
  else if (s.src.startsWith('((', s.i)) take(s, 2, 'arith')
  else if (c === '(') take(s, 1, 'paren')
  else if (c === ')') closing(s)
  else if (s.src.startsWith('<<<', s.i)) take(s, 3)
  else if (s.src.startsWith('<<', s.i)) opening(s)
  else {
    take(s, 1)
    if (c === '\n') skipBodies(s)
  }
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
    take(s, 2)
  } else take(s, 1)
}

/** One body, from where the scan stands to its closing line, which is consumed too. @param {Scan} s @param {{ word: string, tabs: boolean }} doc */
function body(s, { word, tabs }) {
  /** @type {string[]} */
  const lines = []
  while (s.i < s.src.length) {
    const nl = s.src.indexOf('\n', s.i)
    const line = s.src.slice(s.i, nl < 0 ? s.src.length : nl)
    s.i = nl < 0 ? s.src.length : nl + 1
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
 * The command with every heredoc body taken out, and each body by the offset of its `<<` in that text.
 * @param {string} src @returns {{ text: string, bodies: Map<number, string> }}
 */
export function heredocs(src) {
  /** @type {Scan} */
  const s = { src, i: 0, out: '', stack: ['top'], open: [], bodies: new Map() }
  while (s.i < src.length) {
    const ctx = s.stack[s.stack.length - 1]
    if (common(s)) continue
    if (ctx === 'dq') quotedStep(s)
    else if (ctx === 'arith' || ctx === 'apar') arithStep(s)
    else commandStep(s)
  }
  return { text: s.out, bodies: s.bodies }
}
