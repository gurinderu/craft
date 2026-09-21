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
import { demoteUnsupportedGreen, hasEvidence as hasEvidenceCC } from './audit-evidence.mjs'
import { buildAuditRecord, hasEvidence as hasEvidenceOC } from '../opencode/plugin/run-record.mjs'

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

test('both audit engines reject a marker buried in prose (line-anchored on both sides)', () => {
  // The line-anchoring fix must hold IDENTICALLY on both engines: a green whose only `Evidence:` is
  // quoted inside a finding ("no `Evidence:` of bounds") did nothing it can point to, and both must
  // demote it. The two hasEvidence copies live in separate closure-free deliveries, so this pins the
  // behaviour rather than the bytes.
  const buried = 'Reviewed for the `Evidence:` marker pattern; none found.'
  const cc = demoteUnsupportedGreen({ dimension: 'security', verdict: 'Approve', findings: [], evidence: buried })
  assert.match(cc.verdict, /^INCOMPLETE \(no evidence/, 'Claude Code engine demotes the buried-marker green')

  const rec = buildAuditRecord({
    results: [{ label: 'security', ok: true, text: `${buried}\n\nVERDICT: APPROVE` }],
    baseRef: 'main', hasUnsafe: false, synthesisText: 'Consolidated.\n\nVERDICT: APPROVE',
  })
  assert.match(rec.verdict, /INCOMPLETE/, 'opencode engine demotes the buried-marker green')
  assert.deepEqual(rec.noEvidence, ['security'])
})

test('both audit engines tolerate a markdown-decorated Evidence line IDENTICALLY (node #38 pendulum)', () => {
  // The two hasEvidence copies must move together: the decoration fix landed on both, so a model that
  // labels its work line `**Evidence:** …`, `- Evidence: …` or `> Evidence: …` is read as showing work
  // by BOTH engines, and a marker buried after prose is rejected by both. Pins the behaviour, not the
  // bytes (the copies live in separate closure-free deliveries).
  for (const line of ['**Evidence:** ran cargo test', '- Evidence: ran cargo-audit', '> Evidence: read src/x.rs', '`Evidence:` ran the tool']) {
    assert.equal(hasEvidenceCC(line), true, `Claude engine reads a decorated marker: ${line}`)
    assert.equal(hasEvidenceOC(line), true, `opencode engine reads a decorated marker: ${line}`)
  }
  // A decorated-but-empty marker and a buried marker are false on both — the gate is not weakened.
  for (const line of ['**Evidence:**', '*note* Evidence: buried after a word']) {
    assert.equal(hasEvidenceCC(line), false, `Claude engine rejects: ${line}`)
    assert.equal(hasEvidenceOC(line), false, `opencode engine rejects: ${line}`)
  }

  // End to end: a green whose ONLY Evidence line is markdown-decorated survives the gate on both engines.
  const decorated = 'All clean.\n**Evidence:** ran cargo-audit over 214 crates.'
  const cc = demoteUnsupportedGreen({ dimension: 'security', verdict: 'Approve', findings: [], evidence: decorated })
  assert.equal(cc.verdict, 'Approve', 'Claude Code engine keeps the decorated-evidence green')
  const rec = buildAuditRecord({
    results: [{ label: 'security', ok: true, text: `${decorated}\n\nVERDICT: APPROVE` }],
    baseRef: 'main', hasUnsafe: false, synthesisText: 'Evidence: merged.\n\nVERDICT: APPROVE',
  })
  assert.equal(rec.verdict, 'Approve', 'opencode engine keeps the decorated-evidence green')
  assert.deepEqual(rec.noEvidence, [])
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
