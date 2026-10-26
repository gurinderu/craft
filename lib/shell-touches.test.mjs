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
