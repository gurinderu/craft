// The record–finding match (realm @nick/craft, node #230): the candidate filter, the sure matches, the
// one judge and its bound, and the record's anchor as the reader takes it.
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { matchClass, matchFindings, readJudge, sureMatchOf, triedOrder, MATCH_JUDGE_PAIRS_MAX, MATCH_LINE_WINDOW, MATCHED_BY_ANCHOR, MATCHED_BY_TITLE } from './prior-decision-match.mjs'
import { readPriorDecision } from './prior-decision-record.mjs'
import { mergeAndRead } from './memory-recall.mjs'
import { parsePriorDecisions } from './prior-decisions.mjs'

/** @param {Record<string, unknown>} [over] @returns {any} */
const rec = (over = {}) => ({ id: 'question-1', kind: 'question', title: 'Nothing guards deletion of a referenced group', scope: 'src/g.rs', reason: 'later', who: 'a', when: '2026-10-01', link: '', commit: 'abc1234', deferred: true, supersedes: [], line: 40, lens: 'safety', ...over })
/** @param {Record<string, unknown>} [over] @returns {any} */
const fnd = (over = {}) => ({ title: 'Deleting a group while a VM references it is allowed', file: 'src/g.rs', line: 42, source: 'safety', severity: 'Medium', why: 'dangling id', ...over })

test('matchClass: anchored needs file, line within the window and lens; the window is inclusive', () => {
  assert.equal(matchClass(fnd(), rec()), 'anchored')
  assert.equal(matchClass(fnd({ line: 40 + MATCH_LINE_WINDOW }), rec()), 'anchored')
  assert.equal(matchClass(fnd({ line: 41 + MATCH_LINE_WINDOW }), rec()), 'disputed', 'same lens, too far: the judge decides')
  assert.equal(matchClass(fnd({ source: 'errors' }), rec()), 'disputed', 'near, another lens: the judge decides')
  assert.equal(matchClass(fnd({ file: 'src/other.rs' }), rec()), '', 'outside the scope: never')
  assert.equal(matchClass(fnd({ line: 300, source: 'errors', title: 'unrelated listing cost' }), rec()), '', 'far, another lens, low overlap: no candidate')
  assert.equal(matchClass(fnd({ line: 300, source: 'errors', title: 'Nothing guards removal of the VM pool' }), rec()), 'disputed', 'title overlap ≥ 0.3 alone is a candidate')
  assert.equal(matchClass({ ...fnd(), source: undefined, lens: 'x', sources: ['errors', 'safety'] }, rec()), 'anchored', 'any of a finding\'s lenses')
})

test('matchClass: no comparable anchor keeps the title rule (0.6)', () => {
  const bare = rec({ line: undefined, lens: undefined })
  assert.equal(matchClass(fnd(), bare), '')
  assert.equal(matchClass(fnd({ title: 'Nothing guards deletion of a referenced group' }), bare), 'title')
  assert.equal(matchClass(fnd({ line: 0, source: '', title: 'Nothing guards deletion of a referenced group' }), rec()), 'title', 'a finding without line or lens')
})

test('triedOrder and sureMatchOf: an overriding record is tried first', () => {
  const successor = rec({ id: 'decision-s', kind: 'decision' })
  const fresh = rec({ id: 'decision-f', kind: 'decision', overrides: ['decision-s'] })
  assert.deepEqual(triedOrder([successor, fresh]).map(d => d.id), ['decision-f', 'decision-s'])
  assert.equal(sureMatchOf([successor, fresh])(fnd())?.d.id, 'decision-f')
  assert.equal(sureMatchOf([successor])(fnd())?.how, MATCHED_BY_ANCHOR)
  assert.equal(sureMatchOf([rec({ line: undefined, lens: undefined })])(fnd({ title: rec().title }))?.how, MATCHED_BY_TITLE)
})

test('readJudge: off-shape, out-of-range and repeated verdicts are ignored; no list is null', () => {
  assert.equal(readJudge(null, 2), null)
  assert.equal(readJudge({ verdicts: 'x' }, 2), null)
  const v = readJudge({ verdicts: [{ pair: 0, same: true, why: ' a\n b ' }, { pair: 0, same: false, why: 'dup' }, { pair: 5, same: true, why: 'out' }, { pair: 1, same: 'yes', why: 'bad' }] }, 2)
  assert.deepEqual([...(v ?? new Map())], [[0, { same: true, why: 'a b' }]])
})

test('matchFindings: one judge for every disputed pair; a sure match after a disputed one is kept when the judge says no', async () => {
  /** @type {string[]} */
  const prompts = []
  const d1 = rec({ id: 'q-far', line: 200 })
  const d2 = rec({ id: 'q-near' })
  const f = fnd()
  const r = await matchFindings([f], [d1, d2], async p => { prompts.push(p); return { verdicts: [{ pair: 0, same: false, why: 'other' }] } })
  assert.equal(prompts.length, 1)
  assert.match(prompts[0] ?? '', /PAIR 0[\s\S]*q-far/)
  assert.equal(r.matchOf(f)?.d.id, 'q-near')
  const yes = await matchFindings([f], [d1, d2], async () => ({ verdicts: [{ pair: 0, same: true, why: 'same guard' }] }))
  assert.deepEqual(yes.matchOf(f), { d: d1, how: 'matched by judge: same guard' }, 'tried first, judged the same: it wins')
})

test('matchFindings: no disputed pair, no judge', async () => {
  let called = 0
  const r = await matchFindings([fnd()], [rec()], async () => { called++; return null })
  assert.equal(called, 0)
  assert.deepEqual(r.refused, [])
})

test('matchFindings: a dead or throwing judge matches nothing disputed, said once; a missing verdict is named', async () => {
  const f1 = fnd({ line: 200 })
  const f2 = fnd({ line: 300 })
  const dead = await matchFindings([f1, f2], [rec()], async () => null)
  assert.equal(dead.matchOf(f1), undefined)
  assert.equal(dead.refused.length, 1)
  assert.match(dead.refused[0] ?? '', /match judge died or answered unreadably — 2 disputed/)
  const threw = await matchFindings([f1], [rec()], async () => { throw new Error('wall') })
  assert.match(threw.refused[0] ?? '', /died or answered unreadably/)
  const partial = await matchFindings([f1, f2], [rec()], async () => ({ verdicts: [{ pair: 1, same: true, why: 'w' }] }))
  assert.equal(partial.matchOf(f1), undefined)
  assert.equal(partial.matchOf(f2)?.d.id, 'question-1')
  assert.match(partial.refused[0] ?? '', /no verdict for 1 disputed/)
})

test('matchFindings: at most MATCH_JUDGE_PAIRS_MAX pairs are judged, settable findings first; the cut is named and does not match', async () => {
  const findings = Array.from({ length: MATCH_JUDGE_PAIRS_MAX + 2 }, (_, i) => fnd({ line: 100 + i, title: `finding ${i} Nothing guards deletion`, severity: i === 0 ? 'High' : 'Medium' }))
  /** @type {number} */
  let seen = 0
  const r = await matchFindings(findings, [rec()], async p => {
    seen = [...p.matchAll(/--- PAIR \d+ ---/g)].length
    return { verdicts: Array.from({ length: seen }, (_, i) => ({ pair: i, same: true, why: 'w' })) }
  })
  assert.equal(seen, MATCH_JUDGE_PAIRS_MAX)
  assert.equal(r.matchOf(findings[0] ?? fnd()), undefined, 'the High goes last, past the bound')
  assert.equal(r.matchOf(findings[1] ?? fnd())?.d.id, 'question-1')
  assert.match(r.refused[0] ?? '', new RegExp(`2 disputed record–finding pair\\(s\\) past the judge's bound of ${MATCH_JUDGE_PAIRS_MAX} were not judged[\\s\\S]*"finding 0 Nothing guards deletion" @ src/g.rs:100 ~ question-1`))
})

test('record reader: line and lens are optional; given, they are read; malformed, the record is refused by name', () => {
  const base = { id: 'decision-1', kind: 'decision', title: 't', scope: 's', body: 'b' }
  const plain = /** @type {any} */ (readPriorDecision(base, 0))
  assert.equal(plain.line, undefined)
  assert.equal(plain.lens, undefined)
  const anchored = /** @type {any} */ (readPriorDecision({ ...base, line: '42', lens: ' safety ' }, 0))
  assert.equal(anchored.line, 42)
  assert.equal(anchored.lens, 'safety')
  assert.equal(/** @type {any} */ (readPriorDecision({ ...base, line: 0 }, 0)).line, undefined, '0 is no line')
  assert.equal(readPriorDecision({ ...base, line: 'forty' }, 0), 'decision #0 (decision-1): line "forty" is not a line number')
  assert.equal(readPriorDecision({ ...base, line: -3 }, 0), 'decision #0 (decision-1): line -3 is not a line number')
  assert.equal(readPriorDecision({ ...base, lens: 7 }, 0), 'decision #0 (decision-1): lens 7 is not a string')
  assert.match(String(readPriorDecision({ ...base, lens: 'x'.repeat(81) }, 0)), /lens is 81 chars, over the 80-char ceiling/)
  assert.equal(readPriorDecision({ ...base, lens: 'a\nb' }, 0), 'decision #0 (decision-1): lens contains a control character')
})

test('mergeAndRead: a passed record applied over an active successor carries overrides naming it', () => {
  const passed = { id: 'decision-f', kind: 'decision', title: 'old', scope: 'src', body: 'fresh', date: '2026-10-05', commit: 'abc1234' }
  const successor = { id: 'decision-s', kind: 'decision', title: 'new', scope: 'src', body: 'succ', status: 'active', date: '2026-10-03', commit: 'abc1234', links: ['supersedes: decision-f'] }
  const m = mergeAndRead([successor], [passed], parsePriorDecisions, [])
  assert.deepEqual(/** @type {any} */ (m.merged[1]).overrides, ['decision-s'])
  assert.deepEqual(m.read.prior.decisions.find(d => d.id === 'decision-f')?.overrides, ['decision-s'])
  assert.equal(/** @type {any} */ (m.merged[0]).overrides, undefined)
})

test('matchClass: a directory or whole-repo scope compares no line — another file at a near line is not anchored', () => {
  assert.equal(matchClass(fnd({ file: 'src/other.rs', line: 41 }), rec({ scope: 'src/' })), 'disputed')
  assert.equal(matchClass(fnd({ file: 'src/other.rs', line: 41 }), rec({ scope: '.' })), 'disputed')
  assert.equal(matchClass(fnd({ file: 'src/other.rs', line: 41, source: 'perf', title: 'x y z' }), rec({ scope: '.' })), '')
  assert.equal(matchClass(fnd(), rec()), 'anchored')
})

test('matchFindings: under the bound a near-line pair outranks lens-only pairs', async () => {
  const flood = Array.from({ length: MATCH_JUDGE_PAIRS_MAX + 5 }, (_, i) => fnd({ title: `unrelated ${i}`, line: 200 + i * 20 }))
  const reworded = fnd({ title: 'A group still referenced can be removed', line: 41, source: 'correctness' })
  /** @type {string[]} */
  let seen = []
  const judge = async (/** @type {string} */ p) => {
    seen = [...p.matchAll(/--- PAIR (\d+) ---\nRECORD[^\n]*\n[^\n]*\n[^\n]*\nFINDING \(this round\): ([^\n]*)/g)].map(m => m[2] ?? '')
    return { verdicts: seen.map((t, pair) => ({ pair, same: t.startsWith('A group'), why: 'w' })) }
  }
  const { matchOf } = await matchFindings([...flood, reworded], [rec()], judge)
  assert.equal(seen[0], 'A group still referenced can be removed')
  assert.ok(matchOf(reworded))
})

test('matchClass: a near-verbatim title stays a sure match when the anchor does not hold (the title rule of #187 is kept)', () => {
  const same = { title: 'Nothing guards deletion of a referenced group' }
  assert.equal(matchClass(fnd({ ...same, source: 'correctness' }), rec()), 'title')
  assert.equal(matchClass(fnd({ ...same, file: 'src/other.rs' }), rec({ scope: 'src/' })), 'title')
  assert.equal(matchClass(fnd({ source: 'correctness' }), rec()), 'disputed')
})
