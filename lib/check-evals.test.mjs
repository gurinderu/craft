import { test } from 'vitest'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
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
  assert.match(/** @type {string} */ (errs[0]), /unknown skill "ghost-skill"/)
})

test('lintEvalCase requires a non-empty skills array', () => {
  assert.match(/** @type {string} */ (lintEvalCase({ ...ok, skills: [] }, known)[0]), /skills must be a non-empty array/)
  assert.match(/** @type {string} */ (lintEvalCase({ ...ok, skills: 'rust-review' }, known)[0]), /skills must be a non-empty array/)
})

test('lintEvalCase flags a non-string or blank skill entry, and reports every problem of a case in order', () => {
  assert.deepEqual(lintEvalCase({ ...ok, skills: ['', 7, 'ghost', 'rust-review'] }, known, 3), [
    'case[3] skills has a non-string/empty entry',
    'case[3] skills has a non-string/empty entry',
    'case[3] references unknown skill "ghost"',
  ])
  assert.deepEqual(lintEvalCase({ skills: [], query: '', expected_behavior: [1] }, known), [
    'case[0] skills must be a non-empty array',
    'case[0] query must be a non-empty string',
    'case[0] expected_behavior has a non-string/empty assertion',
  ])
})

test('lintEvalCase requires a non-empty query', () => {
  assert.match(/** @type {string} */ (lintEvalCase({ ...ok, query: '   ' }, known)[0]), /query must be a non-empty string/)
  assert.match(/** @type {string} */ (lintEvalCase({ ...ok, query: 42 }, known)[0]), /query must be a non-empty string/)
})

test('lintEvalCase requires non-empty expected_behavior with string assertions', () => {
  assert.match(/** @type {string} */ (lintEvalCase({ ...ok, expected_behavior: [] }, known)[0]), /expected_behavior must be a non-empty array/)
  assert.match(/** @type {string} */ (lintEvalCase({ ...ok, expected_behavior: ['ok', ''] }, known)[0]), /non-string\/empty assertion/)
})

test('lintEvalCase rejects a non-object case', () => {
  assert.match(/** @type {string} */ (lintEvalCase(null, known)[0]), /is not an object/)
  assert.match(/** @type {string} */ (lintEvalCase(['x'], known)[0]), /is not an object/)
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

test('lintEvalCase: a primitive is not an object either, and blank entries are empty', () => {
  assert.deepEqual(lintEvalCase(5, known), ['case[0] is not an object'])
  assert.deepEqual(lintEvalCase({ ...ok, skills: ['  '] }, known), ['case[0] skills has a non-string/empty entry'])
  assert.deepEqual(lintEvalCase({ ...ok, expected_behavior: ['  '] }, known), ['case[0] expected_behavior has a non-string/empty assertion'])
})

test('lintCorpus: a non-object case or a non-string query is reported, not thrown on', () => {
  assert.deepEqual(lintCorpus([null], known), ['case[0] is not an object'])
  assert.deepEqual(lintCorpus([{ ...ok, query: 42 }, { ...ok, query: 42 }], known), [
    'case[0] query must be a non-empty string', 'case[1] query must be a non-empty string',
  ])
})

test('lintCorpus: duplicates are compared trimmed, and empty queries are not duplicates of each other', () => {
  assert.deepEqual(lintCorpus([ok, { ...ok, query: `  ${ok.query} ` }], known), ['case[1] duplicate query (also case[0])'])
  assert.deepEqual(lintCorpus([{ ...ok, query: '' }, { ...ok, query: '' }], known), [
    'case[0] query must be a non-empty string', 'case[1] query must be a non-empty string',
  ])
})

test('knownSkills: only directories holding a SKILL.md', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'craft-evals-'))
  try {
    fs.mkdirSync(path.join(dir, 'real'))
    fs.writeFileSync(path.join(dir, 'real', 'SKILL.md'), '---\n---\n')
    fs.mkdirSync(path.join(dir, 'empty'))
    fs.writeFileSync(path.join(dir, 'stray.md'), '')
    assert.deepEqual([...knownSkills(dir)], ['real'])
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

// Static guard on the REAL corpus: this is what gives the unit tests a check on evals/evals.json
// without needing a model. If a skill is renamed/removed and the corpus not updated, this fails.
test('the shipped evals/evals.json is well-formed and references only real skills', () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  const parsed = JSON.parse(fs.readFileSync(path.join(root, 'evals', 'evals.json'), 'utf8'))
  const problems = lintCorpus(parsed, knownSkills(path.join(root, 'skills')))
  assert.deepEqual(problems, [], problems.join('\n'))
})
