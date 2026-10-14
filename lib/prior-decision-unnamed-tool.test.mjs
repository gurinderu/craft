// A gate seed with no source ('tool') and no toolRule names no rule — it may be a deadnix one — so the
// memory match tells it apart by title, as the dedup does, and never by shared title words
// (realm @nick/craft, nodes #236, #238).
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { cutPairsNote, isRulelessToolFinding, matchClass, matchFindings, namesNoRule, MATCHED_BY_SAME_TITLE, MATCHED_BY_SAME_TITLE_IN_SCOPE, MATCHED_BY_TITLE, MATCHED_BY_TOOL_TITLE } from './prior-decision-match.mjs'

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
  assert.ok(r.refused.some(x => x.includes('had a candidate record the judge gave no verdict on (or that fell past its bound) and no tool record with the same title — raised')), 'the raised pair is named')
})

test('a sourceless seed matches its own record by lens, line and the same title, without a judge', async () => {
  const f = seed()
  const r = await matchFindings([f], [rec(), rec({ id: 'd-self', title: ' unused LAMBDA pattern:  self ' })], deadJudge)
  assert.equal(r.matchOf(f)?.d.id, 'd-self')
  assert.equal(r.matchOf(f)?.how, MATCHED_BY_TOOL_TITLE)
})

test('the note for pairs past the judge\'s bound does not promise the title rule to a rule-less tool finding', () => {
  const note = cutPairsNote([{ f: seed(), d: rec() }])
  assert.ok(note.includes('for a tool finding naming no rule only a tool record with the same title'), note)
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
  const far = seed({ line: 30 })
  assert.equal((await matchFindings([far], [d], deadJudge)).matchOf(far), undefined, 'the same title far from the line stays raised')
  assert.equal(matchClass(f, rec({ toolRule: 'W04', title: f.title })), 'disputed', 'same lens and place, the record names a rule: the judge, not the title')
})

test('a named tool finding without toolRule is told apart by title with no judge verdict, as in the dedup', async () => {
  const statix = (/** @type {string} */ title) => seed({ source: 'statix', title })
  const d = rec({ id: 'd-statix', lens: 'statix', title: 'Unused lambda pattern: pkgs' })
  assert.equal(namesNoRule(statix('x')), true)
  assert.equal(isRulelessToolFinding(statix('x')), false, 'statix prints rule names: no title anchor without a judge')
  const other = statix('Unused lambda pattern: self')
  assert.equal((await matchFindings([other], [d], deadJudge)).matchOf(other), undefined, 'shared words do not set it aside')
  const same = statix('unused lambda  pattern: PKGS')
  assert.equal((await matchFindings([same], [d], deadJudge)).matchOf(same)?.how, MATCHED_BY_SAME_TITLE)
  assert.equal(MATCHED_BY_SAME_TITLE, 'matched by the same title near its line (the judge gave no verdict)')
})

test('a seed merged with a review lens is still told apart by title: its reworded record stays the judge\'s', async () => {
  const merged = seed({ sources: ['tool', 'safety'], title: 'config value is read twice during load' })
  const d = rec({ id: 'd-safety', lens: 'safety', title: 'config value is read twice during loading' })
  assert.equal(namesNoRule(merged), true)
  assert.equal((await matchFindings([merged], [d], deadJudge)).matchOf(merged), undefined, 'raised: shared words never set a tool finding aside')
})

test('a deadnix seed merged with a review lens keeps #237: another binding stays raised, its own title anchors without a judge', async () => {
  const merged = seed({ source: 'deadnix', sources: ['deadnix', 'maintainability'], title: 'Unused lambda pattern: self' })
  assert.equal(isRulelessToolFinding(merged), true)
  assert.equal((await matchFindings([merged], [rec({ lens: 'deadnix' })], deadJudge)).matchOf(merged), undefined)
  assert.equal(matchClass(merged, rec({ id: 'd-self', lens: 'deadnix', title: 'Unused lambda pattern: self' })), 'anchored')
  const fmt = seed({ source: 'fmt', sources: ['fmt', 'maintainability'], title: 'File not formatted: flake.nix', line: 0 })
  assert.equal(matchClass(fmt, rec({ lens: 'fmt', title: 'File not formatted: flake.nix', line: undefined })), 'anchored', 'whole-file fmt keeps its anchor')
})

test('no judge verdict, a tool finding naming no rule: the same title in scope with no line to compare sets it aside; a review-lens record does not', async () => {
  const clippy = seed({ source: 'clippy', title: 'Manual map over Option', file: 'src/lib.rs', line: 40 })
  const lineless = rec({ id: 'd-lineless', lens: 'clippy', title: 'Manual map over Option', scope: 'src/lib.rs', line: undefined })
  assert.equal((await matchFindings([clippy], [lineless], deadJudge)).matchOf(clippy)?.how, MATCHED_BY_SAME_TITLE_IN_SCOPE)
  const dir = rec({ id: 'd-dir', lens: 'clippy', title: 'Manual map over Option', scope: 'src', line: 40 })
  assert.equal((await matchFindings([clippy], [dir], deadJudge)).matchOf(clippy)?.how, MATCHED_BY_SAME_TITLE_IN_SCOPE, 'a directory scope compares no line')
  const lensRec = rec({ id: 'd-lens', lens: 'safety', title: 'Manual map over Option', scope: 'src/lib.rs', line: 41 })
  assert.equal((await matchFindings([clippy], [lensRec], deadJudge)).matchOf(clippy), undefined, 'a review lens record is no tool record')
})

test('a named tool finding without toolRule at line 0 is set aside by a line-less record of the same title in its file', async () => {
  const d = rec({ id: 'd-semver', lens: 'semver-checks', title: 'Public type Config removed', line: undefined, scope: 'src/lib.rs' })
  const f = seed({ source: 'semver-checks', title: 'public type  Config removed', file: 'src/lib.rs', line: 0 })
  assert.equal((await matchFindings([f], [d], deadJudge)).matchOf(f)?.how, MATCHED_BY_SAME_TITLE_IN_SCOPE)
  const elsewhere = seed({ source: 'semver-checks', title: 'Public type Config removed', file: 'src/other.rs', line: 0 })
  assert.equal((await matchFindings([elsewhere], [{ ...d, scope: 'src' }], deadJudge)).matchOf(elsewhere)?.how, MATCHED_BY_SAME_TITLE_IN_SCOPE, 'no line to compare: the same title in scope')
  const outside = seed({ source: 'semver-checks', title: 'Public type Config removed', file: 'tests/a.rs', line: 0 })
  assert.equal((await matchFindings([outside], [d], deadJudge)).matchOf(outside), undefined, 'out of scope stays raised')
})

test('no judge verdict: any tool record with the same title answers — another tool, a source named one round and not the next, an alias, no lens; a review lens does not', async () => {
  const deadnix = seed({ source: 'deadnix', title: 'Unused lambda pattern: self' })
  const statixRec = rec({ id: 'd-statix', lens: 'statix', title: 'Unused lambda pattern: self' })
  assert.equal((await matchFindings([deadnix], [statixRec], deadJudge)).matchOf(deadnix)?.how, MATCHED_BY_SAME_TITLE, 'another tool: the accepted cost (#236)')
  const toolRec = rec({ id: 'd-tool', lens: 'tool', title: 'Unused lambda pattern: self' })
  assert.ok((await matchFindings([deadnix], [toolRec], deadJudge)).matchOf(deadnix), 'a record from a source-less seed answers once the gate names the tool')
  const pedantic = seed({ source: 'clippy-pedantic', title: 'Manual map', line: 5 })
  assert.ok((await matchFindings([pedantic], [rec({ id: 'd-clippy', lens: 'clippy', title: 'Manual map' })], deadJudge)).matchOf(pedantic), 'clippy-pedantic and clippy')
  const old = rec({ id: 'd-old', lens: undefined, title: 'Unused lambda pattern: self' })
  assert.equal((await matchFindings([deadnix], [old], deadJudge)).matchOf(deadnix)?.how, MATCHED_BY_SAME_TITLE, 'a record with no lens')
  const merged = seed({ source: 'deadnix', sources: ['deadnix', 'safety'], title: 'Unused lambda pattern: self', line: 10 })
  assert.equal((await matchFindings([merged], [rec({ id: 'd-safety', lens: 'safety', title: 'Unused lambda pattern: self' })], deadJudge)).matchOf(merged), undefined, 'a review-lens record, even for a merged finding')
})

test('the refusal names each raised finding of a tool naming no rule', async () => {
  const f = seed()
  const r = await matchFindings([f], [rec()], deadJudge)
  assert.ok(r.refused.some(x => x.includes('with the same title — raised') && x.endsWith('"Unused lambda pattern: self" @ flake.nix:3')), r.refused.join(' | '))
})
