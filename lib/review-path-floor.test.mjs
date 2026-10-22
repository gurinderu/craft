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
