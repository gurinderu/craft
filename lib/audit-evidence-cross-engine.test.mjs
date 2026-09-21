// Cross-engine pin for the work-evidence gate (invariant #53). The delivery-parity gate
// (lib/check-delivery-parity.mjs) compares the two agent RUBRIC deliveries, but nothing compared the
// two runtime ENGINES — so the gate reached the Claude Code engine (workflows/rust-audit.js →
// lib/audit-evidence.mjs) and not the opencode one (opencode/plugin/run-record.mjs), and CI stayed
// green. This test drives ONE scenario — a self-reported green with no `Evidence:` line — through both
// engines and asserts both refuse to report it as a clean green. It is the cheap structural pin the
// coverage finding asked for; it does NOT compare wording, only that the behaviour exists on both.
//
// Both modules are plain ESM over the Node standard library (run-record.mjs imports no opencode SDK),
// so importing the opencode one from a lib test needs nothing installed.
import test from 'node:test'
import assert from 'node:assert/strict'
import { demoteUnsupportedGreen } from './audit-evidence.mjs'
import { buildAuditRecord } from '../opencode/plugin/run-record.mjs'

test('both audit engines demote a self-reported green with no Evidence line', () => {
  // Claude Code engine: the demote helper the workflow inlines and runs in dimResult.
  const cc = demoteUnsupportedGreen({ dimension: 'security', verdict: 'Approve', findings: [], evidence: '' })
  assert.match(cc.verdict, /^INCOMPLETE \(no evidence/, 'Claude Code engine demotes the unsupported green')

  // opencode engine: the same fact must reach the record built by buildAuditRecord.
  const rec = buildAuditRecord({
    results: [{ label: 'security', ok: true, text: 'All clean.\n\nVERDICT: APPROVE' }],
    baseRef: 'main', hasUnsafe: false, synthesisText: 'Consolidated.\n\nVERDICT: APPROVE',
  })
  assert.match(rec.verdict, /INCOMPLETE/, 'opencode engine does not report the unsupported green as clean')
  assert.deepEqual(rec.noEvidence, ['security'], 'opencode engine buckets it as NO EVIDENCE')
})

test('both audit engines keep a green that DOES carry an Evidence line', () => {
  const cc = demoteUnsupportedGreen({ dimension: 'security', verdict: 'Approve', findings: [], evidence: 'Evidence: ran cargo-audit' })
  assert.equal(cc.verdict, 'Approve', 'Claude Code engine keeps the supported green')

  const rec = buildAuditRecord({
    results: [{ label: 'security', ok: true, text: 'clean.\nEvidence: ran cargo-audit over 214 crates.\n\nVERDICT: APPROVE' }],
    baseRef: 'main', hasUnsafe: false, synthesisText: 'Evidence: merged.\n\nVERDICT: APPROVE',
  })
  assert.equal(rec.verdict, 'Approve', 'opencode engine keeps the supported green')
  assert.deepEqual(rec.noEvidence, [])
})
