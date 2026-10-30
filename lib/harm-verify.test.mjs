// Severity raised by a verified harm, not by the number of lenses (realm @nick/craft, node #407):
// unit, and executed through the review engine on the shape of the missed #1388 finding.
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { runEngine, filedRecord } from './engine-harness.mjs'
import { claimsOf, panelHarm, harmRaise, mayBeMustFix, harmVerifyLine, HARM_RAISE_MARK } from './harm-verify.mjs'
import { decideTier } from './review-verify.mjs'

const RULE = { file: 'AGENTS.md', text: 'Errors are typed: no String payloads in error variants.' }
const UPHELD = { refuted: false, citedLineMatches: true, reachable: true, premiseSupported: true, reason: 'ok' }
const CLAIMS = { harmClaims: [{ harmLevel: 'self-healing', harm: 'heals on sync' }, { harmLevel: 'intent-unmet', harm: 'the fast restore never fires' }] }

test('claimsOf and harmVerifyLine: distinct claims worst first, unknown levels dropped', () => {
  assert.deepEqual(claimsOf({ ...CLAIMS, harmClaims: [...CLAIMS.harmClaims, { harmLevel: 'made-up' }] }).map(c => c.harmLevel), ['intent-unmet', 'self-healing'])
  assert.deepEqual(claimsOf({ harmLevel: 'text' }), [{ harmLevel: 'text' }])
  assert.match(harmVerifyLine(CLAIMS), /harm claimed \(worst first[^)]*\): intent-unmet: the fast restore never fires \| self-healing: heals on sync$/)
  assert.equal(harmVerifyLine({}), '')
})

test('panelHarm: the worst claim a majority backs; a vote naming an unlisted level backs nothing', () => {
  const yes = { harmSupported: true }
  assert.equal(panelHarm(CLAIMS, [yes, yes, { harmSupported: false }]), 'intent-unmet')
  assert.equal(panelHarm(CLAIMS, [{ harmSupported: true, confirmedHarmLevel: 'self-healing' }, yes]), 'self-healing')
  assert.equal(panelHarm(CLAIMS, [{ harmSupported: false }, {}]), undefined)
  assert.equal(panelHarm(CLAIMS, [{ harmSupported: true, confirmedHarmLevel: 'data-loss' }]), undefined)
  assert.equal(panelHarm({}, [yes]), undefined)
})

test('decideTier: a verified harm only on a confirmed finding no demotion touched', () => {
  const f = { severity: 'Medium', why: 'w', harmLevel: 'intent-unmet' }
  assert.equal(decideTier(f, [1], [{ ...UPHELD, harmSupported: true }])['harmVerified'], 'intent-unmet')
  const demoted = decideTier(f, [1], [{ ...UPHELD, reachable: false, harmSupported: true }])
  assert.equal(demoted.severity, 'Low')
  assert.equal(demoted['harmVerified'], undefined)
  assert.equal(harmRaise(demoted), demoted, 'reachability lowering wins over the raise')
})

test('harmRaise: a confirmed finding with a verified must-fix harm goes to High, nothing else does', () => {
  const f = { severity: 'Low', tier: 'confirmed', why: 'w', harmLevel: 'self-healing', harmVerified: 'intent-unmet', ...CLAIMS }
  const g = harmRaise(f)
  assert.equal(g.severity, 'High')
  assert.equal(g.harmLevel, 'intent-unmet')
  assert.equal(/** @type {any} */ (g).harm, 'the fast restore never fires')
  assert.ok(g.why.includes(HARM_RAISE_MARK))
  for (const over of [{ tier: 'suspected' }, { harmVerified: undefined }, { harmVerified: 'data-loss' }]) {
    const h = { ...f, ...over }
    assert.equal(harmRaise(h), h, JSON.stringify(over))
  }
  assert.equal(harmRaise({ ...f, severity: 'High' }).severity, 'High')
  const lesser = harmRaise({ ...f, harmLevel: 'intent-unmet', harmVerified: 'self-healing' })
  assert.deepEqual([lesser.severity, lesser.harmLevel], ['Low', 'self-healing'], 'a verified lesser harm is what the cap reads')
  const rule = { harmClaims: [{ harmLevel: 'repo-rule', repoRule: RULE }, { harmLevel: 'self-healing' }] }
  const raised = /** @type {Record<string, unknown>} */ (harmRaise({ ...f, ...rule, harmVerified: 'repo-rule' }))
  assert.deepEqual([raised['severity'], raised['repoRule']], ['High', RULE], 'a cited rule from another copy travels with its claim')
  assert.equal(harmRaise({ ...f, harmClaims: [{ harmLevel: 'repo-rule' }], harmVerified: 'repo-rule' }).severity, 'Low')
  assert.equal(mayBeMustFix(rule), true)
  assert.equal(mayBeMustFix(CLAIMS), true)
  assert.equal(mayBeMustFix({ harmLevel: 'self-healing' }), false)
  assert.equal(mayBeMustFix({ harmLevel: 'repo-rule' }), false, 'an uncited repo rule is not must-fix')
})

const FILE = 'src/billing.rs'
/** @param {string[]} lenses @param {(lens: string) => Record<string, unknown>[]} findingsOf @param {Record<string, unknown>} [vote] @param {Record<string, unknown>} [args] */
async function review(lenses, findingsOf, vote = {}, args = {}) {
  const v = { ...UPHELD, ...vote }
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
    verify: v,
    'verify-batch': (/** @type {{ prompt: string }} */ { prompt }) => ({ verdicts: [...prompt.matchAll(/--- FINDING (\d+) ---/g)].map(m => ({ index: Number(m[1]), ...v })) }),
    synthesis: null,
    '*': null,
  }
  const run = await runEngine('review', { args, script })
  const rec = filedRecord(run)
  return { run, rec, row: (rec.ledger || []).find((/** @type {any} */ r) => r.file === FILE) }
}
/** @param {string} source @param {Record<string, unknown>} over */
const finding = (source, over) => ({ severity: 'Low', title: 'recheck baseline counts the grant twice so the fast restore never fires', file: FILE, line: 42, why: 'w', fix: 'f', blastRadius: '', source, ruleId: '', whereChecked: '', harm: 'the account recovers only on the periodic sync, as before the change', ...over })
const verified = (/** @type {any} */ run) => run.calls.some((/** @type {any} */ c) => /^verify/.test(String(c.label)))

// Exact copies (folded by the pool's key) and reworded ones (folded by the same-spot dedup, one lens
// naming the must-fix harm the others missed) both make an agreement.
const SHAPES = {
  'exact copies': (/** @type {string} */ l) => [finding(l, { harmLevel: 'intent-unmet' })],
  'reworded copies': (/** @type {string} */ l) => [finding(l, l === 'errors' ? { harmLevel: 'intent-unmet' } : { harmLevel: 'self-healing', title: `recheck baseline counts the grant twice so the fast restore never fires (${l})` })],
}
for (const depth of ['', 'light']) {
  for (const [shape, findingsOf] of Object.entries(SHAPES)) {
    test(`review${depth ? ' (light pass)' : ''}, ${shape}: three lenses at Low with intent-unmet, the verifier confirms the harm → High → Block; it does not → not raised`, async () => {
      const args = depth ? { depth } : {}
      const yes = await review(['intent', 'errors', 'invariants'], findingsOf, { harmSupported: true }, args)
      assert.ok(verified(yes.run), 'agreement on a must-fix claim buys a verifier')
      assert.ok(String(yes.run.calls.find((/** @type {any} */ c) => /^verify/.test(String(c.label)))?.prompt).includes('harm claimed (worst first'))
      assert.equal(yes.row?.tier, 'confirmed')
      assert.equal(yes.row?.severity, 'High')
      assert.match(String(yes.rec.verdict), /Block/)
      if (shape === 'reworded copies') assert.ok(yes.rec.dedupComponents?.largest >= 2, JSON.stringify(yes.rec.dedupComponents))
      const no = await review(['intent', 'errors', 'invariants'], findingsOf, { harmSupported: false }, args)
      assert.equal(no.row?.tier, 'confirmed')
      assert.equal(no.row?.severity, 'Low')
      assert.doesNotMatch(String(no.rec.verdict), /Block|Warning/)
    })
  }
}

test('review: two lenses on an intent-unmet Medium, reach-demoted to Low, stay Low and do not block', async () => {
  const { row, rec } = await review(['intent', 'errors'], l => [finding(l, { severity: 'Medium', harmLevel: 'intent-unmet' })], { reachable: false, harmSupported: true })
  assert.equal(row?.severity, 'Low')
  assert.doesNotMatch(String(rec.verdict), /Block/)
})

// The base copy carries its own severity and claim; a worse claim from another copy the verifier
// rejects is never what the cap reads.
for (const { base, capped } of [{ base: { severity: 'Medium', harmLevel: 'self-healing' }, capped: 'Low' }, { base: { severity: 'High', harmLevel: 'operator-recovery' }, capped: 'Medium' }]) {
  test(`review: a ${base.severity}/${base.harmLevel} copy merged with a Low/data-loss copy, harm rejected, is capped at ${capped}`, async () => {
    const { row, rec } = await review(['errors', 'intent'], l => [finding(l, l === 'errors' ? base : { harmLevel: 'data-loss', title: 'recheck baseline counts the grant twice so the fast restore never fires (intent)' })], { harmSupported: false })
    assert.equal(row?.severity, capped, JSON.stringify(row))
    assert.doesNotMatch(String(rec.verdict), /Block/)
  })
}

test('review: agreement on a harm that cannot be must-fix, or one lens alone, buys no verifier', async () => {
  assert.ok(!verified((await review(['intent', 'errors'], l => [finding(l, { harmLevel: 'self-healing' })])).run))
  const one = await review(['intent'], () => [finding('intent', { harmLevel: 'intent-unmet' })])
  assert.ok(!verified(one.run))
  assert.equal(one.row?.tier, 'unverified')
})

/** @param {Record<string, unknown>} over */
const typedErr = over => ({ ...finding('errors', { severity: 'High', title: 'move_draft_default_locked returns Conflict(String) with free text', line: 7, harm: 'callers cannot match on the conflict', harmLevel: 'repo-rule' }), ...over })

test('review: a repo-rule finding citing its AGENTS.md rule stays must-fix, the verifier sent to the rule; uncited it is capped at Low', async () => {
  const cited = await review(['errors'], () => [typedErr({ repoRule: RULE })])
  assert.equal(cited.row?.severity, 'High')
  assert.match(String(cited.rec.verdict), /Block/)
  assert.ok(cited.run.calls.some((/** @type {any} */ c) => /^verify/.test(String(c.label)) && String(c.prompt).includes('OPEN AGENTS.md and check')))
  const bare = await review(['errors'], () => [typedErr({})])
  assert.equal(bare.row?.severity, 'Low')
  assert.match(bare.row.why, /repo-rule citing no rule file and text/)
  assert.doesNotMatch(String(bare.rec.verdict), /Block|Warning/)
})
