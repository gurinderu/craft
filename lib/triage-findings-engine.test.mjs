// triage-findings end to end in the engine harness: the carry-forward of settled verdicts, the
// unjudged marker that keeps a dead validator's finding out of it, the marker re-injected over a plan
// agent that paraphrased or dropped it, and the banners that tell the plan's reader what did not run.
// These pin what the engine returns and files, not how its body is arranged.
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { runEngine, filedRecord } from './engine-harness.mjs'

const F1 = { severity: 'High', title: 'leak', location: 'src/a.rs:10', detail: 'd1', proposed_fix: 'fix it', thread_id: '' }
const F2 = { severity: 'Low', title: 'nit', location: '', detail: 'd2', proposed_fix: '', thread_id: '' }
const ID1 = 'rust-audit::src/a.rs:10::leak'
const ID2 = 'rust-audit::no-loc::nit'
const gathered = { source: 'rust-audit', findings: [F1, F2] }

/** @param {Record<string, any>} script @param {Record<string, unknown>} [args] */
const run = (script, args = { report: '/r.md' }) => runEngine('triage-findings', { args, script: { 'log-run': { ok: true }, ...script } })

test('no source at all is refused before anything is dispatched', async () => {
  const err = await runEngine('triage-findings', { args: {}, script: {} }).then(() => null, e => e)
  assert.match(String(err?.message), /needs a source/)
  assert.deepEqual(err.calls, [])
})

test('a prior settled verdict is carried without an agent; accept and unjudged ones are judged again', async () => {
  const prior = [
    { stable_id: ID1, verdict: 'accept', reason: 'was fine' },
    { stable_id: ID2, verdict: 'reject', reason: 'not a bug' },
    'not an object',
    null,
  ]
  const r = await run({
    'gather:report': gathered,
    validate: { stable_id: ID1, verdict: 'accept', reason: 'real', fix_pointer: 'rust-errors: x', premise_checked: '' },
    plan: { plan_markdown: 'BODY', summary: 'S', ledger: [{ stable_id: ID1, verdict: 'accept', reason: 'real' }, { stable_id: ID2, verdict: 'reject', reason: 'carried' }] },
  }, { report: '/r.md', priorLedger: prior, base: 'v1' })
  const validates = r.calls.filter(c => c.label.startsWith('validate:'))
  assert.deepEqual(validates.map(c => c.label), ['validate:src/a.rs:10'])
  assert.match(validates[0]?.prompt ?? '', /Validate against ref `v1`/)
  assert.match(validates[0]?.prompt ?? '', /- proposed fix: fix it/)
  const planCall = r.calls.find(c => c.label === 'plan')
  assert.match(planCall?.prompt ?? '', /carried from prior run: not a bug/)
  assert.match(planCall?.prompt ?? '', /\(carried from prior run — not re-checked\)/)
  assert.match(r.report, /BODY/)
  assert.doesNotMatch(r.report, /INCOMPLETE/)
  const rec = filedRecord(r)
  assert.equal(rec.verdict, '')
  assert.deepEqual(rec.notRun, [])
  assert.deepEqual(rec.sources, [{ source: 'rust-audit', count: 2 }])
  assert.equal(rec.triage.gathered, 2)
  assert.equal(rec.triage.validated, 2)
})

test('a prior needs-decision that was never judged is judged again; the working tree is the default pin', async () => {
  const r = await run({
    'gather:report': { source: 'rust-audit', findings: [F2] },
    validate: { stable_id: ID2, verdict: 'defer', reason: 'later', fix_pointer: '', premise_checked: '' },
    plan: { plan_markdown: 'BODY', summary: 'S', ledger: [{ stable_id: ID2, verdict: 'defer', reason: 'later' }] },
  }, { report: '/r.md', priorLedger: [{ stable_id: ID2, verdict: 'needs-decision', reason: 'carried from prior run: NOT JUDGED — died' }] })
  const v = r.calls.filter(c => c.label.startsWith('validate:'))
  assert.deepEqual(v.map(c => c.label), ['validate:nit'])
  assert.match(v[0]?.prompt ?? '', /Validate against the currently checked-out tree\./)
  assert.match(v[0]?.prompt ?? '', /- location: \(none given\)/)
})

test('a dead validator is carried as unjudged, re-injected over a paraphrasing or forgetful plan, and bannered', async () => {
  const r = await run({
    'gather:report': gathered,
    validate: (/** @type {{ prompt: string }} */ { prompt }) => /src\/a\.rs/.test(prompt) ? null : { stable_id: ID2, verdict: 'reject', reason: 'no', fix_pointer: '', premise_checked: '' },
    // The plan paraphrases ID1's marker away and drops nothing; a second run below drops it entirely.
    plan: { plan_markdown: 'BODY', summary: 'SUM', ledger: [{ stable_id: ID1, verdict: 'accept', reason: 'looked fine' }, { stable_id: ID2, verdict: 'reject', reason: 'no' }] },
  })
  const rec = filedRecord(r)
  assert.deepEqual(rec.notRun, ['findings-unjudged'])
  assert.equal(rec.triage['needs-decision'] ?? rec.triage.needsDecision ?? rec.triage.needs_decision, 1)
  assert.match(r.report, /> \*\*INCOMPLETE TRIAGE\*\*/)
  assert.match(r.report, /1 finding\(s\) were never judged/)
  assert.match(r.reportValue.plan_markdown, /^> \*\*INCOMPLETE TRIAGE\*\*[\s\S]*\nBODY$/)
  assert.match(r.reportValue.summary, /^INCOMPLETE: 1 finding\(s\)[\s\S]*\n\nSUM$/)
  assert.equal(r.reportValue.notRun.length, 1)
  assert.equal(r.reportValue.telemetryLost, undefined)
  assert.deepEqual(r.reportValue.ledger.map((/** @type {any} */ e) => [e.stable_id, e.verdict, /NOT JUDGED/.test(e.reason)]), [[ID1, 'needs-decision', true], [ID2, 'reject', false]])
  assert.ok(r.logs.some(l => /1 validator\(s\) died/.test(l)))

  const dropped = await run({
    'gather:report': gathered,
    validate: (/** @type {{ prompt: string }} */ { prompt }) => /src\/a\.rs/.test(prompt) ? null : { stable_id: ID2, verdict: 'reject', reason: 'no', fix_pointer: '', premise_checked: '' },
    plan: { plan_markdown: 'BODY', summary: 'SUM', ledger: [{ stable_id: ID2, verdict: 'reject', reason: 'no' }] },
  })
  assert.equal(filedRecord(dropped).triage.gathered, 2)
  assert.deepEqual(dropped.reportValue.ledger.map((/** @type {any} */ e) => [e.stable_id, e.verdict, /NOT JUDGED/.test(e.reason)]), [[ID2, 'reject', false], [ID1, 'needs-decision', true]])
  const kept = await run({
    'gather:report': gathered,
    validate: (/** @type {{ prompt: string }} */ { prompt }) => /src\/a\.rs/.test(prompt) ? null : { stable_id: ID2, verdict: 'reject', reason: 'no', fix_pointer: '', premise_checked: '' },
    plan: { plan_markdown: 'BODY', summary: 'SUM', ledger: [{ stable_id: ID1, verdict: 'needs-decision', reason: 'x NOT JUDGED y' }, { stable_id: ID2, verdict: 'reject', reason: 'no' }] },
  })
  assert.deepEqual(filedRecord(kept).notRun, ['findings-unjudged'])
  assert.equal(kept.reportValue.ledger[0].reason, 'x NOT JUDGED y')

  // Without any unjudged validation the plan's own ledger is returned as the agent gave it.
  const clean = await run({
    'gather:report': gathered,
    validate: (/** @type {{ prompt: string }} */ { prompt }) => ({ stable_id: /src\/a\.rs/.test(prompt) ? ID1 : ID2, verdict: 'reject', reason: 'no', fix_pointer: '', premise_checked: '' }),
    plan: { plan_markdown: 'BODY', summary: 'SUM', ledger: [{ stable_id: ID1, verdict: 'conflict', reason: 'c' }] },
  })
  assert.deepEqual(clean.reportValue.ledger, [{ stable_id: ID1, verdict: 'conflict', reason: 'c' }])
  assert.equal(clean.reportValue.notRun, undefined)
})

test('the re-injected ledger: a paraphrased marker restored, a dropped entry appended, a kept one untouched', async () => {
  // The engine returns the plan as text; the ledger it re-injected is the one it tallies into the record.
  const paraphrased = await run({
    'gather:report': gathered,
    validate: (/** @type {{ prompt: string }} */ { prompt }) => /src\/a\.rs/.test(prompt) ? null : { stable_id: ID2, verdict: 'reject', reason: 'no', fix_pointer: '', premise_checked: '' },
    plan: { plan_markdown: 'BODY', summary: 'SUM', ledger: [{ stable_id: ID1, verdict: 'accept', reason: 'looked fine' }, { stable_id: ID2, verdict: 'reject', reason: 'no' }] },
  })
  const t1 = filedRecord(paraphrased).triage
  const appended = filedRecord(await run({
    'gather:report': gathered,
    validate: (/** @type {{ prompt: string }} */ { prompt }) => /src\/a\.rs/.test(prompt) ? null : { stable_id: ID2, verdict: 'reject', reason: 'no', fix_pointer: '', premise_checked: '' },
    plan: { plan_markdown: 'BODY', summary: 'SUM', ledger: [{ stable_id: ID2, verdict: 'reject', reason: 'no' }] },
  })).triage
  // Both runs end with ID1 as needs-decision and ID2 as reject: no accept survives the re-injection.
  assert.deepEqual(t1, appended)
  assert.equal(t1.accept ?? 0, 0)
  assert.equal(t1.reject, 1)
})

test('a plan ledger that is not an array falls back to the validations', async () => {
  const r = await run({
    'gather:report': gathered,
    validate: (/** @type {{ prompt: string }} */ { prompt }) => ({ stable_id: /src\/a\.rs/.test(prompt) ? ID1 : ID2, verdict: 'accept', reason: 'r', fix_pointer: 'p', premise_checked: '' }),
    plan: { plan_markdown: 'BODY', summary: 'SUM', ledger: 'oops' },
  })
  assert.equal(filedRecord(r).triage.accept, 2)
})

test('a dead source is named in the plan and the record; a dead plan returns the failure line', async () => {
  const r = await run({
    'gather:report': { source: 'rust-audit', findings: [] },
    plan: { plan_markdown: 'BODY', summary: 'SUM', ledger: [] },
  }, { report: '/r.md', pr: '7' })
  assert.match(r.report, /source `pr` produced nothing/)
  assert.match(r.report, /INCOMPLETE: source `pr` produced nothing/)
  assert.deepEqual(filedRecord(r).notRun, ['gather:pr'])
  assert.ok(r.logs.some(l => /source\(s\) that produced nothing: pr/.test(l)))
  const prCall = r.calls.find(c => c.label === 'gather:pr')
  assert.match(prCall?.prompt ?? '', /GitHub PR #7/)

  const dead = await run({ 'gather:report': { source: 'rust-audit', findings: [] } })
  assert.equal(dead.report, 'Triage failed: the Plan-phase agent returned no result. Re-run, or triage the findings manually.')
})

test('a lost run record leads the plan and the failure line; a landed one with a warning is not a loss', async () => {
  const lost = await run({
    'log-run': null,
    'gather:report': { source: 'rust-audit', findings: [] },
    plan: { plan_markdown: 'BODY', summary: 'SUM', ledger: [] },
  })
  assert.match(lost.report, /telemetry/i)
  assert.ok(lost.report.indexOf('BODY') > lost.report.search(/telemetry/i))
  assert.ok(lost.logs.some(l => /telemetry lost: the run record/.test(l)))

  const warned = await run({
    'log-run': { ok: true, error: 'run dir refused' },
    'gather:report': { source: 'rust-audit', findings: [] },
    plan: { plan_markdown: 'BODY', summary: 'SUM', ledger: [] },
  })
  assert.ok(warned.logs.some(l => /⚠️ telemetry: run dir refused/.test(l)))
  assert.match(warned.report, /run dir refused/)

  const deadPlan = await run({ 'log-run': null, 'gather:report': { source: 'rust-audit', findings: [] } })
  assert.match(deadPlan.report, /Triage failed: the Plan-phase agent returned no result/)
  assert.ok(deadPlan.report.search(/telemetry/i) < deadPlan.report.indexOf('Triage failed'))
})

test('the report gatherer is told the verbatim tool titles are titles, not findings, and to take titles from them (realm @nick/craft, node #236)', async () => {
  const r = await run({ 'gather:report': gathered, validate: null, plan: null })
  const gather = r.calls.find(c => c.label === 'gather:report')?.prompt ?? ''
  assert.match(gather, /`## Tool finding titles \(verbatim\)` section .* lists titles, not findings: never extract its rows as findings/)
  assert.match(gather, /when several are listed and none is equal, keep the finding's own line, never a guess between them/)
})
