// A gate seed with no source ('tool') and no toolRule names no rule — it may be a deadnix one — so the
// memory match tells it apart by title, as the dedup does, and never by shared title words
// (realm @nick/craft, nodes #236, #238).
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { cutPairsNote, isRulelessToolFinding, matchFindings, MATCHED_BY_TOOL_TITLE } from './prior-decision-match.mjs'

/** @param {Record<string, unknown>} [over] @returns {any} */
const rec = (over = {}) => ({ id: 'd-pkgs', kind: 'decision', title: 'Unused lambda pattern: pkgs', scope: 'flake.nix', reason: 'kept for the overlay', who: 'a', when: '2026-10-01', link: '', commit: 'abc1234', deferred: false, supersedes: [], line: 3, lens: 'tool', ...over })
/** @param {Record<string, unknown>} [over] @returns {any} */
const seed = (over = {}) => ({ title: 'Unused lambda pattern: self', file: 'flake.nix', line: 3, source: 'tool', ruleId: 'MNT-001', severity: 'Low', why: 'unused', ...over })
const deadJudge = async () => { throw new Error('judge down') }

test('a sourceless seed without toolRule is rule-less; with a toolRule it is not', () => {
  assert.equal(isRulelessToolFinding(seed()), true)
  assert.equal(isRulelessToolFinding(seed({ toolRule: '  ' })), true, 'a blank toolRule names nothing')
  assert.equal(isRulelessToolFinding(seed({ toolRule: 'W04' })), false, 'a named rule keeps the toolRule requirement')
  assert.equal(isRulelessToolFinding(seed({ sources: ['tool', 'clippy'] })), false, 'a rule-printing tool also raised it')
})

test('dead judge: a sourceless seed is not set aside by another binding\'s record through shared title words', async () => {
  const f = seed()
  const r = await matchFindings([f], [rec()], deadJudge)
  assert.equal(r.matchOf(f), undefined, '"…: self" stays raised against the record of "…: pkgs"')
  assert.ok(r.refused.some(x => x.includes('got no judge verdict — raised')), 'the raised pair is named')
})

test('a sourceless seed matches its own record by lens, line and the same title, without a judge', async () => {
  const f = seed()
  const r = await matchFindings([f], [rec(), rec({ id: 'd-self', title: ' unused LAMBDA pattern:  self ' })], deadJudge)
  assert.equal(r.matchOf(f)?.d.id, 'd-self')
  assert.equal(r.matchOf(f)?.how, MATCHED_BY_TOOL_TITLE)
})

test('the note for pairs past the judge\'s bound does not promise the title rule to a rule-less tool finding', () => {
  const note = cutPairsNote([{ f: seed(), d: rec() }])
  assert.ok(note.includes('never for a rule-less tool finding'), note)
})
