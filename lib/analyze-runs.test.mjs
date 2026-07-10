import { test } from 'node:test'
import assert from 'node:assert/strict'
import { aggregate, renderReport } from './analyze-runs.mjs'

const REVIEW_1 = {
  schemaVersion: 1, name: 'review', verdict: 'Warning',
  verification: { candidates: 5, confirmed: 2, refuteRate: 0.6 }, outputTokens: 1000,
  notRun: ['rust lens safety'],
  dimensions: [
    { dimension: 'rust:safety', findingCount: 1, bySeverity: { Critical: 0, High: 0, Medium: 1, Low: 0, Info: 0 } },
    { dimension: 'rust:errors', findingCount: 0, bySeverity: { Critical: 0, High: 0, Medium: 0, Low: 0, Info: 0 } },
  ],
}
const REVIEW_2 = {
  schemaVersion: 1, name: 'review', verdict: 'Approve (INCOMPLETE)',
  verification: { candidates: 0, confirmed: 0, refuteRate: 0 }, outputTokens: 500,
  notRun: ['rust lens safety', 'rust completeness-critic'],
  dimensions: [{ dimension: 'rust:safety', findingCount: 0, bySeverity: {} }],
}
const AUDIT = {
  schemaVersion: 1, name: 'rust-audit', verdict: 'Block',
  verification: { candidates: 3, confirmed: 1, refuteRate: 0.67 }, outputTokens: 2000, notRun: [],
  dimensions: [{ dimension: 'security', findingCount: 2, bySeverity: { Critical: 1, High: 1, Medium: 0, Low: 0, Info: 0 } }],
}

test('aggregate on empty input is all-zero', () => {
  assert.deepEqual(aggregate([]), { totalRuns: 0, incompleteRuns: 0, workflows: [], notRun: [], dimensions: [] })
})

test('aggregate ignores non-object records', () => {
  assert.equal(aggregate([null, 42, 'x', undefined]).totalRuns, 0)
})

test('aggregate tallies runs, verdicts and INCOMPLETE', () => {
  const a = aggregate([REVIEW_1, REVIEW_2, AUDIT])
  assert.equal(a.totalRuns, 3)
  assert.equal(a.incompleteRuns, 1)
  // sorted by run count desc → review (2) before rust-audit (1)
  assert.deepEqual(a.workflows.map(w => w.name), ['review', 'rust-audit'])
  const review = a.workflows.find(w => w.name === 'review')
  assert.deepEqual(review.verdicts, { block: 0, warning: 1, approve: 1, incomplete: 1 })
  assert.equal(review.avgRefuteRate, 0.3)        // (0.6 + 0) / 2
  assert.equal(review.avgOutputTokens, 750)      // (1000 + 500) / 2
  const audit = a.workflows.find(w => w.name === 'rust-audit')
  assert.equal(audit.verdicts.block, 1)
  assert.equal(audit.avgRefuteRate, 0.67)
})

test('aggregate ranks NOT-RUN frequency (fragility) highest first', () => {
  const a = aggregate([REVIEW_1, REVIEW_2, AUDIT])
  assert.deepEqual(a.notRun, [
    { item: 'rust lens safety', count: 2 },
    { item: 'rust completeness-critic', count: 1 },
  ])
})

test('aggregate sums per-dimension confirmed findings, sorted by volume', () => {
  const a = aggregate([REVIEW_1, REVIEW_2, AUDIT])
  assert.deepEqual(a.dimensions.map(d => d.dimension), ['security', 'rust:safety', 'rust:errors'])
  const safety = a.dimensions.find(d => d.dimension === 'rust:safety')
  assert.equal(safety.runs, 2)              // appeared in REVIEW_1 and REVIEW_2
  assert.equal(safety.findings, 1)
  assert.equal(safety.findingsPerRun, 0.5)
  const security = a.dimensions.find(d => d.dimension === 'security')
  assert.equal(security.bySeverity.Critical, 1)
  assert.equal(security.bySeverity.High, 1)
})

test('renderReport produces a string with the expected sections', () => {
  const out = renderReport(aggregate([REVIEW_1, REVIEW_2, AUDIT]))
  assert.match(out, /## Workflows/)
  assert.match(out, /## NOT RUN/)
  assert.match(out, /## Dimensions/)
  assert.match(out, /rust lens safety/)
})
