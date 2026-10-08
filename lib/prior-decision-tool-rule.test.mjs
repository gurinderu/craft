// A gate tool's finding matches a remembered record by its toolRule as well (realm @nick/craft, node #236):
// the tool's own rule name, not the catalog ruleId many lints share. The sure match (same lens, line ±3)
// needs the same toolRule, a different toolRule is no candidate, a record without one goes to the
// judge, who sees both sides' toolRule; a finding of a review lens behaves as before. The record's
// toolRule is read, checked and carried from a PR thread's finding comment.
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { judgePair, judgePrompt, matchClass, matchFindings, sureMatchOf, MATCHED_BY_ANCHOR, MATCHED_BY_RULE } from './prior-decision-match.mjs'
import { readPriorDecision } from './prior-decision-record.mjs'
import { findingCommentBody, readFindingComment } from './finding-comment.mjs'
import { threadAnchor } from './pr-thread-rule.mjs'

/** @param {Record<string, unknown>} [over] @returns {any} */
const rec = (over = {}) => ({ id: 'decision-1', kind: 'decision', title: 'needless pass by value of Config', scope: 'src/a.rs', reason: 'by design', who: 'a', when: '2026-10-01', link: '', commit: 'abc1234', deferred: false, supersedes: [], line: 41, lens: 'clippy-pedantic', toolRule: 'clippy::needless_pass_by_value', ...over })
/** @param {Record<string, unknown>} [over] @returns {any} */
const fnd = (over = {}) => ({ title: 'cast may truncate u64 to u32', file: 'src/a.rs', line: 43, source: 'clippy-pedantic', ruleId: 'MNT-001', toolRule: 'clippy::cast_possible_truncation', severity: 'Medium', why: 'truncation', ...over })

test('#232: a rejected lint A at line 41 does not set aside lint B (Medium) at line 43', async () => {
  assert.equal(matchClass(fnd(), rec()), '', 'another toolRule: not even a candidate')
  assert.equal(sureMatchOf([rec()])(fnd()), undefined)
  /** @type {string[]} */
  const prompts = []
  const f = fnd()
  const r = await matchFindings([f], [rec()], async p => { prompts.push(p); return { verdicts: [] } })
  assert.equal(r.matchOf(f), undefined)
  assert.equal(prompts.length, 0, 'no judge for a pair the toolRule already tells apart')
})

test('two statix lints under the one catalog ruleId MNT-001 are not the same finding', async () => {
  const d = rec({ lens: 'statix', title: 'manual inherit from attrset', ruleId: 'MNT-001', toolRule: 'W04', line: 10, scope: 'flake.nix' })
  const f = fnd({ source: 'statix', title: 'useless parentheses', file: 'flake.nix', line: 11, ruleId: 'MNT-001', toolRule: 'W08' })
  assert.equal(matchClass(f, d), '', 'the shared catalog ruleId does not join them')
  /** @type {string[]} */
  const prompts = []
  const r = await matchFindings([f], [d], async p => { prompts.push(p); return { verdicts: [] } })
  assert.equal(r.matchOf(f), undefined)
  assert.equal(prompts.length, 0)
  assert.equal(matchClass({ ...f, toolRule: 'w04' }, d), 'anchored', 'the same statix code does')
})

test('a tool finding with the same toolRule, lens and line ±3 matches without a judge; toolRule compared case- and space-blind', () => {
  const same = fnd({ toolRule: ' Clippy::Needless_Pass_By_Value ', title: 'Config passed by value needlessly' })
  assert.equal(matchClass(same, rec()), 'anchored')
  assert.equal(sureMatchOf([rec()])(same)?.how, MATCHED_BY_RULE)
  assert.equal(matchClass(fnd({ toolRule: rec().toolRule, line: 50 }), rec()), 'disputed', 'same rule, past the sure window: the judge')
  assert.equal(matchClass({ ...fnd({ source: 'tool' }), toolRule: 'X-1' }, rec({ lens: 'tool', toolRule: 'x-1' })), 'anchored', "lens 'tool'")
})

test('a record without toolRule against a tool finding goes to the judge, never a direct match', async () => {
  const old = rec({ toolRule: undefined })
  assert.equal(matchClass(fnd(), old), 'disputed')
  assert.equal(matchClass(fnd({ toolRule: '' }), rec()), 'disputed', 'a finding without toolRule: the judge too')
  const f = fnd()
  const no = await matchFindings([f], [old], async () => ({ verdicts: [{ pair: 0, same: false, why: 'another lint' }] }))
  assert.equal(no.matchOf(f), undefined)
  const yes = await matchFindings([f], [old], async () => ({ verdicts: [{ pair: 0, same: true, why: 'same lint' }] }))
  assert.equal(yes.matchOf(f)?.how, 'matched by judge: same lint')
})

test('a finding of a review lens ignores ruleId and toolRule: same lens and line ±3 matches as before', () => {
  const lensRec = rec({ lens: 'safety', ruleId: 'SAF-001', toolRule: 'x' })
  const lensFnd = fnd({ source: 'safety', ruleId: 'SAF-002', toolRule: 'y' })
  assert.equal(matchClass(lensFnd, lensRec), 'anchored')
  assert.equal(sureMatchOf([lensRec])(lensFnd)?.how, MATCHED_BY_ANCHOR)
  assert.equal(matchClass(fnd({ source: 'safety' }), rec({ lens: 'safety', toolRule: undefined })), 'anchored')
})

test("the judge's pair carries both sides' toolRule in the one JSON block, no reason", () => {
  const pair = judgePair({ f: fnd(), d: rec({ toolRule: undefined }) }, 0)
  assert.equal(pair.record.toolRule, '')
  assert.equal(pair.finding.toolRule, 'clippy::cast_possible_truncation')
  const p = judgePrompt([{ f: fnd({ toolRule: '' }), d: rec() }])
  assert.match(p, /"toolRule":"clippy::needless_pass_by_value"/)
  assert.doesNotMatch(p, /by design/, 'the record reason stays out (#231)')
  assert.equal(p.split('[{"pair":0').length, 2, 'one JSON block')
})

test('the record reader keeps toolRule and refuses a malformed one by name', () => {
  /** @param {unknown} toolRule @returns {any} */
  const read = toolRule => readPriorDecision({ ...rec(), toolRule }, 'decision #0')
  assert.equal(read(' clippy::needless_pass_by_value ').toolRule, 'clippy::needless_pass_by_value')
  assert.equal(read(undefined).toolRule, undefined)
  assert.match(read(7), /toolRule 7 is not a string/)
  assert.match(read('x'.repeat(121)), /toolRule is 121 chars/)
  assert.match(read('a\u0007b'), /toolRule contains a control character/)
})

test('the finding comment carries toolRule on a hidden line, and a thread hands it to the record', () => {
  const body = findingCommentBody({ severity: 'Medium', title: 't', why: 'w', fix: 'f', source: 'clippy-pedantic', toolRule: 'clippy::cast_possible_truncation' })
  assert.match(body, /^<!-- craft-tool-rule: clippy::cast_possible_truncation -->$/m)
  const read = readFindingComment(body)
  assert.deepEqual(read, { severity: 'Medium', title: 't', lens: 'clippy-pedantic', toolRule: 'clippy::cast_possible_truncation' })
  assert.doesNotMatch(findingCommentBody({ severity: 'Low', title: 't', toolRule: 'bad rule -->' }), /craft-rule/, 'an unfit toolRule is left out')
  assert.equal(readFindingComment(findingCommentBody({ severity: 'Low', title: 't', toolRule: '' }))?.toolRule, undefined)
  assert.deepEqual(threadAnchor(/** @type {any} */ ({ originalLine: 43 }), read ?? {}), { line: 43, lens: 'clippy-pedantic', toolRule: 'clippy::cast_possible_truncation' })
})
