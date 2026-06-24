import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  countBySeverity, summarizeFindings, worstVerdict, reviewVerdict, refuteRate, indexProjection,
} from './run-record.mjs'

test('countBySeverity tallies known severities, ignores unknown and malformed', () => {
  assert.deepEqual(
    countBySeverity([{ severity: 'Critical' }, { severity: 'Critical' }, { severity: 'Low' }, { severity: 'Bogus' }, {}]),
    { Critical: 2, High: 0, Medium: 0, Low: 1, Info: 0 },
  )
})

test('countBySeverity tolerates non-array input', () => {
  assert.deepEqual(countBySeverity(null), { Critical: 0, High: 0, Medium: 0, Low: 0, Info: 0 })
})

test('summarizeFindings totals across severities', () => {
  const got = summarizeFindings([{ severity: 'High' }, { severity: 'Info' }, { severity: 'High' }])
  assert.equal(got.total, 3)
  assert.equal(got.bySeverity.High, 2)
})

test('worstVerdict picks the worst across mixed vocabularies', () => {
  assert.equal(worstVerdict(['Approve', 'Concerns', 'At-risk']), 'Block')
  assert.equal(worstVerdict(['Approve', 'Warning']), 'Warning')
  assert.equal(worstVerdict(['Approve', 'Healthy', 'Clean']), 'Approve')
  assert.equal(worstVerdict(['UB-found']), 'Block')
})

test('reviewVerdict is driven by confirmed severities', () => {
  assert.equal(reviewVerdict([{ severity: 'High' }]), 'Block')
  assert.equal(reviewVerdict([{ severity: 'Medium' }]), 'Warning')
  assert.equal(reviewVerdict([{ severity: 'Low' }, { severity: 'Info' }]), 'Approve')
  assert.equal(reviewVerdict([]), 'Approve')
})

test('refuteRate is the dropped fraction, 2-dp, safe at zero', () => {
  assert.equal(refuteRate(4, 1), 0.75)
  assert.equal(refuteRate(2, 2), 0)
  assert.equal(refuteRate(0, 0), 0)
  assert.equal(refuteRate(3, 0), 1)
})

test('indexProjection keeps only summary fields and passes runtime through', () => {
  const rec = {
    schemaVersion: 1, runtime: 'claude-code', ts: 'T', kind: 'workflow', name: 'rust-audit',
    project: '/p', commit: 'abc', dirty: false,
    verdict: 'Warning', findings: { total: 5, bySeverity: {} }, nested: true, via: 'rust-audit',
    outputTokens: 1234, dimensions: [{ dimension: 'security' }], scout: { x: 1 },
  }
  assert.deepEqual(indexProjection(rec), {
    schemaVersion: 1, runtime: 'claude-code', ts: 'T', kind: 'workflow', name: 'rust-audit',
    project: '/p', commit: 'abc', dirty: false,
    verdict: 'Warning', findingsTotal: 5, nested: true, via: 'rust-audit', outputTokens: 1234,
  })
})
