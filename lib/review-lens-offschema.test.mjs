// A lens answer is model output: the schema shapes it, but an off-schema answer still reaches the
// engine. One without a findings array did not review — it must leave the verdict INCOMPLETE exactly
// as a dead lens does, never a clean Approve, never junk findings, never a crash. Likewise a live
// synthesis agent that answers with something other than report text did not die, and the fallback
// report must not say it did.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { runEngine, filedRecord } from './engine-harness.mjs'

/** @param {unknown} lens @param {unknown} [synthesis] @returns {Record<string, unknown>} */
function script(lens, synthesis = null) {
  return {
    detect: { baseRef: 'main', files: ['src/lib.rs'], spec: '', branch: 'feat/x', head: 'abc1234' },
    'prior-round': { found: false, round: 0, head: '', ledger: [], ledgerCount: 0, priorFindings: 0, reason: 'none' },
    checkpoint: { runDir: '/store/.partial/run-A', error: '' },
    'log-run': { ok: true, error: '' },
    scout: { sizeBucket: 'small', lenses: ['safety'], isLibrary: false, securitySensitive: false, intent: '', churn: [], notes: 'x' },
    gate: { status: 'pass', provenance: 'CI', failedChecks: [], carriedChecks: [], seedFindings: [], notes: '' },
    lens,
    dedup: { groups: [] },
    synthesis,
    '*': null,
  }
}

for (const [name, lens] of /** @type {[string, unknown][]} */ ([['{}', {}], ["{findings:'none'}", { findings: 'none' }], ['{findings:3}', { findings: 3 }]])) {
  test(`review: a lens answering ${name} is a lens failure — INCOMPLETE, not Approve and not a crash`, async () => {
    const run = await runEngine('review', { args: {}, script: script(lens) })
    const rec = filedRecord(run)
    assert.ok(rec, 'the run completes and files a record')
    assert.match(String(rec.verdict), /INCOMPLETE/, `verdict was ${rec.verdict}`)
    assert.match(run.report, /INCOMPLETE/)
    assert.ok((rec.notRun || []).some((/** @type {string} */ n) => /answered off-schema/.test(n)), (rec.notRun || []).join('\n'))
    assert.equal(rec.findings?.total ?? 0, 0, 'no junk findings spread out of a non-array')
  })
}

test('review: a lens answering null keeps its dead-lens behaviour (INCOMPLETE, no off-schema reason)', async () => {
  const run = await runEngine('review', { args: {}, script: script(null) })
  const rec = filedRecord(run)
  assert.match(String(rec.verdict), /INCOMPLETE/)
  assert.ok(!(rec.notRun || []).some((/** @type {string} */ n) => /answered off-schema/.test(n)), (rec.notRun || []).join('\n'))
})

test('review: a well-formed empty lens still approves — the guard is not a blanket downgrade', async () => {
  const run = await runEngine('review', { args: {}, script: script({ lens: 'safety', findings: [] }) })
  const rec = filedRecord(run)
  assert.ok(!/INCOMPLETE/.test(String(rec.verdict)), `verdict was ${rec.verdict}: ${(rec.notRun || []).join('\n')}`)
})

// Synthesis only runs when a finding survives, so the lens raises one on its first answer.
const FINDING = { title: 'unchecked overflow', file: 'src/lib.rs', line: 3, severity: 'medium', why: 'w', fix: 'f', ruleId: '', whereChecked: '' }
const LENS_WITH_FINDING = (/** @type {{ callIndex: number }} */ { callIndex }) => ({ lens: 'safety', findings: callIndex === 0 ? [FINDING] : [] })

test('review: a live synthesis answer that is not text is reported as unusable, not as a death', async () => {
  const run = await runEngine('review', { args: {}, script: script(LENS_WITH_FINDING, { report: 'x' }) })
  assert.ok(run.calls.some(c => c.label === 'synthesis'), 'premise: synthesis was dispatched')
  assert.match(run.report, /synthesis agent returned no usable report/)
  assert.doesNotMatch(run.report, /died twice/)
  assert.ok(run.logs.some(l => /synthesis agent answered with a value of type object/.test(l)), run.logs.join('\n'))
})

test('review: a dead synthesis agent is still reported as a death', async () => {
  const run = await runEngine('review', { args: {}, script: script(LENS_WITH_FINDING, null) })
  assert.ok(run.calls.some(c => c.label === 'synthesis'), 'premise: synthesis was dispatched')
  assert.match(run.report, /synthesis agent died twice/)
})

test('review: a blank synthesis answer is unusable, not a death and not the report', async () => {
  for (const blank of ['', '  \n\t ']) {
    const run = await runEngine('review', { args: {}, script: script(LENS_WITH_FINDING, blank) })
    assert.ok(run.calls.some(c => c.label === 'synthesis'), 'premise: synthesis was dispatched')
    assert.match(run.report, /synthesis agent returned no usable report/, JSON.stringify(blank))
    assert.doesNotMatch(run.report, /died twice/)
    assert.ok(run.logs.some(l => /synthesis agent answered with blank text/.test(l)), run.logs.join('\n'))
  }
})
