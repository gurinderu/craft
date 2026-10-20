// Project rules in memory (realm @nick/craft, node #273): the record read and refused, the candidates
// (scope, lens), the judge's verdicts applied (covered, Critical raised, no verdict → not covered), the
// report section, the decisions' split leaving rules alone, the recall's third list and the tally.
import crypto from 'node:crypto'
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { parsePriorDecisions } from './prior-decisions.mjs'
import { applyPriorDecisions, priorRejectedSection } from './prior-decision-apply.mjs'
import { RULE_JUDGE_PAIRS_MAX, ruleCandidate, rulePairs, ruleJudgePrompt } from './project-rule-judge.mjs'
import { applyProjectRules, projectRuleSection, PROJECT_RULE_HEADING } from './project-rule-apply.mjs'
import { acceptedMemory, countedRecords, memoryRecallPrompt, memoryRecord, readMemoryRecall } from './memory-recall.mjs'
import { newMemoryTally, renderMemorySection, tallyMemory } from './memory-tally.mjs'

const RULE = { kind: 'rule', title: 'we do not support rollback', scope: 'crates/node', body: 'deploys only go forward', status: 'active', date: '2026-10-20', author: 'nick', commit: '', links: [] }
const ruleId = `rule-${crypto.createHash('sha256').update('rule\nwe do not support rollback\ncrates/node').digest('hex').slice(0, 10)}`
/** @param {Record<string, unknown>} [over] */
const finding = (over = {}) => ({ severity: 'Medium', title: 'migration has no down step', file: 'crates/node/src/db.rs', line: 12, why: 'cannot roll back', source: 'compat', ...over })
/** @param {Record<string, unknown>} [over] */
const rules = (over = {}) => parsePriorDecisions([{ ...RULE, ...over }]).decisions
/** @param {boolean} covered */
const judgeSays = covered => async (/** @type {string} */ prompt) => ({ verdicts: JSON.parse(String(prompt.match(/^\[\{"pair".*\]$/m)?.[0])).map((/** @type {{ pair: number }} */ p) => ({ pair: p.pair, covered, why: 'rollback is out of scope' })) })

test('a rule record reads with its derived id, kind rule and an optional lens; a lesson is still refused', () => {
  const [r] = rules({ lens: 'compat' })
  assert.equal(r?.id, ruleId)
  assert.equal(r?.kind, 'rule')
  assert.equal(r?.lens, 'compat')
  assert.equal(parsePriorDecisions([{ id: ruleId, title: 't', body: 'b', scope: 'x' }]).decisions[0]?.kind, 'rule', 'a rule passed without kind is read by its id prefix')
  assert.match(String(parsePriorDecisions([{ ...RULE, kind: 'lesson' }]).refused[0]), /is a "lesson" record, not a decision, a question or a rule/)
})

test('a rule without a scope is refused by name — never read as the whole repo', () => {
  const r = parsePriorDecisions([{ ...RULE, id: 'rule-0123456789', scope: '' }])
  assert.deepEqual(r.decisions, [])
  assert.match(String(r.refused[0]), /rule-0123456789\) is a project rule without a scope/)
  assert.match(String(parsePriorDecisions([{ ...RULE, scope: undefined }]).refused[0]), /project rule without a scope/)
})

test('candidates: the finding\'s file inside the rule\'s scope, and the rule\'s lens when it names one', () => {
  const [r] = rules()
  const [lensed] = rules({ lens: 'compat' })
  assert.ok(r && lensed)
  assert.ok(ruleCandidate(finding(), r))
  assert.ok(!ruleCandidate(finding({ file: 'crates/other/src/db.rs' }), r), 'outside the scope')
  assert.ok(ruleCandidate(finding(), lensed))
  assert.ok(!ruleCandidate(finding({ source: 'safety' }), lensed), 'another lens')
  assert.ok(ruleCandidate(finding({ source: 'safety', sources: ['safety', 'compat'] }), lensed), 'one of its lenses')
  assert.ok(!ruleCandidate(finding(), { ...r, kind: 'decision' }), 'a decision is no rule')
})

test('pairs: Critical and High last, the rule\'s body never in the judge\'s prompt', () => {
  const [r] = rules()
  assert.ok(r)
  const pairs = rulePairs([finding({ severity: 'Critical' }), finding({ severity: 'High' }), finding({ severity: 'Low' })], [r])
  assert.deepEqual(pairs.map(p => p.f.severity), ['Low', 'High', 'Critical'])
  const prompt = ruleJudgePrompt(pairs)
  assert.match(prompt, /exactly what the rule declares acceptable/)
  assert.match(prompt, /we do not support rollback/)
  assert.doesNotMatch(prompt, /deploys only go forward/)
})

test('apply: a covered finding leaves its tier with the rule and the judge\'s why; a Critical one is raised and named', async () => {
  const r = await applyProjectRules({ confirmed: [finding(), finding({ severity: 'Critical', line: 40 })] }, rules(), 'why', judgeSays(true))
  assert.equal(r.covered.length, 1)
  assert.equal(r.covered[0]?.priorDecision, ruleId)
  assert.equal(r.covered[0]?.priorKind, 'rule')
  assert.equal(r.covered[0]?.priorMatch, 'covered by judge: rollback is out of scope')
  assert.match(String(r.covered[0]?.why), /COVERED BY PROJECT RULE: we do not support rollback/)
  assert.deepEqual(r.tiers['confirmed']?.map(f => f.severity), ['Critical'])
  assert.match(String(r.tiers['confirmed']?.[0]?.why), /Raised under project rule/)
  assert.match(String(r.notices[0]), /^Critical "migration has no down step" @ crates\/node\/src\/db\.rs:40 RAISED/)
})

test('apply: the judge saying not covered, a dead judge, a missing verdict and a pair past the bound all leave the finding in the verdict', async () => {
  const no = await applyProjectRules({ confirmed: [finding()] }, rules(), 'why', judgeSays(false))
  assert.equal(no.covered.length, 0)
  assert.deepEqual(no.notices, [])
  const dead = await applyProjectRules({ confirmed: [finding()] }, rules(), 'why', async () => { throw new Error('x') })
  assert.equal(dead.tiers['confirmed']?.length, 1)
  assert.match(String(dead.notices[0]), /1 finding\(s\) in a project rule's scope NOT covered — the rule judge died or answered unreadably/)
  const none = await applyProjectRules({ confirmed: [finding()] }, rules())
  assert.match(String(none.notices[0]), /died or answered unreadably/, 'no judge at all is no verdict')
  const silent = await applyProjectRules({ confirmed: [finding()] }, rules(), 'why', async () => ({ verdicts: [] }))
  assert.match(String(silent.notices[0]), /the rule judge returned no verdict for it/)
  const many = Array.from({ length: RULE_JUDGE_PAIRS_MAX + 2 }, (_, i) => finding({ line: i + 1 }))
  const cut = await applyProjectRules({ confirmed: many }, rules(), 'why', judgeSays(true))
  assert.equal(cut.covered.length, RULE_JUDGE_PAIRS_MAX)
  assert.equal(cut.tiers['confirmed']?.length, 2)
  assert.match(String(cut.notices[0]), /2 finding\(s\)[^\n]*past the rule judge's bound of 40 pairs/)
})

test('apply: no rule, or no finding in a rule\'s scope, calls no judge', async () => {
  let calls = 0
  const judge = async () => { calls++; return null }
  const out = await applyProjectRules({ confirmed: [finding({ file: 'elsewhere.rs' })] }, rules(), 'why', judge)
  assert.equal(calls, 0)
  assert.deepEqual(out.notes, ['1 project rule(s) given, no finding in their scope'])
  assert.equal((await applyProjectRules({ confirmed: [finding()] }, [], 'why', judge)).rules, 0)
})

test('section: one line per covered finding with the rule id, its statement and the why; notices after; Rejected before never lists a rule', async () => {
  const r = await applyProjectRules({ confirmed: [finding()] }, rules(), 'why', judgeSays(true))
  const s = projectRuleSection(r.covered, ['a notice'])
  assert.ok(s.startsWith(`\n\n${PROJECT_RULE_HEADING}\n`))
  assert.match(s, new RegExp(`- Medium · \`crates/node/src/db\\.rs:12\` · migration has no down step · rule ${ruleId} "we do not support rollback" · covered by judge: rollback is out of scope\n- ⚠️ a notice`))
  assert.equal(projectRuleSection([], []), '')
  assert.equal(priorRejectedSection(r.covered), '')
})

test('the decisions\' split leaves a rule alone: it matches nothing and counts as no open question', async () => {
  const r = await applyPriorDecisions({ confirmed: [finding({ title: 'we do not support rollback' })] }, rules(), async () => ({ unchanged: [], missing: [] }))
  assert.equal(r.setAside.length, 0)
  assert.deepEqual(r.notes, [])
})

test('recall: rules come back in their own list, tagged and counted; the prompt asks for them and for craft_kind beside kind', () => {
  const r = readMemoryRecall({ backend: 'mcp', why: 'w', decisions: [], rules: [{ title: RULE.title, scope: RULE.scope, body: 'b' }] }, 0)
  assert.deepEqual(/** @type {any} */ (r.decisions[0]).kind, 'rule')
  assert.equal(r.memory.rules, 1)
  const accepted = acceptedMemory(r.memory, parsePriorDecisions(r.decisions).decisions)
  assert.equal(accepted.rules, 1)
  assert.equal(countedRecords(accepted), '0 decision(s) and 1 project rule(s)')
  assert.equal(memoryRecord({ ...accepted, covered: 2 }).covered, 2)
  const prompt = memoryRecallPrompt(['a.rs'], 'main')
  assert.match(prompt, /once for kind rule/)
  assert.match(prompt, /craft_kind, craft_id, craft_scope, craft_status/)
  assert.match(prompt, /search and filter by both, never by one alone/)
  assert.match(prompt, /\.craft\/memory\/rule\//)
})

test('tally: rules recalled count at the recall, findings covered on every run', () => {
  const t = newMemoryTally()
  tallyMemory(t, { memory: { source: 'recalled', count: 3, rules: 2, covered: 1, backend: 'repo', why: 'x' } })
  tallyMemory(t, { memory: { source: 'launcher', count: 3, rules: 2, covered: 2, why: '' } })
  assert.equal(t.rules, 2)
  assert.equal(t.covered, 3)
  assert.ok(renderMemorySection(t).includes('- project rules: 2 recalled · 3 finding(s) covered by one, out of the verdict'))
  assert.ok(!renderMemorySection(newMemoryTally()).some(l => l.includes('project rules')))
})

test('a rule another given record supersedes or answers covers nothing and calls no judge', async () => {
  let calls = 0
  const judge = async (/** @type {string} */ p) => { calls++; return judgeSays(true)(p) }
  const successor = { kind: 'decision', title: 'rollback is supported from now on', scope: 'crates/node', body: 'b', author: 'nick', links: [`supersedes: ${ruleId}`] }
  const records = parsePriorDecisions([RULE, successor]).decisions
  const r = await applyProjectRules({ confirmed: [finding()] }, records, 'why', judge)
  assert.equal(calls, 0)
  assert.equal(r.covered.length, 0)
  assert.equal(r.rules, 0)
  assert.match(String(r.notes[0]), new RegExp(`1 project rule\\(s\\) superseded by another given record — not applied: ${ruleId}`))
})
