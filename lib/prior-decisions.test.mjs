// The prior-decision rules, executed directly. The engine-level behaviour (what the report and the
// ledger say) is pinned in review-prior-decisions.test.mjs through the engine harness.
import { test } from 'vitest'
import assert from 'node:assert/strict'
import {
  parsePriorDecisions, decisionAnswers, PRIOR_DECISIONS_MAX, DECISION_FIELD_MAX, DECISION_TITLE_OVERLAP, priorDecisionsRefusedSection,
} from './prior-decisions.mjs'
import {
  decisionsToCheck, splitByDecisions, scopeCheckScript, priorDecisionMark, priorRejectedSection, readScopeCheck, applyPriorDecisions,
} from './prior-decision-apply.mjs'

const decision = (/** @type {Record<string, unknown>} */ over = {}) => ({
  id: 'decision-46833ecec3', title: 'unwrap in parser may panic', scope: 'src/parse.rs',
  reason: 'input is validated upstream', who: 'alice', when: '2026-10-01', link: 'https://x/pr/1#c2', commit: 'abc1234', ...over,
})

test('parse: absent argument applies nothing and says nothing', () => {
  for (const raw of [undefined, null, '']) assert.deepEqual(parsePriorDecisions(raw), { decisions: [], refused: [] })
})

test('parse: malformed argument applies nothing and names why', () => {
  assert.equal(parsePriorDecisions('{not json').decisions.length, 0)
  assert.match(String(parsePriorDecisions('{not json').refused[0]), /arrived as a string/)
  assert.match(String(parsePriorDecisions({ a: 1 }).refused[0]), /not a list/)
  assert.match(String(parsePriorDecisions([42]).refused[0]), /not an object/)
})

test('parse: a JSON string of decisions is refused — only a list is read', () => {
  assert.equal(parsePriorDecisions(JSON.stringify([decision()])).decisions.length, 0)
})

test('parse: required fields, status, scope and commit are checked per decision', () => {
  const { decisions, refused } = parsePriorDecisions([
    decision(), decision({ reason: '' }), decision({ status: 'superseded' }),
    decision({ scope: '/etc/passwd' }), decision({ scope: '../x' }), decision({ commit: "abc'; rm -rf /" }),
  ])
  assert.equal(decisions.length, 1)
  assert.equal(refused.length, 5)
  assert.match(refused.join('\n'), /lacks an id/)
  assert.match(refused.join('\n'), /not active/)
  assert.match(refused.join('\n'), /not a repo-relative path/)
  assert.match(refused.join('\n'), /not a commit hash/)
})

test('bound: a field over its ceiling refuses the decision rather than truncating it', () => {
  const atCap = decision({ reason: 'r'.repeat(DECISION_FIELD_MAX.reason) })
  const over = decision({ reason: 'r'.repeat(DECISION_FIELD_MAX.reason + 1) })
  assert.equal(parsePriorDecisions([atCap]).decisions.length, 1)
  const r = parsePriorDecisions([over])
  assert.equal(r.decisions.length, 0)
  assert.match(String(r.refused[0]), /reason is 1201 chars, over the 1200-char ceiling/)
})

test('bound: past PRIOR_DECISIONS_MAX the rest are refused by count, not dropped silently', () => {
  const list = Array.from({ length: PRIOR_DECISIONS_MAX + 3 }, (_, i) => decision({ id: `d${i}` }))
  const r = parsePriorDecisions(list)
  assert.equal(r.decisions.length, PRIOR_DECISIONS_MAX)
  assert.match(r.refused.join('\n'), /3 decision\(s\) past the cap of 100 were not applied/)
})

test('match: scope containment by segments, and title overlap', () => {
  const d = /** @type {any} */ (parsePriorDecisions([decision({ scope: 'src' })]).decisions[0])
  assert.ok(decisionAnswers({ file: 'src/parse.rs', title: 'parser unwrap may panic' }, d))
  assert.ok(decisionAnswers({ file: './src/./parse.rs', title: 'unwrap in parser may panic' }, d))
  assert.ok(!decisionAnswers({ file: 'src-evil/parse.rs', title: 'unwrap in parser may panic' }, d), 'a sibling prefix is not inside')
  assert.ok(!decisionAnswers({ file: 'lib/parse.rs', title: 'unwrap in parser may panic' }, d), 'outside the scope')
  assert.ok(!decisionAnswers({ file: 'src/parse.rs', title: 'sql injection in query builder' }, d), 'a different defect in scope')
  const whole = /** @type {any} */ (parsePriorDecisions([decision({ scope: '.' })]).decisions[0])
  assert.ok(decisionAnswers({ file: 'any/where.rs', title: 'unwrap in parser may panic' }, whole), '`.` covers the repo')
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

test('scope script: one quoted git diff per decision, printing id and status', () => {
  const ds = /** @type {any[]} */ (parsePriorDecisions([decision({ scope: "src/it's.rs" })]).decisions)
  assert.equal(scopeCheckScript(ds), `git diff --quiet 'abc1234' -- 'src/it'\\''s.rs'; echo 'decision-46833ecec3' $?`)
})

test('parse: a repeated id is refused, the first kept', () => {
  const r = parsePriorDecisions([decision(), decision({ scope: 'lib' })])
  assert.equal(r.decisions.length, 1)
  assert.equal(r.decisions[0]?.scope, 'src/parse.rs')
  assert.match(String(r.refused[0]), /repeats an id already given/)
})

test('bound: the title overlap answers exactly at DECISION_TITLE_OVERLAP and not one word below', () => {
  assert.equal(DECISION_TITLE_OVERLAP, 0.6)
  // 5 words in the longer title: 3 shared = 0.6 (answers), 2 shared = 0.4 (does not).
  const d = /** @type {any} */ (parsePriorDecisions([decision({ title: 'alpha beta gamma delta epsilon', scope: '.' })]).decisions[0])
  assert.ok(decisionAnswers({ file: 'a.rs', title: 'alpha beta gamma zeta eta' }, d), '3 of 5 shared')
  assert.ok(!decisionAnswers({ file: 'a.rs', title: 'alpha beta theta zeta eta' }, d), '2 of 5 shared')
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
  assert.deepEqual(readScopeCheck({ unchanged: ['a', 7, 'b'], reason: '' }), ['a', 'b'])
})

test('apply: no decisions → the tiers untouched and the scope check never called', async () => {
  const tiers = { confirmed: [{ file: 'a', title: 't', severity: 'Low' }] }
  let called = 0
  const r = await applyPriorDecisions(tiers, [], async () => { called++; return null })
  assert.equal(r.tiers, tiers)
  assert.equal(called, 0)
  assert.deepEqual(r.notes, [])
})

test('parse: a memory record is read as recalled — body, date, author, links[]; a non-decision kind is refused', () => {
  const rec = { id: 'decision-46833ecec3', kind: 'decision', title: 'unwrap in parser may panic', body: 'validated upstream', scope: 'src/parse.rs', status: 'active', date: '2026-10-01', author: 'alice', commit: 'abc1234', links: ['decision-0', 'https://x/pr/1#c2'] }
  const r = parsePriorDecisions([rec, { ...rec, id: 'lesson-1', kind: 'lesson' }])
  assert.deepEqual(r.decisions[0], { id: rec.id, title: rec.title, scope: rec.scope, reason: 'validated upstream', who: 'alice', when: '2026-10-01', link: 'https://x/pr/1#c2', commit: 'abc1234' })
  assert.match(String(r.refused[0]), /is a "lesson" record, not a decision/)
})
