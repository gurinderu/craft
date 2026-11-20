// What rust-audit reads off a nested review answer (lib/rust-audit-nested.mjs): a run whose findings were not read
// back is never read as one that found none.
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { cliReviewResult } from './rust-audit-nested.mjs'
import { finishedAnswer, unreadAnswer } from './cli-review-verdict.mjs'

/** @param {Record<string, unknown>} [over] */
const brief = (over = {}) => ({
  run: '/tmp/run-x',
  report: '/tmp/run-x/report.md',
  verdict: 'Warning',
  line: 'Warning — 2 Medium',
  stopped: false,
  done: true,
  record: 'filed',
  degradedNotes: [],
  stopNote: '',
  worktree: '',
  prComments: null,
  sorting: null,
  lost: [],
  pending: 0,
  ...over,
})

test('a nested review whose findings were not read back is said so to the audit, not read as none found', () => {
  const r = cliReviewResult('deep', unreadAnswer(brief()))
  assert.equal(r.verdict, 'Warning')
  assert.match(r.summary, /not read back/)
  assert.match(r.summary, /\/tmp\/run-x\/report\.md/)
  const marked = r.findings.filter(f => /not read back/i.test(f.title))
  assert.equal(marked.length, 1)
  assert.notEqual(marked[0]?.severity, 'Info')
})

test('an Approve whose findings were not read back is not taken for a clean review', () => {
  const r = cliReviewResult('deep', unreadAnswer(brief({ verdict: 'Approve', line: 'Approve' })))
  assert.notEqual(r.verdict, 'Approve')
  assert.match(r.summary, /not read back/)
})

test('a nested review read whole is read as before', () => {
  const answer = finishedAnswer({
    run: '/tmp/run-x',
    report: '/tmp/run-x/report.md',
    verdict: 'Approve',
    line: 'Approve',
    degraded: false,
    findings: [],
  })
  const r = cliReviewResult('deep', answer)
  assert.equal(r.verdict, 'Approve')
  assert.ok(!r.findings.some(f => /not read back/i.test(f.title)))
})
