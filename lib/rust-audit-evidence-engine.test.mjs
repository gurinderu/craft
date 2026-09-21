import test from 'node:test'
import assert from 'node:assert/strict'
import { runEngine, filedRecord } from './engine-harness.mjs'

// These drive the REAL rust-audit dispatch/synthesis pipeline (not a brace-sliced copy), the same
// technique lib/nested-workflow.test.mjs uses for the review dimension. The property under test is
// the work-evidence gate (invariant #53): a self-reported green dimension with no `Evidence:` line
// is demoted to INCOMPLETE by construction, while the finding-count-grounded review axis is exempt.

// Scenario 1 (RED before the fix — revert dimResult's demote call and this fails): a security agent
// self-reports Approve with an EMPTY evidence field. The gate must demote it, not trust it.
test('a self-reported Approve with no Evidence is demoted, not trusted', async () => {
  const run = await runEngine('rust-audit', { script: {
    security: { dimension: 'security', verdict: 'Approve', summary: 'looks fine', findings: [], evidence: '' },
  } })
  const sec = filedRecord(run).dimensions.find(d => d.dimension === 'security')
  assert.ok(sec, 'the security dimension produced a result')
  assert.match(sec.verdict, /INCOMPLETE \(no evidence/, 'an unsupported green is demoted to INCOMPLETE')
})

// Scenario 2 (the false-positive control): the SAME green, but WITH a non-empty Evidence line, must
// pass through untouched. A gate that demoted this would punish honest work.
test('a self-reported Approve WITH Evidence is not demoted', async () => {
  const run = await runEngine('rust-audit', { script: {
    security: { dimension: 'security', verdict: 'Approve', summary: 'ok', findings: [],
      evidence: 'Evidence: ran cargo-audit, cargo-deny; both clean' },
  } })
  const sec = filedRecord(run).dimensions.find(d => d.dimension === 'security')
  assert.equal(sec.verdict, 'Approve', 'a green with evidence stays green')
})

// Scenario 3 (the exclusion): the nested `review` dimension's verdict is grounded by review.js's
// confirmed-finding count and its synthetic summary carries no `Evidence:` marker at all — the gate
// would demote every honest zero-finding review. It is dispatched with evidenceGate:false; this
// proves the exclusion holds.
test('a nested review dimension is exempt from the evidence gate', async () => {
  const run = await runEngine('rust-audit', { script: {
    '*': null, workflow: () => '## Verdict\n✅ Approve — no confirmed findings.',
  } })
  const rev = filedRecord(run).dimensions.find(d => d.dimension === 'review')
  assert.ok(rev, 'the review dimension produced a result')
  assert.equal(rev.verdict, 'Approve', 'a finding-count-grounded review Approve is never demoted for a missing marker')
})
