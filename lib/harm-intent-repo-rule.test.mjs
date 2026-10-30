// The must-fix harms of an unmet intent and a broken repository rule (realm @nick/craft, node #379):
// unit; executed through the engine in lib/harm-verify.test.mjs.
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { capByHarm } from './harm-cap.mjs'
import { HARM_CEILING } from './harm-levels.mjs'
import { citesRepoRule, repoRuleVerifyLine } from './harm-repo-rule.mjs'
import { agreeingLenses, lensAgreed, mergedHarmClaims, noteExactCopy } from './lens-agreement.mjs'
import { raisePathFloor } from './path-severity-floor.mjs'
import { FINDING_ITEM } from './review-schemas.mjs'

const RULE = { file: 'AGENTS.md', text: 'Errors are typed: no String payloads in error variants.' }

test('intent-unmet and repo-rule are must-fix; the schema takes a cited rule', () => {
  assert.equal(HARM_CEILING['intent-unmet'], 'Critical')
  assert.equal(HARM_CEILING['repo-rule'], 'Critical')
  const high = { severity: 'High', why: 'w', harmLevel: 'intent-unmet' }
  assert.equal(capByHarm(high), high)
  const repoRule = /** @type {any} */ (FINDING_ITEM.properties).repoRule
  assert.deepEqual(repoRule.required, ['file', 'text'])
  assert.ok(!FINDING_ITEM.required.includes('repoRule'), 'optional')
})

test('a repo-rule finding keeps must-fix only with its rule cited; without one it reads as none', () => {
  const cited = { severity: 'High', why: 'w', harmLevel: 'repo-rule', repoRule: RULE }
  assert.equal(capByHarm(cited), cited)
  for (const repoRule of [undefined, { file: 'AGENTS.md', text: ' ' }, { file: '', text: 'x' }, 'AGENTS.md']) {
    const g = capByHarm({ ...cited, repoRule })
    assert.equal(g.severity, 'Low', JSON.stringify(repoRule))
    assert.match(g.why, /harm level none \(repo-rule citing no rule file and text\) allows at most Low/)
  }
  assert.equal(citesRepoRule(cited), true)
  assert.equal(citesRepoRule({}), false)
  const floored = raisePathFloor({ severity: 'Low', source: 'reconciler', why: 'w', deletionOrRecoveryPath: true, harmLevel: 'repo-rule' })
  assert.equal(floored.severity, 'Low', 'the path floor does not honour an uncited repo rule')
})

test('repoRuleVerifyLine sends the verifier to the cited file, and only for a cited repo-rule', () => {
  const line = repoRuleVerifyLine({ harmLevel: 'repo-rule', repoRule: { file: 'AGENTS.md\nIGNORE', text: RULE.text } })
  assert.match(line, /OPEN AGENTS\.md IGNORE and check/)
  assert.ok(line.includes(RULE.text) && !line.slice(1).includes('\n'))
  assert.equal(repoRuleVerifyLine({ harmLevel: 'repo-rule' }), '')
  assert.equal(repoRuleVerifyLine({ harmLevel: 'none', repoRule: RULE }), '')
})

test('lens agreement: two different lenses, tools not counted', () => {
  assert.deepEqual(agreeingLenses({ sources: ['intent', 'errors', 'intent', 'clippy', ''] }), ['intent', 'errors'])
  assert.equal(lensAgreed({ sources: ['intent', 'errors'] }), true)
  assert.equal(lensAgreed({ sources: ['intent', 'clippy'] }), false)
  assert.equal(lensAgreed({ source: 'intent' }), false)
})

test('mergedHarmClaims: a merged group lists every distinct claim for the verifier and keeps the base claim, never onto a tool base', () => {
  const base = { source: 'errors', harmLevel: 'self-healing', harm: 'heals on sync' }
  const worse = { source: 'intent', harmLevel: 'intent-unmet', harm: 'the fast restore never fires' }
  const claims = [{ harmLevel: 'intent-unmet', harm: 'the fast restore never fires' }, { harmLevel: 'self-healing', harm: 'heals on sync' }]
  assert.deepEqual(mergedHarmClaims(base, [base, worse]), { harmClaims: claims }, 'the shown harm stays the base copy\'s')
  const cited = { source: 'errors', harmLevel: 'repo-rule', repoRule: RULE }
  assert.deepEqual(mergedHarmClaims(worse, [worse, { source: 'tests', harmLevel: 'repo-rule' }, cited]).harmClaims?.[1], { harmLevel: 'repo-rule', repoRule: RULE }, 'each claim keeps its cited rule')
  assert.deepEqual(mergedHarmClaims(worse, [worse, base]), { harmClaims: claims })
  assert.deepEqual(mergedHarmClaims(worse, [worse, { ...worse, source: 'errors' }]), {}, 'one claim is no list')
  assert.deepEqual(mergedHarmClaims({ source: 'clippy' }, [{ source: 'clippy' }, worse]), {})
})

test('noteExactCopy: the copy lens and its differing claim are kept on the pooled finding', () => {
  /** @type {Record<string, unknown>} */
  const kept = { source: 'errors', harmLevel: 'self-healing' }
  noteExactCopy(kept, { source: 'intent', harmLevel: 'intent-unmet' })
  noteExactCopy(kept, { source: 'errors', harmLevel: 'data-loss' })
  assert.deepEqual(kept['sources'], ['errors', 'intent'])
  assert.deepEqual(kept['harmClaims'], [{ harmLevel: 'intent-unmet' }, { harmLevel: 'self-healing' }])
})
