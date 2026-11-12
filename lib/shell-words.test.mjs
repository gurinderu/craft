// lib/shell-words.mjs's commands(): the words of each simple command, which command a pipe feeds and which files `<`
// reads — what the path touches of a transcript need (realm @nick/craft, node #360).
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { commands } from './shell-words.mjs'

/** @param {string} text */
const simpleCommands = text => commands(text).map(c => c.words)

/** @param {string} text */
const piped = text => commands(text).map(c => [c.piped, c.words.join(' ')])

test('only | and |& feed the next command; && || ; & and a newline do not', () => {
  assert.deepEqual(piped('a | b |& c && d || e; f & g\nh'), [
    [false, 'a'],
    [true, 'b'],
    [true, 'c'],
    [false, 'd'],
    [false, 'e'],
    [false, 'f'],
    [false, 'g'],
    [false, 'h'],
  ])
})

test('a newline right after a pipe continues it; a subshell takes the pipe in', () => {
  assert.deepEqual(piped('a |\n  b'), [
    [false, 'a'],
    [true, 'b'],
  ])
  assert.deepEqual(piped('a | (b; c) | d'), [
    [false, 'a'],
    [true, '('],
    [true, 'b'],
    [false, 'c'],
    [false, ')'],
    [true, 'd'],
  ])
})

test('a < target is an input of its command; other redirection targets and heredoc words are not', () => {
  assert.deepEqual(
    commands('wc -l < a.txt 0<b.txt > c.txt <<< here 2>&1').map(c => [c.words, c.inputs]),
    [
      [
        ['wc', '-l'],
        ['a.txt', 'b.txt'],
      ],
    ],
  )
  assert.deepEqual(
    commands('cat <<EOF\nx < y\nEOF').map(c => [c.words, c.inputs]),
    [[['cat'], []]],
  )
})

test('a command splits into simple commands at shell operators, quotes kept whole', () => {
  assert.deepEqual(simpleCommands(`a "x|y" | b < f && c\\ d`), [['a', 'x|y'], ['b'], ['c d']])
  assert.deepEqual(simpleCommands('git add a && git commit -m "a; b" ; git push|cat'), [
    ['git', 'add', 'a'],
    ['git', 'commit', '-m', 'a; b'],
    ['git', 'push'],
    ['cat'],
  ])
  assert.deepEqual(simpleCommands("echo 'x y'\nls"), [['echo', 'x y'], ['ls']])
})

test('redirections and their targets are no words, whatever their shape', () => {
  for (const command of [
    'git push 2>&1 | tail -3',
    'git push >&2',
    'git push &>log',
    'git push &>> log',
    'git push 1>/dev/null',
    'git push 2> err.txt',
    'git push < /dev/null',
    'git push >|out 2>&-',
  ]) {
    assert.deepEqual(simpleCommands(command)[0], ['git', 'push'], command)
  }
  assert.deepEqual(simpleCommands('git push origin HEAD:feat/x>out.txt'), [['git', 'push', 'origin', 'HEAD:feat/x']])
  assert.deepEqual(simpleCommands('a 2>&1 && b > f c'), [['a'], ['b', 'c']])
})

test('a heredoc opens only outside quotes; a shell fed one runs its body as a subshell', () => {
  assert.deepEqual(simpleCommands('echo "a<<EOF" \'b<<EOF\'\nls'), [['echo', 'a<<EOF', 'b<<EOF'], ['ls']])
  assert.deepEqual(simpleCommands('bash <<EOF\ncd x; ls\nEOF\npwd'), [['bash'], ['('], ['cd', 'x'], ['ls'], [')'], ['pwd']])
  assert.deepEqual(simpleCommands('cat <<A <<-B\na\nA\n\tb\n\tB\nls'), [['cat'], ['ls']], 'two heredocs on a line, closed in order')
  assert.deepEqual(simpleCommands('cat > notes.txt <<EOF\ngit push origin HEAD:feat/z\nEOF\nls'), [['cat'], ['ls']], 'a heredoc body is no command')
})

test('a process substitution opens a subshell and is no redirection target', () => {
  assert.deepEqual(
    commands('diff <(git show a) >(cat)').map(c => [c.words, c.inputs]),
    [
      [['diff'], []],
      [['('], []],
      [['git', 'show', 'a'], []],
      [[')'], []],
      [['('], []],
      [['cat'], []],
      [[')'], []],
    ],
  )
})

test('a comment is no word; a # inside a word is (realm @nick/craft, node #390)', () => {
  assert.deepEqual(simpleCommands("ls # it's\npwd"), [['ls'], ['pwd']])
  assert.deepEqual(simpleCommands('git log --format=%h#%s url#frag "#" \'#\' ${#x} $# a\\ #b'), [
    ['git', 'log', '--format=%h#%s', 'url#frag', '#', '#', '${#x}', '$#', 'a #b'],
  ])
  assert.deepEqual(simpleCommands("bash <<EOF\n# it's\nls\nEOF"), [['bash'], ['('], ['ls'], [')']], 'a comment in a body a shell runs')
})
