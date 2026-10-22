// The deletion/recovery-path severity floor, unit and executed. A reconciler or failure-windows
// finding flagged `deletionOrRecoveryPath` below Medium is raised to Medium before verification
// routing, so a verifier judges it and the verdict counts it; the same finding unflagged, or flagged
// by another lens, keeps its Low and is never verified.
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { runEngine, filedRecord } from './engine-harness.mjs'
import { raisePathFloor, applyPathFloor } from './path-severity-floor.mjs'

test('raisePathFloor: only a flagged Low/Info from a catalogue lens is raised', () => {
  const base = { severity: 'Low', source: 'reconciler', why: 'w', deletionOrRecoveryPath: true }
  const raised = raisePathFloor(base)
  assert.equal(raised.severity, 'Medium')
  assert.match(raised.why, /^w \(raised to Medium from Low: deletion\/recovery-path floor/)
  assert.equal(raisePathFloor({ ...base, source: 'failure-windows', severity: 'Info' }).severity, 'Medium')
  for (const f of [{ ...base, deletionOrRecoveryPath: false }, { severity: 'Low', source: 'reconciler', why: 'w' }, { ...base, source: 'safety' }, { ...base, severity: 'Medium' }, { ...base, severity: 'High' }]) {
    assert.equal(raisePathFloor(f), f, JSON.stringify(f))
  }
  assert.deepEqual(applyPathFloor([base]).map(f => f.severity), ['Medium'])
})

const UPHELD = { refuted: false, citedLineMatches: true, reachable: true, premiseSupported: true, reason: 'ok' }

/** @param {string[]} lenses @param {string} fromLens @param {Record<string, unknown>} over */
function scriptFor(lenses, fromLens, over) {
  const finding = { severity: 'Low', title: 'finalizer removed before teardown', file: 'src/controller.rs', line: 3, why: 'w', fix: 'f', blastRadius: '', source: '', ruleId: '', whereChecked: '', ...over }
  return {
    detect: { baseRef: 'main', files: ['src/controller.rs'], spec: '', branch: 'feat/x', head: 'abc1234' },
    'prior-round': { found: false, round: 0, head: '', ledger: [], ledgerCount: 0, priorFindings: 0, reason: 'none' },
    checkpoint: { runDir: '/store/.partial/run-A', error: '' },
    'log-run': { ok: true, error: '' },
    scout: { sizeBucket: 'small', lenses, isLibrary: false, securitySensitive: false, intent: 'controller change', churn: [], notes: 'x' },
    gate: { status: 'pass', provenance: 'CI', failedChecks: [], carriedChecks: [], seedFindings: [], notes: '' },
    lens: (/** @type {{ opts: { label: string }, callIndex: number }} */ { opts }) => ({
      lens: fromLens,
      findings: String(opts.label).startsWith(`lens:rust:${fromLens}`) && !/resurrect/.test(opts.label) ? [finding] : [],
    }),
    dedup: { groups: [] },
    verify: UPHELD,
    'verify-batch': (/** @type {{ prompt: string }} */ { prompt }) => ({ verdicts: [...prompt.matchAll(/--- FINDING (\d+) ---/g)].map(m => ({ index: Number(m[1]), ...UPHELD })) }),
    synthesis: null,
    '*': null,
  }
}

/** @param {import('./engine-harness.mjs').Call[]} calls */
const verifierCalls = calls => calls.filter(c => /^verify(-batch)?:/.test(String(c.label)))

/** @param {any} rec */
const rowOf = rec => (rec.ledger || []).find((/** @type {any} */ r) => r.file === 'src/controller.rs')

test('review: a flagged Low reconciler finding is raised to Medium, verified, and moves the verdict', async () => {
  const run = await runEngine('review', { args: {}, script: scriptFor(['reconciler'], 'reconciler', { deletionOrRecoveryPath: true }) })
  assert.ok(verifierCalls(run.calls).length > 0, 'the raised finding must be dispatched to a verifier')
  const rec = filedRecord(run)
  const row = rowOf(rec)
  assert.ok(row, `the finding must reach the ledger: ${JSON.stringify(rec.ledger)}`)
  assert.equal(row.severity, 'Medium')
  assert.equal(row.tier, 'confirmed')
  assert.match(row.why, /raised to Medium from Low: deletion\/recovery-path floor/)
  assert.match(String(rec.verdict), /Warning/, `verdict was ${rec.verdict}`)
  const lens = run.calls.find(c => String(c.label).startsWith('lens:rust:reconciler'))
  assert.match(lens?.prompt ?? '', /every class R1.R20/, 'the reconciler lens is told the catalogue runs to R20')
  assert.match(lens?.prompt ?? '', /DELETION\/RECOVERY FLAG/, 'and when to set the flag')
})

for (const [name, lenses, fromLens, over] of /** @type {[string, string[], string, Record<string, unknown>][]} */ ([
  ['unflagged', ['reconciler'], 'reconciler', {}],
  ['flagged by another lens', ['safety'], 'safety', { deletionOrRecoveryPath: true }],
])) {
  test(`review: a Low reconciler-shaped finding ${name} stays Low and unverified`, async () => {
    const run = await runEngine('review', { args: {}, script: scriptFor(lenses, fromLens, over) })
    assert.equal(verifierCalls(run.calls).length, 0, 'a Low is never sent to a verifier')
    const row = rowOf(filedRecord(run))
    assert.ok(row, 'the finding must still be recorded')
    assert.equal(row.severity, 'Low')
    assert.equal(row.tier, 'unverified')
  })
}

// A critic follow-up: the plan is large (the critic is in scope) and runs only safety, whose one
// Medium finding gets the run to Synthesize; the critic then names `followup`, and only that
// dispatch answers the flagged Low, claiming `claimed` as its source.
/** @param {string} followup @param {string} claimed */
function criticScript(followup, claimed) {
  const lead = { severity: 'Medium', title: 'unrelated lead', file: 'src/other.rs', line: 9, why: 'w', fix: 'f', blastRadius: '', source: 'safety', ruleId: '', whereChecked: '' }
  const flagged = { severity: 'Low', title: 'finalizer removed before teardown', file: 'src/controller.rs', line: 3, why: 'w', fix: 'f', blastRadius: '', source: claimed, ruleId: '', whereChecked: '', deletionOrRecoveryPath: true }
  return {
    ...scriptFor(['safety'], 'safety', {}),
    scout: { sizeBucket: 'large', lenses: ['safety'], isLibrary: false, securitySensitive: false, intent: 'controller change', churn: [], notes: 'x' },
    lens: (/** @type {{ opts: { label: string }, callIndex: number }} */ { opts, callIndex }) => {
      const label = String(opts.label)
      if (label.startsWith(`lens:rust:${followup}`) && / \(critic\)/.test(label)) return { lens: claimed, findings: [flagged] }
      return { lens: 'safety', findings: label.startsWith('lens:rust:safety') && callIndex === 0 ? [lead] : [] }
    },
    critic: { missingLenses: [followup], notes: 'coverage thin' },
  }
}

/** @param {import('./engine-harness.mjs').Call[]} calls @param {string} lens */
const followedUp = (calls, lens) => calls.some(c => String(c.label).startsWith(`lens:rust:${lens}`) && / \(critic\)/.test(String(c.label)))

test('review: a critic-named reconciler follow-up is stamped with its dispatched lens, raised and verified', async () => {
  // The model labels its own source wrongly; the engine's stamp is what the floor reads.
  const run = await runEngine('review', { args: {}, script: criticScript('reconciler', 'rust:reconciler') })
  assert.ok(followedUp(run.calls, 'reconciler'), 'premise: the follow-up was dispatched')
  const row = rowOf(filedRecord(run))
  assert.ok(row, 'the follow-up finding must reach the ledger')
  assert.equal(row.severity, 'Medium')
  assert.equal(row.tier, 'confirmed')
  assert.equal(row.source, 'reconciler')
})

test('review: a non-reconciler follow-up claiming source "reconciler" is not raised', async () => {
  const run = await runEngine('review', { args: {}, script: criticScript('maintainability', 'reconciler') })
  assert.ok(followedUp(run.calls, 'maintainability'), 'premise: the follow-up was dispatched')
  const row = rowOf(filedRecord(run))
  assert.ok(row, 'the follow-up finding must still be recorded')
  assert.equal(row.severity, 'Low')
  assert.equal(row.tier, 'unverified')
  assert.equal(row.source, 'maintainability')
})

test('review: a floored Medium merged with a same-spot Low tool finding keeps Medium and the floor note', async () => {
  const tool = { severity: 'Low', title: 'finalizer removed before teardown here', file: 'src/controller.rs', line: 3, why: 'clippy says so', fix: 'f', blastRadius: '', source: 'clippy', ruleId: '', whereChecked: '' }
  const script = {
    ...scriptFor(['reconciler'], 'reconciler', { deletionOrRecoveryPath: true }),
    gate: { status: 'pass', provenance: 'CI', failedChecks: [], carriedChecks: [], seedFindings: [tool], notes: '' },
  }
  const run = await runEngine('review', { args: {}, script })
  const row = rowOf(filedRecord(run))
  assert.ok(row, 'the merged finding must reach the ledger')
  assert.equal(row.severity, 'Medium', JSON.stringify(row))
  assert.match(row.why, /^clippy says so \(raised to Medium from Low: deletion\/recovery-path floor/, 'the tool base keeps its why and gains the floor note')
  assert.match(row.why, /same defect also reported by: reconciler/, 'and credits the merged lens')
  const synth = run.calls.find(c => c.label === 'synthesis')
  assert.match(synth?.prompt ?? '', /is never calibrated below Medium in the report/, 'synthesis is told not to calibrate it back down')
})
