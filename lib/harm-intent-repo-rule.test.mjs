// The must-fix harms of an unmet intent and a broken repository rule, and multi-lens agreement
// (realm @nick/craft, node #379): unit, and executed through the review engine.
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { runEngine, filedRecord } from './engine-harness.mjs'
import { capByHarm } from './harm-cap.mjs'
import { HARM_CEILING } from './harm-levels.mjs'
import { citesRepoRule, repoRuleVerifyLine } from './harm-repo-rule.mjs'
import { agreeingLenses, lensAgreed, agreementRaise, worstHarmOf, LENS_AGREEMENT_MARK } from './lens-agreement.mjs'
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

test('agreementRaise: a confirmed agreed finding under a must-fix harm is raised to High, nothing else is', () => {
  const f = { severity: 'Low', tier: 'confirmed', why: 'w', harmLevel: 'intent-unmet', sources: ['intent', 'errors'] }
  const g = agreementRaise(f)
  assert.equal(g.severity, 'High')
  assert.ok(g.why.includes(LENS_AGREEMENT_MARK) && g.why.includes('intent, errors'))
  for (const over of [{ tier: 'suspected' }, { tier: 'unverified' }, { severity: 'High' }, { harmLevel: 'self-healing' }, { harmLevel: 'operator-recovery' }, { sources: ['intent'] }, { harmLevel: 'repo-rule' }]) {
    const h = { ...f, ...over }
    assert.equal(agreementRaise(h), h, JSON.stringify(over))
  }
  assert.equal(agreementRaise({ ...f, harmLevel: 'repo-rule', repoRule: RULE }).severity, 'High')
})

test('worstHarmOf: a merged group carries the worst harm any lens named, never onto a tool base', () => {
  const base = { source: 'errors', harmLevel: 'self-healing', harm: 'heals on sync' }
  const worse = { source: 'intent', harmLevel: 'intent-unmet', harm: 'the fast restore never fires' }
  assert.deepEqual(worstHarmOf(base, [base, worse]), { harmLevel: 'intent-unmet', harm: 'the fast restore never fires' })
  assert.deepEqual(worstHarmOf(worse, [worse, base]), {})
  assert.deepEqual(worstHarmOf({ source: 'clippy' }, [{ source: 'clippy' }, worse]), {})
  assert.deepEqual(worstHarmOf(base, [base, { source: 'intent', harmLevel: 'repo-rule' }]), {}, 'an uncited repo rule reads as none')
})

const UPHELD = { refuted: false, citedLineMatches: true, reachable: true, premiseSupported: true, reason: 'ok' }
const FILE = 'src/billing.rs'

/** @param {string[]} lenses @param {(lens: string) => Record<string, unknown>[]} findingsOf @param {Record<string, unknown>} [args] */
async function review(lenses, findingsOf, args = {}) {
  const script = {
    detect: { baseRef: 'main', files: [FILE], spec: 'restore the grant at once on recheck', branch: 'feat/x', head: 'abc1234' },
    'prior-round': { found: false, round: 0, head: '', ledger: [], ledgerCount: 0, priorFindings: 0, reason: 'none' },
    checkpoint: { runDir: '/store/.partial/run-A', error: '' },
    'log-run': { ok: true, error: '' },
    scout: { sizeBucket: 'small', lenses, isLibrary: false, securitySensitive: false, intent: 'fast grant restore', churn: [], notes: 'x' },
    gate: { status: 'pass', provenance: 'CI', failedChecks: [], carriedChecks: [], seedFindings: [], notes: '' },
    lens: (/** @type {{ opts: { label: string } }} */ { opts }) => {
      const lens = lenses.find(l => String(opts.label).startsWith(`lens:rust:${l} `) && !/resurrect/.test(opts.label))
      return { lens: lens ?? '', findings: lens ? findingsOf(lens) : [] }
    },
    dedup: { groups: [] },
    verify: UPHELD,
    'verify-batch': (/** @type {{ prompt: string }} */ { prompt }) => ({ verdicts: [...prompt.matchAll(/--- FINDING (\d+) ---/g)].map(m => ({ index: Number(m[1]), ...UPHELD })) }),
    synthesis: null,
    '*': null,
  }
  const run = await runEngine('review', { args, script })
  const rec = filedRecord(run)
  return { run, rec, row: (rec.ledger || []).find((/** @type {any} */ r) => r.file === FILE) }
}

/** @param {string} source @param {Record<string, unknown>} over */
const finding = (source, over) => ({ severity: 'Low', title: 'recheck baseline counts the grant twice so the fast restore never fires', file: FILE, line: 42, why: 'w', fix: 'f', blastRadius: '', source, ruleId: '', whereChecked: '', harm: 'the account recovers only on the periodic sync, as before the change', ...over })

// Exact copies (one title, folded by the pool's key) and reworded copies (folded by the same-spot
// dedup, one lens naming the must-fix harm the others missed) both make an agreement.
const SHAPES = {
  'exact copies': (/** @type {string} */ l) => [finding(l, { harmLevel: 'intent-unmet' })],
  'reworded copies': (/** @type {string} */ l) => [finding(l, l === 'errors'
    ? { harmLevel: 'intent-unmet' }
    : { harmLevel: 'self-healing', title: `recheck baseline counts the grant twice so the fast restore never fires (${l})` })],
}
for (const depth of ['', 'light']) {
  for (const [shape, findingsOf] of Object.entries(SHAPES)) {
    test(`review${depth ? ' (light pass)' : ''}, ${shape}: three lenses on one site at Low with intent-unmet are verified, raised to High and block`, async () => {
      const { run, rec, row } = await review(['intent', 'errors', 'invariants'], findingsOf, depth ? { depth } : {})
      assert.ok(run.calls.some(c => /^verify/.test(String(c.label))), 'the merged Low was sent to verification')
      assert.ok(row, `the finding must reach the ledger: ${JSON.stringify(rec.ledger)}`)
      assert.equal(row.tier, 'confirmed')
      assert.equal(row.severity, 'High')
      assert.match(row.why, /multi-lens agreement/)
      assert.match(String(rec.verdict), /Block/, `the verdict counts it as High: ${rec.verdict}`)
    })
  }
}

test('review: one lens at Low with intent-unmet is still not verified (agreement is what buys the verifier)', async () => {
  const { run, row } = await review(['intent'], () => [finding('intent', { harmLevel: 'intent-unmet' })])
  assert.ok(!run.calls.some(c => /^verify/.test(String(c.label))))
  assert.equal(row?.tier, 'unverified')
})

/** @param {Record<string, unknown>} over */
const typedErr = over => ({ severity: 'High', title: 'move_draft_default_locked returns Conflict(String) with free text', file: FILE, line: 7, why: 'w', fix: 'f', blastRadius: '', source: 'errors', ruleId: '', whereChecked: '', harm: 'callers cannot match on the conflict', harmLevel: 'repo-rule', ...over })

test('review: a repo-rule finding citing its AGENTS.md rule stays must-fix and the verifier is sent to the rule', async () => {
  const { run, rec, row } = await review(['errors'], () => [typedErr({ repoRule: RULE })])
  assert.equal(row?.severity, 'High')
  assert.match(String(rec.verdict), /Block/)
  assert.ok(run.calls.some(c => /^verify/.test(String(c.label)) && String(c.prompt).includes('OPEN AGENTS.md and check')))
})

test('review: the same repo-rule finding with no rule cited is capped at Low', async () => {
  const { rec, row } = await review(['errors'], () => [typedErr({})])
  assert.equal(row?.severity, 'Low')
  assert.match(row.why, /repo-rule citing no rule file and text/)
  assert.doesNotMatch(String(rec.verdict), /Block|Warning/)
})
