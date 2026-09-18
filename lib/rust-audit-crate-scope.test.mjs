// `crateScope` turns a crate directory from the scout into the repo-relative pathspec the nested
// `review` is dispatched with. Its absolute branch is careful — it compares normalized SEGMENTS
// against the repo root and returns null rather than guessing. Its RELATIVE branch was not: it
// normalized and returned whatever came back, and `pathSegments` keeps a leading `..` as a literal
// segment when there is nothing left to pop. So a scout that answered `../../elsewhere` produced a
// pathspec that climbs OUT of the repository under review, and a crate label then covers a diff
// taken somewhere else entirely — the same class the absolute branch already refuses, through the
// door next to it.
//
// Extracted by eval because workflows/*.js cannot be imported (top-level export + await + return).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import assertLib from 'node:assert'

const src = fs.readFileSync(new URL('../workflows/rust-audit.js', import.meta.url), 'utf8')

function loadCrateScope(repoRoot) {
  const abs = src.match(/^const ABSOLUTE_PATH = .*$/m)
  const segs = src.match(/function pathSegments\(p\) \{[\s\S]*?\n\}/)
  const cs = src.match(/function crateScope\(p\) \{[\s\S]*?\n\}/)
  assertLib.ok(abs && segs && cs, 'ABSOLUTE_PATH, pathSegments and crateScope found in workflows/rust-audit.js')
  return new Function('repoRoot', `${abs[0]}\n${segs[0]}\n${cs[0]}\n;return crateScope;`)(repoRoot)
}

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
