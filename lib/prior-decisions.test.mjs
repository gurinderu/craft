// The prior-decision rules, executed directly. The engine-level behaviour (what the report and the
// ledger say) is pinned in review-prior-decisions.test.mjs through the engine harness.
import { test } from 'vitest'
import assert from 'node:assert/strict'
import {
  parsePriorDecisions, decisionAnswers, decisionsToCheck, splitByDecisions, scopeCheckScript,
  priorDecisionMark, PRIOR_DECISIONS_MAX, DECISION_FIELD_MAX,
} from './prior-decisions.mjs'

const decision = (/** @type {Record<string, unknown>} */ over = {}) => ({
  id: 'decision-46833ecec3', title: 'unwrap in parser may panic', scope: 'src/parse.rs',
  reason: 'input is validated upstream', who: 'alice', when: '2026-10-01', link: 'https://x/pr/1#c2', commit: 'abc1234', ...over,
})

test('parse: absent argument applies nothing and says nothing', () => {
  for (const raw of [undefined, null, '']) assert.deepEqual(parsePriorDecisions(raw), { decisions: [], refused: [] })
})

test('parse: malformed argument applies nothing and names why', () => {
  assert.equal(parsePriorDecisions('{not json').decisions.length, 0)
  assert.match(String(parsePriorDecisions('{not json').refused[0]), /not JSON/)
  assert.match(String(parsePriorDecisions({ a: 1 }).refused[0]), /not a list/)
  assert.match(String(parsePriorDecisions([42]).refused[0]), /not an object/)
})

test('parse: a JSON string of decisions is read like the list itself', () => {
  assert.equal(parsePriorDecisions(JSON.stringify([decision()])).decisions.length, 1)
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
  assert.deepEqual(decisionsToCheck([fs[1]], ds), [], 'a Critical is never set aside, so nothing to check')
})

test('scope script: one quoted git diff per decision, printing id and status', () => {
  const ds = /** @type {any[]} */ (parsePriorDecisions([decision({ scope: "src/it's.rs" })]).decisions)
  assert.equal(scopeCheckScript(ds), `git diff --quiet 'abc1234' -- 'src/it'\\''s.rs'; echo 'decision-46833ecec3' $?`)
})
