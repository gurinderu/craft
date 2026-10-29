// lib/shell-touches.mjs on `xargs`: a reader xargs runs reads the paths piped into it, which the upstream
// command names (a listing, `git ls-files`, a `grep -l`, through stdin filters); when nothing upstream names
// them, the read is reported as unattributed rather than dropped.
import { test } from 'vitest'
import assert from 'node:assert/strict'
import path from 'node:path'
import { bashTouches } from './shell-touches.mjs'

const REPO = '/work/repo'
/** @param {string} cmd @param {string} [cwd] */
const rel = (cmd, cwd = REPO) => bashTouches(cmd, cwd, REPO).touches.map(t => [t.tool, t.kind, t.kind === 'unattributed' ? t.command : path.relative(REPO, t.path) || '.'])

test('xargs cat reads what git ls-files, find or ls names upstream', () => {
  assert.deepEqual(rel('git ls-files crates/x | xargs cat'), [['Bash:cat', 'read', 'crates/x']])
  assert.deepEqual(rel(`find crates/x -name '*.rs' | xargs cat`), [['Bash:find', 'list', 'crates/x'], ['Bash:cat', 'read', 'crates/x']])
  assert.deepEqual(rel('git -C /work/repo ls-files -- crates/x crates/y | xargs -n 1 cat'), [['Bash:cat', 'read', 'crates/x'], ['Bash:cat', 'read', 'crates/y']])
  assert.deepEqual(rel(`git ls-files crates/x | xargs sed -n '1,40p'`), [['Bash:sed', 'read', 'crates/x']])
  assert.deepEqual(rel('git ls-files crates/x | xargs -0 head -n 20'), [['Bash:head', 'read', 'crates/x']])
  // From where the command stands, like any other path.
  assert.deepEqual(rel('git ls-files src | xargs cat', `${REPO}/crates/b`), [['Bash:cat', 'read', 'crates/b/src']])
  // No path upstream: git ls-files lists where it stands.
  assert.deepEqual(rel('git ls-files | xargs cat', `${REPO}/crates/b`), [['Bash:cat', 'read', 'crates/b']])
})

test('stdin filters between the producer and xargs pass its paths on', () => {
  assert.deepEqual(rel(`git ls-files crates/x | grep '\\.rs$' | head -5 | xargs cat`), [['Bash:cat', 'read', 'crates/x']])
  assert.deepEqual(rel('grep -rl unsafe crates/z | sort | xargs cat'), [['Bash:grep', 'search', 'crates/z'], ['Bash:cat', 'read', 'crates/z']])
  assert.deepEqual(rel('find crates/z -type f | xargs -I{} cat {}'), [['Bash:find', 'list', 'crates/z'], ['Bash:cat', 'read', 'crates/z']])
  assert.deepEqual(rel(`git ls-files -- crates/z | grep '[.]rs$' | tr '\\n' '\\0' | xargs -0 -r cat | wc -l`), [['Bash:cat', 'read', 'crates/z']])
})

test('xargs cat with nothing upstream naming paths is an unattributed read, not nothing', () => {
  const cmd = 'echo crates/z/src/lib.rs | xargs cat'
  assert.deepEqual(rel(cmd), [['Bash:cat', 'unattributed', cmd]])
  assert.deepEqual(rel('cat list.txt | xargs cat'), [['Bash:cat', 'read', 'list.txt'], ['Bash:cat', 'unattributed', 'cat list.txt | xargs cat']])
})

test('xargs with paths of its own reads them and the piped ones; a reader fed by a plain pipe still reads stdin', () => {
  assert.deepEqual(rel('git ls-files crates/x | xargs cat crates/a/lib.rs'), [['Bash:cat', 'read', 'crates/a/lib.rs'], ['Bash:cat', 'read', 'crates/x']], 'xargs appends what it reads to the operands')
  assert.deepEqual(rel('git ls-files crates/x | cat'), [])
  assert.deepEqual(rel('cat crates/a/src/f0.rs | head -n 30'), [['Bash:cat', 'read', 'crates/a/src/f0.rs']])
})

// One tokenizer (lib/shell-words.mjs, realm @nick/craft, node #360): the cases the local regex read differently.
test('quotes joined to a word and operators inside quotes stay one word', () => {
  assert.deepEqual(rel(`grep -n "fn"'|'impl crates/x && cat "d&e;f.rs"`), [['Bash:grep', 'search', 'crates/x'], ['Bash:cat', 'read', 'd&e;f.rs']])
})

test('|| and && start an unpiped command; a newline after a pipe continues it', () => {
  assert.deepEqual(rel('git ls-files crates/x || xargs cat'), [], 'what git printed never reaches xargs across ||')
  assert.deepEqual(rel('git ls-files crates/x |\n  xargs cat'), [['Bash:cat', 'read', 'crates/x']])
  assert.deepEqual(rel('git ls-files crates/x |& xargs cat'), [['Bash:cat', 'read', 'crates/x']])
})

test('a heredoc body is data unless a shell is fed it, and its word is not a path', () => {
  // A heredoc fed to cat is text it copies; fed to a shell it is commands the shell runs.
  assert.deepEqual(rel(`cat <<EOF > f\ncat crates/y/b.rs\nEOF\ncat crates/a.rs`), [['Bash:cat', 'read', 'crates/a.rs']])
  assert.deepEqual(rel(`bash <<'EOF'\ncat crates/y/b.rs\nEOF\ncat crates/a.rs`), [['Bash:cat', 'read', 'crates/y/b.rs'], ['Bash:cat', 'read', 'crates/a.rs']])
  assert.deepEqual(rel(`FOO=1 rtk sh <<-EOF\n\tcat crates/y/b.rs\n\tEOF`), [['Bash:cat', 'read', 'crates/y/b.rs']])
})

test('a << inside quotes starts no heredoc', () => {
  assert.deepEqual(rel(`grep -n "a<<EOF" crates/x/a.rs\ncat crates/y/b.rs`), [['Bash:grep', 'search', 'crates/x/a.rs'], ['Bash:cat', 'read', 'crates/y/b.rs']])
})

test('a process substitution is a command of its own, read like any other', () => {
  assert.deepEqual(rel('diff <(git show HEAD~1:crates/x/src/a.rs) <(cat crates/x/src/a.rs)'), [['Bash:git show', 'read', 'crates/x/src/a.rs'], ['Bash:cat', 'read', 'crates/x/src/a.rs']])
})

test('an output redirection target is not read; an input one is', () => {
  assert.deepEqual(rel('cat crates/a.rs > out.txt 2>/dev/null'), [['Bash:cat', 'read', 'crates/a.rs']])
  assert.deepEqual(rel('cat crates/a.rs 2>&1 | head -5'), [['Bash:cat', 'read', 'crates/a.rs']])
  assert.deepEqual(rel('grep -n unsafe < crates/b.rs'), [['Bash:grep', 'search', 'crates/b.rs']])
})

test('an escaped space is part of the path; a subshell paren passes the pipe on', () => {
  assert.deepEqual(rel('cat crates/my\\ file.rs'), [['Bash:cat', 'read', 'crates/my file.rs']])
  assert.deepEqual(rel('git ls-files crates/x | (xargs cat)'), [['Bash:cat', 'read', 'crates/x']])
})
