// readRepoArg and repoDirective (lib/repo-arg.mjs): the `repo` argument review and triage-findings share.
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { readRepoArg, repoDirective } from './repo-arg.mjs'

test('readRepoArg: absent spellings mean no repo', () => {
  for (const v of [undefined, null, '', false]) assert.equal(readRepoArg(v), '')
})

test('readRepoArg: an absolute path is kept as given', () => {
  for (const v of ['/a/b', '/a/b/', 'C:\\work\\x', 'd:/w']) assert.equal(readRepoArg(v), v)
})

test('readRepoArg: what no agent could cd to throws, naming the argument and the value', () => {
  assert.throws(() => readRepoArg('rel/x'), /^Error: repo="rel\/x" refused: it is not an absolute path\. Nothing ran/)
  assert.throws(() => readRepoArg('~/x'), /not an absolute path/)
  assert.throws(() => readRepoArg(' '), /blank/)
  assert.throws(() => readRepoArg('/a\u0000b'), /control character/)
  assert.throws(() => readRepoArg('/a\u007f'), /control character/)
  assert.throws(() => readRepoArg(1), /^Error: repo=1 refused: it is not a path/)
  assert.throws(() => readRepoArg({}), /not a path/)
})

test('repoDirective: empty without a repo; names the work and quotes the path for the shell', () => {
  assert.equal(repoDirective('', 'review'), '')
  const d = repoDirective("/a/it's", 'triage')
  assert.match(d, /^WORKING DIRECTORY: this triage targets the repository at '\/a\/it'\\''s' — NOT/)
  assert.match(d, /Every file path in this triage is relative to that root\./)
  assert.ok(d.endsWith('\n\n'))
})
