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
  assert.match(out, /## NOISE/)
  assert.match(out, /rust lens safety/)
})

// Per-lens telemetry (confirmedCount/suspectedCount/refutedCount) — present on runs recorded
// after that telemetry landed. api-idioms over-refutes (6 of 8 candidates); safety does not.
const REVIEW_TELEMETRY = {
  schemaVersion: 1, name: 'review', verdict: 'Warning',
  verification: { candidates: 10, confirmed: 3, refuteRate: 0.7 }, outputTokens: 800, notRun: [],
  dimensions: [
    { dimension: 'rust:api-idioms', findingCount: 1, bySeverity: { Critical: 0, High: 0, Medium: 0, Low: 1, Info: 0 }, confirmedCount: 1, suspectedCount: 1, refutedCount: 6 },
    { dimension: 'rust:safety', findingCount: 2, bySeverity: { Critical: 0, High: 0, Medium: 2, Low: 0, Info: 0 }, confirmedCount: 2, suspectedCount: 0, refutedCount: 0 },
  ],
}

test('aggregate computes per-lens refute rate from confirmed/suspected/refuted counts', () => {
  const a = aggregate([REVIEW_TELEMETRY])
  const api = a.dimensions.find(d => d.dimension === 'rust:api-idioms')
  assert.equal(api.candidates, 8)          // 1 + 1 + 6
  assert.equal(api.refuted, 6)
  assert.equal(api.refuteRate, 0.75)       // 6 / 8
  const safety = a.dimensions.find(d => d.dimension === 'rust:safety')
  assert.equal(safety.refuteRate, 0)       // 0 / 2
})

test('dimensions without per-lens counts get refuteRate null (old-schema records)', () => {
  const safety = aggregate([REVIEW_1]).dimensions.find(d => d.dimension === 'rust:safety')
  assert.equal(safety.candidates, 0)
  assert.equal(safety.refuteRate, null)    // null, not 0 — no per-lens data to judge
})

test('NOISE section ranks over-refuting lenses above the candidate floor', () => {
  const out = renderReport(aggregate([REVIEW_TELEMETRY]))
  assert.match(out, /## NOISE/)
  assert.match(out, /rust:api-idioms: refute 0\.75 \(6\/8\)/)   // 8 candidates ≥ floor → listed
  assert.doesNotMatch(out, /rust:safety: refute/)               // only 2 candidates < floor → omitted
})
