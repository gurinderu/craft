// Budget exhaustion, executed end to end.
//
// The sandbox's agent() THROWS in exactly one case — the run's budget is exhausted — and the
// engines lean on that contract in their own comments ("Budget-exceeded THROWS and is deliberately
// not caught"; parallel() turns the throwing thunk into null). Until this file no test passed
// `budgetTotal` at all, so the whole road from the throw to the verdict — the lens dies on it, the
// reason is captured, the dropped lens reaches notRun, the verdict is marked INCOMPLETE — was
// pinned by nothing: the throwing half of the dead-agent class existed in tests only as a scripted
// `() => { throw }`, never as the budget actually running out.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { runEngine, filedRecord } from './engine-harness.mjs'

const SCRIPT = {
  detect: { baseRef: 'main', files: ['src/lib.rs'], spec: '', branch: 'feat/x', head: 'abc1234' },
  'prior-round': { found: false, round: 0, head: '', ledger: [], ledgerCount: 0, priorFindings: 0, reason: 'none' },
  checkpoint: { runDir: '/store/.partial/run-A', error: '' },
  'log-run': { ok: true, error: '' },
  scout: { sizeBucket: 'small', lenses: ['safety'], isLibrary: false, securitySensitive: false, intent: '', churn: [], notes: 'x' },
  gate: { status: 'pass', provenance: 'CI', failedChecks: [], carriedChecks: [], seedFindings: [], notes: '' },
  lens: { lens: 'safety', findings: [] },
  dedup: { groups: [] },
  synthesis: null,
  '*': null,
}

test('review: a budget exhausted at the lens phase ends in an INCOMPLETE verdict, not a clean Approve', async () => {
  // Two passes, one script. The first, under the effectively unlimited default budget, is the
  // control AND the calibration: it must end green, and the index of its first lens dispatch is
  // where the second pass's wall goes. Calibrating by call index rather than by a hard-coded count
  // keeps the exhaustion pinned to "the first lens" even when the engine gains or loses a pre-lens
  // dispatch — the pre-lens sequence is deterministic under an identical script, so the two runs
  // agree up to the wall. (spent grows 1000 per answered call, so 1000×k exhausts exactly at call k.)
  const control = await runEngine('review', { args: {}, script: SCRIPT })
  assert.match(control.report, /✅ Approve/, 'the control run must be green, or the INCOMPLETE below proves nothing')
  assert.ok(!/INCOMPLETE/.test(control.report), 'and must carry no INCOMPLETE marker')
  const lensAt = control.calls.findIndex(c => String(c.label).startsWith('lens:'))
  assert.ok(lensAt > 0, 'the control must dispatch a lens after at least one pre-lens call — the wall below is placed at that index')

  const { report, calls } = await runEngine('review', { args: {}, script: SCRIPT, budgetTotal: lensAt * 1000 })
  const refused = calls.filter(c => c.threw)
  assert.ok(refused.length > 0, 'the exhausted budget must actually refuse dispatches — a stub that cannot run out tests nothing')
  assert.ok(String(refused[0].label).startsWith('lens:'),
    'and the FIRST refusal is a lens dispatch — the phase this test aims the exhaustion at; anything earlier means the calibration drifted')

  // The verdict, not just a log line: a run whose only lens died on the budget throw covers
  // nothing, and rendering it as a bare Approve is the defect class this harness exists for.
  assert.match(report, /Approve \(INCOMPLETE\)/, 'the report verdict must say INCOMPLETE, never a clean Approve')
  // Anchored to the dropped-lens wording, not a bare /budget exhausted/: the refused checkpoint
  // writes put that phrase into the Telemetry-lost section too, so the loose match stayed green
  // with the lens's own failure reason anonymized — measured by falsifying the capture.
  assert.match(report, /lenses that never returned — [^\n]*budget exhausted/,
    "and the dropped lens must carry the throw's own reason — exhaustion, not an anonymous death")

  // The record the engine TRIED to file (the write itself was refused too — the budget stays
  // exhausted — but the outgoing prompt still carries the payload).
  const record = filedRecord({ calls })
  assert.ok(record, 'the outgoing record must be recoverable from the refused logger dispatch')
  assert.equal(record.verdict, 'Approve (INCOMPLETE)', 'the filed verdict must match the report')
  assert.match((record.notRun || []).join('\n'), /budget exhausted/, 'and notRun must carry the exhaustion reason')
})
