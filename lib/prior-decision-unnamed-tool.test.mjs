// A gate seed with no source ('tool') and no toolRule names no rule — it may be a deadnix one — so the
// memory match tells it apart by title, as the dedup does, and never by shared title words
// (realm @nick/craft, nodes #236, #238).
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { cutPairsNote, isRulelessToolFinding, matchClass, matchFindings, namesNoRule, MATCHED_BY_SAME_TITLE, MATCHED_BY_TITLE, MATCHED_BY_TOOL_TITLE } from './prior-decision-match.mjs'

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
  assert.ok(r.refused.some(x => x.includes('got no judge verdict and no same title near its line — raised')), 'the raised pair is named')
})

test('a sourceless seed matches its own record by lens, line and the same title, without a judge', async () => {
  const f = seed()
  const r = await matchFindings([f], [rec(), rec({ id: 'd-self', title: ' unused LAMBDA pattern:  self ' })], deadJudge)
  assert.equal(r.matchOf(f)?.d.id, 'd-self')
  assert.equal(r.matchOf(f)?.how, MATCHED_BY_TOOL_TITLE)
})

test('the note for pairs past the judge\'s bound does not promise the title rule to a rule-less tool finding', () => {
  const note = cutPairsNote([{ f: seed(), d: rec() }])
  assert.ok(note.includes('for a tool finding naming no rule only the same title near its line'), note)
  assert.ok(note.includes('raised normally: "Unused lambda pattern: self" @ flake.nix:3 ~ d-pkgs'), note)
})

test('a source-less seed at line 0 matches a line-less record in its file only by the same title', async () => {
  const d = rec({ id: 'd-fmt', title: 'File not formatted: flake.nix', line: undefined })
  const same = seed({ title: 'File not formatted: flake.nix', line: 0 })
  assert.equal((await matchFindings([same], [d], deadJudge)).matchOf(same)?.d.id, 'd-fmt')
  const other = seed({ title: 'flake.nix needs alejandra', line: 0 })
  assert.equal((await matchFindings([other], [d], deadJudge)).matchOf(other), undefined, 'another title stays raised')
  const named = seed({ title: 'File not formatted: flake.nix', line: 0, toolRule: 'W04' })
  assert.equal((await matchFindings([named], [d], deadJudge)).matchOf(named)?.how, MATCHED_BY_TITLE, 'a seed naming a rule is no rule-less whole-file finding: the title rule sets it aside')
})

test('a source-less seed against a record naming a rule: the judge decides; with none, the same title near its line sets it aside', async () => {
  const d = rec({ id: 'd-clippy', title: 'Unused lambda pattern: self', lens: 'clippy', toolRule: 'clippy::needless_clone' })
  const f = seed()
  assert.equal(matchClass(f, d), 'disputed', 'no match on the title alone against a record naming a rule')
  /** @type {string[]} */
  const prompts = []
  const judged = await matchFindings([f], [d], async p => { prompts.push(p); return { verdicts: [{ pair: 0, same: true, why: 'one lint' }] } })
  assert.equal(prompts.length, 1, 'put to the judge')
  assert.match(String(judged.matchOf(f)?.how), /^matched by judge/)
  assert.equal((await matchFindings([f], [d], deadJudge)).matchOf(f)?.how, 'matched by the same title near its line (the judge gave no verdict)')
  assert.equal((await matchFindings([seed({ line: 30 })], [d], deadJudge)).matchOf(seed({ line: 30 })), undefined, 'the same title far from the line stays raised')
  assert.equal(matchClass(f, rec({ toolRule: 'W04', title: f.title })), 'disputed', 'same lens and place, the record names a rule: the judge, not the title')
})

test('a named tool finding without toolRule is told apart by title with no judge verdict, as in the dedup', async () => {
  const statix = (/** @type {string} */ title) => seed({ source: 'statix', title })
  const d = rec({ id: 'd-statix', lens: 'statix', title: 'Unused lambda pattern: pkgs' })
  assert.equal(namesNoRule(statix('x')), true)
  assert.equal(isRulelessToolFinding(statix('x')), false, 'statix prints rule names: no title anchor without a judge')
  assert.equal((await matchFindings([statix('Unused lambda pattern: self')], [d], deadJudge)).matchOf(statix('Unused lambda pattern: self')), undefined, 'shared words do not set it aside')
  const same = statix('unused lambda  pattern: PKGS')
  assert.equal((await matchFindings([same], [d], deadJudge)).matchOf(same)?.how, MATCHED_BY_SAME_TITLE)
  assert.equal(MATCHED_BY_SAME_TITLE, 'matched by the same title near its line (the judge gave no verdict)')
})

test('a seed merged with a review lens keeps the title rule against its own reworded record', async () => {
  const merged = seed({ sources: ['tool', 'safety'], title: 'config value is read twice during load' })
  const d = rec({ id: 'd-safety', lens: 'safety', title: 'config value is read twice during loading' })
  assert.equal(namesNoRule(merged), false)
  assert.equal(isRulelessToolFinding(merged), false)
  assert.equal((await matchFindings([merged], [d], deadJudge)).matchOf(merged)?.how, MATCHED_BY_TITLE)
})
