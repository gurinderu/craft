import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  countBySeverity, summarizeFindings, worstVerdict, reviewVerdict, refuteRate, indexProjection,
  tallyVerdicts, titleShingle, fingerprint, shingleOverlap, matchesPrior,
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

test('tallyVerdicts buckets dispositions, ignores unknown and malformed', () => {
  assert.deepEqual(
    tallyVerdicts([
      { verdict: 'accept' }, { verdict: 'accept' }, { verdict: 'reject' },
      { verdict: 'defer' }, { verdict: 'needs-decision' }, { verdict: 'conflict' },
      { verdict: 'bogus' }, {},
    ]),
    { accept: 2, reject: 1, defer: 1, 'needs-decision': 1, conflict: 1 },
  )
})

test('tallyVerdicts tolerates non-array input', () => {
  assert.deepEqual(tallyVerdicts(null), { accept: 0, reject: 0, defer: 0, 'needs-decision': 0, conflict: 0 })
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

test('titleShingle normalizes, sorts, and is word-order independent', () => {
  assert.equal(titleShingle('Lock held across .await'), 'across await held lock')
  assert.equal(titleShingle('await held lock across'), 'across await held lock')
  assert.equal(titleShingle(null), '')
})

test('fingerprint is deterministic and ignores title word order', () => {
  const a = { file: 'src/foo.rs', symbol: 'Foo::bar', ruleId: 'CON-003', title: 'Lock held across await' }
  const b = { file: 'src/foo.rs', symbol: 'Foo::bar', ruleId: 'CON-003', title: 'await across held Lock' }
  assert.equal(fingerprint(a), fingerprint(b))
  assert.match(fingerprint(a), /^[0-9a-f]{8}$/)
})

test('fingerprint separates on file, symbol, and ruleId', () => {
  const base = { file: 'src/foo.rs', symbol: 'Foo::bar', ruleId: 'CON-003', title: 'x' }
  assert.notEqual(fingerprint(base), fingerprint({ ...base, file: 'src/other.rs' }))
  assert.notEqual(fingerprint(base), fingerprint({ ...base, symbol: 'Foo::baz' }))
  assert.notEqual(fingerprint(base), fingerprint({ ...base, ruleId: 'CON-004' }))
})

test('shingleOverlap is 1 for identical, 0 for disjoint, fractional for partial', () => {
  assert.equal(shingleOverlap('lock across await', 'await across lock'), 1)
  assert.equal(shingleOverlap('lock across await', 'unrelated other words'), 0)
  assert.ok(shingleOverlap('lock held across await', 'lock across await') > 0.5)
  assert.equal(shingleOverlap('', 'anything'), 0)
})

test('matchesPrior requires same file+ruleId and a title above threshold', () => {
  const prior = { file: 'src/foo.rs', symbol: 'Foo::bar', ruleId: 'CON-003', title: 'Lock held across await' }
  assert.ok(matchesPrior({ ...prior, line: 99, title: 'lock across await held' }, prior))
  assert.ok(!matchesPrior({ ...prior, file: 'src/other.rs' }, prior))
  assert.ok(!matchesPrior({ ...prior, ruleId: 'CON-004' }, prior))
  assert.ok(!matchesPrior({ ...prior, title: 'completely different unrelated defect here' }, prior))
})

test('matchesPrior treats a moved symbol as the same finding when file+ruleId+title hold', () => {
  const prior = { file: 'src/foo.rs', symbol: '', ruleId: 'SAF-002', title: 'unwrap on reachable path' }
  assert.ok(matchesPrior({ file: 'src/foo.rs', symbol: 'Foo::run', ruleId: 'SAF-002', title: 'unwrap on reachable path' }, prior))
})
