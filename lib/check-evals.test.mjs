import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { lintEvalCase, lintCorpus, knownSkills } from './check-evals.mjs'

const known = new Set(['rust-review', 'debugging', 'nix-review'])
const ok = { skills: ['rust-review'], query: 'review this diff', expected_behavior: ['selects rust-review'] }

test('lintEvalCase is clean on a well-formed case', () => {
  assert.deepEqual(lintEvalCase(ok, known), [])
})

test('lintEvalCase flags an unknown skill id', () => {
  const errs = lintEvalCase({ ...ok, skills: ['ghost-skill'] }, known)
  assert.equal(errs.length, 1)
  assert.match(errs[0], /unknown skill "ghost-skill"/)
})

test('lintEvalCase requires a non-empty skills array', () => {
  assert.match(lintEvalCase({ ...ok, skills: [] }, known)[0], /skills must be a non-empty array/)
  assert.match(lintEvalCase({ ...ok, skills: 'rust-review' }, known)[0], /skills must be a non-empty array/)
})

test('lintEvalCase requires a non-empty query', () => {
  assert.match(lintEvalCase({ ...ok, query: '   ' }, known)[0], /query must be a non-empty string/)
  assert.match(lintEvalCase({ ...ok, query: 42 }, known)[0], /query must be a non-empty string/)
})

test('lintEvalCase requires non-empty expected_behavior with string assertions', () => {
  assert.match(lintEvalCase({ ...ok, expected_behavior: [] }, known)[0], /expected_behavior must be a non-empty array/)
  assert.match(lintEvalCase({ ...ok, expected_behavior: ['ok', ''] }, known)[0], /non-string\/empty assertion/)
})

test('lintEvalCase rejects a non-object case', () => {
  assert.match(lintEvalCase(null, known)[0], /is not an object/)
  assert.match(lintEvalCase(['x'], known)[0], /is not an object/)
})

test('lintCorpus rejects a non-array or empty root', () => {
  assert.deepEqual(lintCorpus({}, known), ['corpus root must be a JSON array'])
  assert.deepEqual(lintCorpus([], known), ['corpus is empty'])
})

test('lintCorpus flags duplicate queries', () => {
  const errs = lintCorpus([ok, { ...ok }], known)
  assert.ok(errs.some(e => /duplicate query/.test(e)), errs.join('; '))
})

test('lintCorpus aggregates per-case problems with indices', () => {
  const errs = lintCorpus([ok, { ...ok, skills: ['ghost'] }], known)
  assert.ok(errs.some(e => /case\[1\] references unknown skill/.test(e)), errs.join('; '))
})

// Static guard on the REAL corpus: this is what gives `node --test` a check on evals/evals.json
// without needing a model. If a skill is renamed/removed and the corpus not updated, this fails.
test('the shipped evals/evals.json is well-formed and references only real skills', () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  const parsed = JSON.parse(fs.readFileSync(path.join(root, 'evals', 'evals.json'), 'utf8'))
  const problems = lintCorpus(parsed, knownSkills(path.join(root, 'skills')))
  assert.deepEqual(problems, [], problems.join('\n'))
})
