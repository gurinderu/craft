// Applying prior decisions to an engine's findings, executed directly: which decisions need their
// scope checked, the scope-check lines and answer, the split of a tier, and the report sections.
// Reading and matching the decisions is pinned in prior-decisions.test.mjs.
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { parsePriorDecisions, priorDecisionsRefusedSection } from './prior-decisions.mjs'
import { splitByDecisions, priorDecisionMark, priorRejectedSection, applyPriorDecisions, recordsDeferral, deferredQuestionId, deferralReleased } from './prior-decision-apply.mjs'
import { decisionsToCheck, scopeCheckScript, readScopeCheck } from './prior-decision-scope.mjs'

const decision = (/** @type {Record<string, unknown>} */ over = {}) => ({
  id: 'decision-46833ecec3', title: 'unwrap in parser may panic', scope: 'src/parse.rs',
  reason: 'input is validated upstream', who: 'alice', when: '2026-10-01', link: 'https://x/pr/1#c2', commit: 'abc1234', ...over,
})

test('split: unchanged scope sets a Medium aside, marked with reason, who, when, link', () => {
  const d = /** @type {any} */ (parsePriorDecisions([decision()]).decisions[0])
  const f = { file: 'src/parse.rs', title: 'unwrap in parser may panic', severity: 'Medium', why: 'w' }
  const r = splitByDecisions([f], [d], new Set([d.id]), 'confirmed')
  assert.equal(r.kept.length, 0)
  assert.equal(r.setAside.length, 1)
  assert.equal(r.setAside[0]?.priorTier, 'confirmed')
  assert.equal(r.setAside[0]?.why, `w · ${priorDecisionMark(d)}`)
  assert.match(priorDecisionMark(d), /REJECTED BEFORE: input is validated upstream — alice, 2026-10-01, https:\/\/x\/pr\/1#c2/)
})

test('split: Critical/High, a changed scope, and a missing commit are raised again, with why', () => {
  const [d, noCommit] = /** @type {any[]} */ (parsePriorDecisions([decision(), decision({ id: 'd2', commit: '', scope: 'lib' })]).decisions)
  const f = (/** @type {string} */ sev, file = 'src/parse.rs') => ({ file, title: 'unwrap in parser may panic', severity: sev, why: 'w' })
  const high = splitByDecisions([f('High')], [d], new Set([d.id]), 'confirmed')
  assert.equal(high.setAside.length, 0); assert.equal(high.reraised, 1)
  assert.match(String(high.kept[0]?.why), /Critical\/High finding is never set aside/)
  const changed = splitByDecisions([f('Low')], [d], new Set(), 'unverified')
  assert.equal(changed.setAside.length, 0)
  assert.match(String(changed.kept[0]?.why), /changed since abc1234/)
  const nc = splitByDecisions([f('Low', 'lib/a.rs')], [noCommit], new Set(['d2']), 'unverified')
  assert.equal(nc.setAside.length, 0)
  assert.match(String(nc.kept[0]?.why), /records no commit/)
})

test('check list: only decisions that could set a finding aside and recorded a commit', () => {
  const ds = /** @type {any[]} */ (parsePriorDecisions([decision(), decision({ id: 'd2', commit: '' })]).decisions)
  const fs = [{ file: 'src/parse.rs', title: 'unwrap in parser may panic', severity: 'Low' }, { file: 'src/parse.rs', title: 'unwrap in parser may panic', severity: 'Critical' }]
  assert.deepEqual(decisionsToCheck(fs, ds).map(d => d.id), ['decision-46833ecec3'])
  assert.deepEqual(decisionsToCheck(fs.slice(1), ds), [], 'a Critical is never set aside, so nothing to check')
})

test('scope script: one quoted line per decision, printing id and status — or `missing` for a commit the repo does not know', () => {
  const ds = /** @type {any[]} */ (parsePriorDecisions([decision({ id: "it's-1" })]).decisions)
  assert.equal(scopeCheckScript(ds), `if git cat-file -e 'abc1234^{commit}' 2>/dev/null; then git diff --quiet 'abc1234' -- 'src/parse.rs'; echo 'it'\\''s-1' $?; else echo 'it'\\''s-1' missing; fi`)
})

test('sections: refusals and set-aside findings render; empty renders nothing', () => {
  assert.equal(priorDecisionsRefusedSection([]), '')
  assert.equal(priorDecisionsRefusedSection(['x is wrong']), '\n\n## Prior decisions not applied\n- ⚠️ x is wrong\n')
  assert.equal(priorRejectedSection([]), '')
  assert.equal(priorRejectedSection([{ severity: 'Low', file: 'a.rs', line: 3, title: 't', why: 'w' }]), '\n\n## Rejected before (set aside — not in the verdict)\n- Low · `a.rs:3` · t · w')
})

test('scope check answer: a missing or unreadable answer shows nothing unchanged', () => {
  assert.equal(readScopeCheck(null), null)
  assert.equal(readScopeCheck({ unchanged: 'decision-1' }), null)
  assert.deepEqual(readScopeCheck({ unchanged: ['a', 7, 'b'], reason: '' }), { unchanged: ['a', 'b'], missing: [] })
  assert.deepEqual(readScopeCheck({ unchanged: [], missing: ['c', null], reason: '' }), { unchanged: [], missing: ['c'] })
})

test('apply: a commit the repo does not know raises the finding normally and is named apart from a changed scope', async () => {
  const [d] = /** @type {any[]} */ (parsePriorDecisions([decision()]).decisions)
  const f = { file: 'src/parse.rs', title: 'unwrap in parser may panic', severity: 'Medium', why: 'w' }
  const r = await applyPriorDecisions({ confirmed: [f] }, [d], async () => ({ unchanged: [], missing: [d.id], reason: '' }))
  assert.equal(r.setAside.length, 0)
  assert.match(String(r.tiers['confirmed']?.[0]?.why), /raised again: commit abc1234 not found in this repo — raised normally/)
  assert.doesNotMatch(String(r.tiers['confirmed']?.[0]?.why), /changed since/)
  assert.deepEqual(r.refused, ['decision decision-46833ecec3: commit abc1234 not found in this repo — raised normally'])
})

test('apply: no decisions → the tiers untouched and the scope check never called', async () => {
  const tiers = { confirmed: [{ file: 'a', title: 't', severity: 'Low' }] }
  let called = 0
  const r = await applyPriorDecisions(tiers, [], async () => { called++; return null })
  assert.equal(r.tiers, tiers)
  assert.equal(called, 0)
  assert.deepEqual(r.notes, [])
})

// A question in the memory skill's shape. @param {Record<string, unknown>} [over]
const question = (over = {}) => ({
  id: 'question-1a2b3c4d5e', kind: 'question', title: 'unwrap in parser may panic', scope: 'src/parse.rs', status: 'active',
  body: 'decide once the parser is replaced', date: '2026-10-02', author: 'alice', commit: 'abc1234', deferred: true, links: ['https://x/pr/3#c9'], ...over,
})

test('deferral: only a question carrying `deferred: true` and a commit records a deferral; a decision always applies', () => {
  const [d, q, noFlag, noCommit, strFlag] = /** @type {any[]} */ (parsePriorDecisions([
    decision(), question(), question({ id: 'question-2', deferred: undefined }), question({ id: 'question-3', commit: '' }), question({ id: 'question-4', deferred: 'true' }),
  ]).decisions)
  assert.equal(recordsDeferral(d), true)
  assert.equal(recordsDeferral(q), true)
  assert.equal(recordsDeferral(noFlag), false, 'a question without `deferred: true` is context only, commit or not')
  assert.equal(recordsDeferral(noCommit), false, 'a deferral needs a commit for the scope check')
  assert.equal(recordsDeferral(strFlag), false, '`deferred` is a boolean, not a string')
})

test('apply: a question without `deferred: true` sets nothing aside and labels nothing — context only, even with a commit', async () => {
  const [q] = /** @type {any[]} */ (parsePriorDecisions([question({ deferred: undefined })]).decisions)
  const f = { file: 'src/parse.rs', title: 'unwrap in parser may panic', severity: 'Medium', why: 'w' }
  let called = 0
  const r = await applyPriorDecisions({ confirmed: [f] }, [q], async () => { called++; return { unchanged: [q.id], missing: [], reason: '' } })
  assert.equal(r.setAside.length, 0)
  assert.equal(r.tiers['confirmed']?.[0]?.why, 'w')
  assert.equal(called, 0)
  assert.match(r.notes.join('\n'), /1 open question\(s\) record no deferral — context only/)
})

test('apply: a deferral without a commit is raised again and named', async () => {
  const [q] = /** @type {any[]} */ (parsePriorDecisions([question({ commit: '' })]).decisions)
  const f = { file: 'src/parse.rs', title: 'unwrap in parser may panic', severity: 'Medium', why: 'w' }
  const r = await applyPriorDecisions({ confirmed: [f] }, [q], async () => ({ unchanged: [], missing: [], reason: '' }))
  assert.equal(r.setAside.length, 0)
  assert.match(String(r.tiers['confirmed']?.[0]?.why), /Deferred before \(question question-1a2b3c4d5e[^)]*\) — raised again: the question records no commit/)
  assert.deepEqual(r.refused, ['question question-1a2b3c4d5e: records a deferral but no commit, so an unchanged scope cannot be established — raised normally'])
})

test('apply: a record another given record supersedes sets nothing aside', async () => {
  const [q, d] = /** @type {any[]} */ (parsePriorDecisions([question(), decision({ id: 'decision-2', title: 'something else entirely', links: ['supersedes: question-1a2b3c4d5e'] })]).decisions)
  const f = { file: 'src/parse.rs', title: 'unwrap in parser may panic', severity: 'Medium', why: 'w' }
  const r = await applyPriorDecisions({ confirmed: [f] }, [q, d], async () => ({ unchanged: [q.id, d.id], missing: [], reason: '' }))
  assert.equal(r.setAside.length, 0)
  assert.match(r.notes.join('\n'), /1 record\(s\) superseded by another given record — not applied: question-1a2b3c4d5e/)
})

test('carried deferral: released only when a record supersedes or answers its question — never by its absence', () => {
  const why = 'panics · KNOWN AND DEFERRED: decide — alice, 2026-10-02, https://x (question question-1a2b3c4d5e)'
  assert.equal(deferredQuestionId(why), 'question-1a2b3c4d5e')
  assert.equal(deferredQuestionId('no mark here'), '')
  const held = /** @type {any[]} */ (parsePriorDecisions([question()]).decisions)
  assert.equal(deferralReleased(why, held), false)
  assert.equal(deferralReleased(why, []), false, 'absent from the records: no release')
  assert.equal(deferralReleased(why, /** @type {any[]} */ (parsePriorDecisions([question({ deferred: undefined })]).decisions)), false, 'present but no longer a deferral: no release either')
  assert.equal(deferralReleased(why, /** @type {any[]} */ (parsePriorDecisions([decision({ links: ['answers: question-other'] })]).decisions)), false, 'a link naming another question')
  for (const link of ['supersedes: question-1a2b3c4d5e', 'answers: question-1a2b3c4d5e']) {
    const ds = /** @type {any[]} */ (parsePriorDecisions([question(), decision({ links: [link] })]).decisions)
    assert.equal(deferralReleased(why, ds), true, link)
  }
  assert.equal(deferralReleased('no mark here', []), false, 'a row naming no question is left as it is')
})
