// lib/shell-words.mjs's commands(): which command a pipe feeds and which files `<` reads — what the path touches
// of a transcript need beyond simpleCommands (realm @nick/craft, node #360).
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { commands, simpleCommands } from './shell-words.mjs'

/** @param {string} text */
const piped = text => commands(text).map(c => [c.piped, c.words.join(' ')])

test('only | and |& feed the next command; && || ; & and a newline do not', () => {
  assert.deepEqual(piped('a | b |& c && d || e; f & g\nh'), [[false, 'a'], [true, 'b'], [true, 'c'], [false, 'd'], [false, 'e'], [false, 'f'], [false, 'g'], [false, 'h']])
})

test('a newline right after a pipe continues it; a subshell takes the pipe in', () => {
  assert.deepEqual(piped('a |\n  b'), [[false, 'a'], [true, 'b']])
  assert.deepEqual(piped('a | (b; c) | d'), [[false, 'a'], [true, '('], [true, 'b'], [false, 'c'], [false, ')'], [true, 'd']])
})

test('a < target is an input of its command; other redirection targets and heredoc words are not', () => {
  assert.deepEqual(commands('wc -l < a.txt 0<b.txt > c.txt <<< here 2>&1').map(c => [c.words, c.inputs]), [[['wc', '-l'], ['a.txt', 'b.txt']]])
  assert.deepEqual(commands('cat <<EOF\nx < y\nEOF').map(c => [c.words, c.inputs]), [[['cat'], []]])
})

test('simpleCommands is commands without the pipe and the inputs', () => {
  const text = `a "x|y" | b < f && c\\ d`
  assert.deepEqual(simpleCommands(text), commands(text).map(c => c.words))
  assert.deepEqual(simpleCommands(text), [['a', 'x|y'], ['b'], ['c d']])
})

test('a heredoc opens only outside quotes; a shell fed one runs its body as a subshell', () => {
  assert.deepEqual(simpleCommands('echo "a<<EOF" \'b<<EOF\'\nls'), [['echo', 'a<<EOF', 'b<<EOF'], ['ls']])
  assert.deepEqual(simpleCommands('bash <<EOF\ncd x; ls\nEOF\npwd'), [['bash'], ['('], ['cd', 'x'], ['ls'], [')'], ['pwd']])
  assert.deepEqual(simpleCommands('cat <<A <<-B\na\nA\n\tb\n\tB\nls'), [['cat'], ['ls']], 'two heredocs on a line, closed in order')
})

test('a process substitution opens a subshell and is no redirection target', () => {
  assert.deepEqual(commands('diff <(git show a) >(cat)').map(c => [c.words, c.inputs]),
    [[['diff'], []], [['('], []], [['git', 'show', 'a'], []], [[')'], []], [['('], []], [['cat'], []], [[')'], []]])
})
