// readRepoArg and repoDirective (lib/repo-arg.mjs): the `repo` argument review and triage-findings share.
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { readRepoArg, repoDirective } from './repo-arg.mjs'

test('readRepoArg: absent spellings mean no repo and no refusal', () => {
  for (const v of [undefined, null, '', false]) assert.deepEqual(readRepoArg(v), { repo: '', refused: '' })
})

test('readRepoArg: an absolute path is kept as given', () => {
  for (const v of ['/a/b', '/a/b/', 'C:\\work\\x', 'd:/w']) assert.deepEqual(readRepoArg(v), { repo: v, refused: '' })
})

test('readRepoArg: what no agent could cd to is refused, naming the argument and the value, and targets nothing', () => {
  /** @param {unknown} v */
  const refused = v => { const r = readRepoArg(v); assert.equal(r.repo, ''); return r.refused }
  assert.match(refused('~/x'), /^repo="~\/x" refused: repo= must be an absolute path\. Nothing ran/)
  for (const rel of ['~', '~user/x', 'rel/x', '../sibling', '.']) assert.match(refused(rel), /repo= must be an absolute path/, rel)
  assert.match(refused(' '), /blank/)
  assert.match(refused('/a\u0000b'), /control character/)
  assert.match(refused('/a\u007f'), /control character/)
  assert.match(refused('/a\nb'), /control character/)
  assert.match(refused(1), /^repo=1 refused: it is not a path/)
  assert.match(refused(true), /not a path/)
  assert.match(refused({}), /not a path/)
})

test('repoDirective: empty without a repo; names the work and quotes the path for the shell', () => {
  assert.equal(repoDirective('', 'review'), '')
  const d = repoDirective("/a/it's", 'triage')
  assert.match(d, /^WORKING DIRECTORY: this triage targets the repository at '\/a\/it'\\''s' — NOT/)
  assert.match(d, /Every file path in this triage is relative to that root\./)
  assert.ok(d.endsWith('\n\n'))
})

test('repoDirective: the repo is cd-ed to as given, with no resolving step', () => {
  for (const abs of ['/a/b', 'C:\\w']) {
    const d = repoDirective(abs, 'review')
    assert.match(d, /— NOT the directory you start in\. Before ANY git/)
    assert.doesNotMatch(d, /Resolve it ONCE|RELATIVE/)
  }
})
