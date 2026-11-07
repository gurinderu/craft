// `crateScope` turns a crate directory from the scout into the repo-relative pathspec the nested
// `review` is dispatched with. Its absolute branch is careful — it compares normalized SEGMENTS
// against the repo root and returns null rather than guessing. Its RELATIVE branch was not: it
// normalized and returned whatever came back, and `pathSegments` keeps a leading `..` as a literal
// segment when there is nothing left to pop. So a scout that answered `../../elsewhere` produced a
// pathspec that climbs OUT of the repository under review, and a crate label then covers a diff
// taken somewhere else entirely — the same class the absolute branch already refuses, through the
// door next to it.
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { crateScope } from './rust-audit-crate-scope.mjs'

/** @param {string} repoRoot */
const loadCrateScope = repoRoot => (/** @type {unknown} */ p) => crateScope(p, repoRoot)

test('crateScope refuses a relative crate path that climbs out of the repository', () => {
  const scope = loadCrateScope('/r')
  assert.equal(scope('crates/core'), 'crates/core', 'an ordinary relative crate path is unchanged')
  assert.equal(scope('./crates/core'), 'crates/core', 'and still normalized')
  assert.equal(scope('crates/../crates/core'), 'crates/core', 'an interior `..` that stays inside is fine')
  assert.equal(scope('..'), null, 'but a path that IS the parent is not a crate in this repository')
  assert.equal(scope('../elsewhere'), null, 'nor one that climbs out of it')
  assert.equal(scope('../../elsewhere/crates/core'), null, 'however many levels')
  assert.equal(scope('crates/../../elsewhere'), null, 'or reaches the outside after normalization')
})

test('crateScope still refuses an absolute path outside the repo, and repairs one inside', () => {
  const scope = loadCrateScope('/r')
  assert.equal(scope('/r/crates/core'), 'crates/core')
  assert.equal(scope('/r-evil/crates/core'), null, 'a sibling directory is not inside the repo')
  assert.equal(scope('/elsewhere'), null)
})
