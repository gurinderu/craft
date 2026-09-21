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
import { runEngine, filedRecord, CALL_SPEND } from './engine-harness.mjs'

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
  // agree up to the wall. (spent grows CALL_SPEND per answered call, so CALL_SPEND×k exhausts
  // exactly at call k — the constant is the harness's own export, so the wall moves with it.)
  const control = await runEngine('review', { args: {}, script: SCRIPT })
  assert.match(control.report, /✅ Approve/, 'the control run must be green, or the INCOMPLETE below proves nothing')
  assert.ok(!/INCOMPLETE/.test(control.report), 'and must carry no INCOMPLETE marker')
  const lensAt = control.calls.findIndex(c => String(c.label).startsWith('lens:'))
  assert.ok(lensAt > 0, 'the control must dispatch a lens after at least one pre-lens call — the wall below is placed at that index')

  const { report, calls } = await runEngine('review', { args: {}, script: SCRIPT, budgetTotal: lensAt * CALL_SPEND })
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
  // The record is built AFTER several refusals (the lenses, a checkpoint), so its budget.spent()
  // snapshot is where "a refusal spends nothing" is actually observable: a spending refusal would
  // push this past the wall, and every wall calibrated as index × CALL_SPEND would land early.
  assert.equal(record.outputTokens, lensAt * CALL_SPEND, 'budget.spent() stays at the wall — a refused dispatch spends nothing')
})

test('review: a budget exhausted at the verify phase fails the run closed — the finding is never judged, and no report renders', async () => {
  // The road the test above never reaches: findings EXIST, and the wall lands on the verifier
  // dispatched for them — the defect class this repo has already shipped once (2026-09-01: dead
  // verifiers counted as refutations). Two properties are pinned. The refused verifier consults no
  // script and casts no verdict — there is nothing a tally could mistake for a refutation. And the
  // run then dies LOUDLY on the first refused dispatch nothing catches (synthesis is a direct
  // await; the engine lets a budget throw propagate everywhere but the bookkeeping writes, and the
  // sandbox kills an exhausted run the same way), so no report renders at all — fail-closed. If
  // the engine ever learns to survive this and render the mechanical fallback instead, this test
  // goes red HERE: replace the rejection asserts with INCOMPLETE-rendering ones — never with a
  // clean verdict over judgements that did not happen.
  const finding = {
    severity: 'Medium', title: 'race in refund path', file: 'src/lib.rs', line: 7, why: 'w', fix: 'f',
    blastRadius: '', source: 'safety', ruleId: '', whereChecked: '',
  }
  let verifierAnswered = 0
  const script = {
    ...SCRIPT,
    // Only the first lens call yields the finding; the loop-until-dry round then comes back empty.
    lens: ({ callIndex }) => ({ lens: 'safety', findings: callIndex === 0 ? [finding] : [] }),
    'verify-batch': ({ prompt }) => {
      verifierAnswered += 1
      return {
        verdicts: [...prompt.matchAll(/--- FINDING (\d+) ---/g)].map(m => ({
          index: Number(m[1]), refuted: false, citedLineMatches: true, reachable: true, premiseSupported: true, reason: 'ok',
        })),
      }
    },
  }

  // The control run doubles as the calibration, exactly as above: green, the finding confirmed,
  // and the index of the first verifier dispatch is where the wall goes.
  const control = await runEngine('review', { args: {}, script })
  assert.ok(!/INCOMPLETE/.test(control.report), 'the control run must be complete, or the failure below proves nothing')
  assert.match(control.report, /src\/lib\.rs:7/, 'and must carry the finding the wall will orphan')
  assert.equal(verifierAnswered, 1, 'and its verifier must actually have judged it')
  const verifyAt = control.calls.findIndex(c => /^verify/.test(String(c.label)))
  assert.ok(verifyAt > 0, 'the control must dispatch a verifier — the wall below is placed at that index')

  verifierAnswered = 0
  const err = await runEngine('review', { args: {}, script, budgetTotal: verifyAt * CALL_SPEND })
    .then(() => null, e => e)
  assert.ok(err, 'with findings in hand, exhaustion at the verifier must abort the run — any rendered verdict would cover judgements that never happened')
  assert.match(String(err.message), /budget exhausted/, "and the abort must carry the throw's own reason, not an anonymous death")
  const refused = (err.calls || []).filter(c => c.threw)
  assert.ok(refused.length > 0 && /^verify/.test(String(refused[0].label)),
    `the FIRST refusal is the verifier dispatch — the phase this test aims the exhaustion at (got '${refused[0]?.label}')`)
  assert.equal(verifierAnswered, 0, 'the refused verifier consulted no script — no verdict existed to count, as a refutation or anything else')
})
