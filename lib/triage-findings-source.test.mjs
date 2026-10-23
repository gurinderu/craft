// triage-findings' report source: a finding gathered from a report carries the engine that wrote the report
// (its stable id starts with it), `report` when the report does not say; a rust-audit report keeps its ids.
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { runEngine, filedRecord } from './engine-harness.mjs'

const F = { severity: 'High', title: 'leak', location: 'src/a.rs:10', detail: 'd', proposed_fix: '', thread_id: '' }
const plan = { plan_markdown: 'BODY', summary: 'S', ledger: [] }

/** @param {unknown} source @param {string} id */
const triage = (source, id) => runEngine('triage-findings', {
  args: { report: '/r.md' },
  script: {
    'log-run': { ok: true },
    'gather:report': { source, findings: [F] },
    validate: { stable_id: id, verdict: 'accept', reason: 'real', fix_pointer: '', premise_checked: '' },
    plan,
  },
})
/** @param {Awaited<ReturnType<typeof triage>>} r */
const planPrompt = r => r.calls.find(c => c.label === 'plan')?.prompt ?? ''

test('an adversarial-review report is gathered under its own engine name', async () => {
  const r = await triage('adversarial-review', 'adversarial-review::src/a.rs:10::leak')
  assert.match(r.calls.find(c => c.label === 'gather:report')?.prompt ?? '', /"adversarial-review"/)
  assert.deepEqual(filedRecord(r).sources, [{ source: 'adversarial-review', count: 1 }])
  assert.match(planPrompt(r), /adversarial-review::src\/a\.rs:10::leak/)
})

test('a source the report does not name, or one outside the engines, falls back to `report`', async () => {
  for (const said of ['made up by the agent', '', undefined]) {
    const r = await triage(said, 'report::src/a.rs:10::leak')
    assert.deepEqual(filedRecord(r).sources, [{ source: 'report', count: 1 }], String(said))
    assert.match(planPrompt(r), /report::src\/a\.rs:10::leak/)
  }
})

test('a rust-audit report keeps its ids', async () => {
  const r = await triage('rust-audit', 'rust-audit::src/a.rs:10::leak')
  assert.deepEqual(filedRecord(r).sources, [{ source: 'rust-audit', count: 1 }])
  assert.match(planPrompt(r), /rust-audit::src\/a\.rs:10::leak/)
})
