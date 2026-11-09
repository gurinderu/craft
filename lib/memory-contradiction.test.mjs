// A finding going against an active memory record (lib/memory-contradiction.mjs; realm @nick/craft, node #282):
// the decision and rule judges mark it, the sorting sends a confirmed one to the defects before the intent
// signs and an unconfirmed one to the reviewer (node #423), and the run record counts it with the signs
// that alone would have sent it to the reviewer.
import { test } from 'vitest'
import assert from 'node:assert/strict'

import { contradictionOf } from './finding-sort.mjs'
import { markContradicting } from './memory-contradiction.mjs'
import { applyPriorDecisions } from './prior-decision-apply.mjs'
import { applyProjectRules } from './project-rule-apply.mjs'
/** @param {Record<string, unknown>} [over] @returns {any} */
const f = (over = {}) => ({ severity: 'Medium', title: 'retries are unbounded', why: 'a dead peer spins forever', file: 'src/a.rs', line: 12, tier: 'confirmed', source: 'errors', ...over })
/** @type {any} */
const DECISION = { id: 'decision-cap', kind: 'decision', title: 'retries stay capped at three', scope: 'src/a.rs', reason: 'REASON', who: 'n', when: '2026-10-01', link: '', commit: 'abc1234', supersedes: [], line: 30, lens: 'errors' }
const MARK = { id: 'decision-cap', kind: 'decision', why: 'the cap is gone' }

test('markContradicting: marks with the record id, kind and a one-line why; the first mark stands', () => {
  const marked = markContradicting(f(), { d: DECISION, why: 'the cap\n is gone' })
  assert.deepEqual(contradictionOf(marked), MARK)
  assert.equal(markContradicting(f(), undefined).memoryContradicts, undefined)
  const again = markContradicting(marked, { d: { id: 'rule-x', kind: 'rule' }, why: 'other' })
  assert.equal(contradictionOf(again)?.id, 'decision-cap')
  assert.equal(contradictionOf(f({ memoryContradicts: { kind: 'rule' } })), null, 'a mark without an id is no mark')
})

test('applyPriorDecisions: a kept finding the judge says goes against a decision is marked; the reason never reaches the judge', async () => {
  const prompts = /** @type {string[]} */ ([])
  const r = await applyPriorDecisions({ confirmed: [f()] }, [DECISION], async () => ({ unchanged: [DECISION.id], missing: [], reason: '' }), 'why',
    async p => { prompts.push(p); return { verdicts: [{ pair: 0, same: false, violates: true, why: 'the cap is gone' }] } })
  assert.equal(r.setAside.length, 0)
  assert.deepEqual(contradictionOf(/** @type {any} */ (r.tiers['confirmed']?.[0])), MARK)
  assert.equal(prompts.length, 1, 'one judge call')
  assert.ok(!prompts[0]?.includes('REASON'))
})

test('applyProjectRules: a finding the rule judge says goes against a rule stays in the verdict, marked; covered wins nothing it did not say', async () => {
  const rule = { id: 'rule-validate', kind: 'rule', title: 'every handler validates its input', scope: 'src', reason: '', who: '', when: '', link: '', commit: '', supersedes: [] }
  const r = await applyProjectRules({ confirmed: [f(), f({ line: 13, title: 'no validation on the body' })] }, /** @type {any} */ ([rule]), 'why',
    async () => ({ verdicts: [{ pair: 0, covered: false, why: 'unrelated' }, { pair: 1, covered: true, violates: true, why: 'the body is read unchecked' }] }))
  assert.equal(r.covered.length, 0, 'violates wins over covered')
  const kept = /** @type {any[]} */ (r.tiers['confirmed'])
  assert.equal(contradictionOf(kept[0]), null)
  assert.deepEqual(contradictionOf(kept[1]), { id: 'rule-validate', kind: 'rule', why: 'the body is read unchecked' })
  assert.match(r.notes.join('\n'), /1 showing the code against a rule/)
})
