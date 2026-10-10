// The refusal for raised tool findings that name no rule: each finding named once, never one the note
// about pairs past the judge's bound already named, and the overflow past CUT_NAMED_MAX counted
// (realm @nick/craft, node #236).
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { matchFindings, CUT_NAMED_MAX, MATCH_JUDGE_PAIRS_MAX } from './prior-decision-match.mjs'

/** @param {Record<string, unknown>} [over] @returns {any} */
const rec = (over = {}) => ({ id: 'd-pkgs', kind: 'decision', title: 'Unused lambda pattern: pkgs', scope: 'flake.nix', reason: 'kept', who: 'a', when: '2026-10-01', link: '', commit: 'abc1234', deferred: false, supersedes: [], line: 3, lens: 'deadnix', ...over })
/** @param {Record<string, unknown>} [over] @returns {any} */
const seed = (over = {}) => ({ title: 'Unused lambda pattern: self', file: 'flake.nix', line: 3, source: 'deadnix', ruleId: 'MNT-001', severity: 'Low', why: 'unused', ...over })
const deadJudge = async () => { throw new Error('judge down') }
const RULELESS = 'had a candidate record the judge gave no verdict on'
/** Lens findings, each with one disputed record, to fill the judge's bound ahead of the seed. @param {number} n */
const fillers = n => {
  const fs = Array.from({ length: n }, (_, i) => ({ title: `config read twice ${i}`, file: `src/a${i}.rs`, line: 10, source: 'safety', severity: 'Low', why: 'w' }))
  const ds = fs.map((_, i) => rec({ id: `d-fill-${i}`, title: `unrelated wording ${i}`, scope: `src/a${i}.rs`, line: 12, lens: 'errors' }))
  return { fs, ds }
}

test('a raised finding with two unjudged candidate records is named once', async () => {
  const f = seed()
  const r = await matchFindings([f], [rec(), rec({ id: 'd-lib', title: 'Unused lambda pattern: lib', line: 4 })], deadJudge)
  const note = r.refused.find(x => x.includes(RULELESS))
  assert.ok(note?.startsWith('1 tool finding(s)'), note)
  assert.equal(String(note).split('"Unused lambda pattern: self" @ flake.nix:3').length - 1, 1)
})

test('a finding whose pair the bound cut is named by the cut note only, even with another pair inside the bound', async () => {
  const cut = fillers(MATCH_JUDGE_PAIRS_MAX)
  const only = seed()
  const r = await matchFindings([...cut.fs, only], [...cut.ds, rec()], deadJudge)
  assert.ok(r.refused.some(x => x.includes('past the judge\'s bound') && x.includes('"Unused lambda pattern: self"')))
  assert.equal(r.refused.filter(x => x.includes('"Unused lambda pattern: self"')).length, 1, r.refused.join(' | '))
  const straddle = fillers(MATCH_JUDGE_PAIRS_MAX - 1)
  const both = seed()
  const r2 = await matchFindings([...straddle.fs, both], [...straddle.ds, rec(), rec({ id: 'd-lib', title: 'Unused lambda pattern: lib', line: 4 })], deadJudge)
  assert.ok(r2.refused.some(x => x.includes('past the judge\'s bound') && x.includes('"Unused lambda pattern: self"')), 'one pair cut')
  assert.equal(r2.refused.filter(x => x.includes('"Unused lambda pattern: self"')).length, 1, 'not named a second time')
})

test('past CUT_NAMED_MAX raised findings the note counts the rest', async () => {
  const n = CUT_NAMED_MAX + 2
  const fs = Array.from({ length: n }, (_, i) => seed({ file: `f${i}.nix`, title: `Unused lambda pattern: s${i}` }))
  const ds = fs.map((_, i) => rec({ id: `d-${i}`, scope: `f${i}.nix` }))
  const note = (await matchFindings(fs, ds, deadJudge)).refused.find(x => x.includes(RULELESS))
  assert.ok(note?.startsWith(`${n} tool finding(s)`), note)
  assert.ok(String(note).endsWith(' and 2 more'), note)
})
