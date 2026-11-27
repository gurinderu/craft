// The answer's `## Findings` list as the JS driver writes it (integrations/shared/cli-review-findings.mjs): the unverified
// Low and Info findings the binary held apart leave the list, one sentence names their count and file (realm @nick/craft,
// node #636) — the same cases as the binary's own writer (cli/bin/craft/src/run/findings.rs) — and the parents reading the
// list keep that sentence: rust-audit's nested reviews and the hosts' review summary.
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { findingsList } from './cli-review-findings.mjs'
import { finishedAnswer } from './cli-review-verdict.mjs'
import { cliFindings } from './rust-audit-nested.mjs'
import { START, summaryOf } from './craft-review-run.mjs'
import { finishedStep } from './cli-review-step.mjs'

/** @param {string} severity @param {string} file @param {number} line @param {string} title @param {string} tier */
const f = (severity, file, line, title, tier) => ({ severity, file, line, title, ruleId: '', tier })

const FINDINGS = [
  f('High', 'a.rs', 1, 'bug', 'confirmed'),
  f('Medium', 'a.rs', 2, 'dead check', 'unverified'),
  f('Low', 'b.rs', 3, 'naming', 'unverified'),
  f('Info', 'b.rs', 4, 'nit', 'unverified'),
  f('Low', 'c.rs', 5, 'checked', 'confirmed'),
]

test('the held findings leave the list and one line names their count and file', () => {
  assert.equal(
    findingsList(FINDINGS, { count: 2, file: '/r/unverified.md' }),
    '## Findings\n\n- [High] a.rs:1 — bug (confirmed)\n- [Medium] a.rs:2 — dead check (unverified)\n- [Low] c.rs:5 — checked (confirmed)\n2 Low or Info finding(s) no verifier checked are not listed: they are in /r/unverified.md.',
  )
})

test('a step naming none held lists every finding', () => {
  const got = findingsList(FINDINGS)
  assert.ok(got.includes('— naming (unverified)') && got.includes('— nit (unverified)'), got)
  assert.ok(!got.includes('not listed'), got)
})

test('only held findings leave no None reported line', () => {
  assert.equal(
    findingsList([f('Low', 'b.rs', 0, 'n', 'unverified')], { count: 1, file: '/r/u.md' }),
    '## Findings\n\n1 Low or Info finding(s) no verifier checked are not listed: they are in /r/u.md.',
  )
  assert.equal(findingsList([]), '## Findings\n\nNone reported.')
})

test('the finished step reads what the binary held apart, and nothing from a count of none', () => {
  const base = { run: '/r', done: true, report: '/r/report.md', verdict: 'Warning', findings: [] }
  const read = (/** @type {unknown} */ held) => {
    const r = finishedStep({ ...base, unverifiedLow: held })
    if ('error' in r) throw new Error(r.error)
    return r.step.unverifiedLow
  }
  assert.deepEqual(read({ count: 3, file: '/r/unverified.md' }), { count: 3, file: '/r/unverified.md' })
  for (const none of [undefined, { count: 0, file: '/r/u.md' }, { count: 2, file: '' }, { count: 2, file: '  ' }, { count: 1.5, file: '/r/u.md' }, 'x'])
    assert.equal(read(none), null)
})

const HELD = { count: 2, file: '/r/unverified.md' }
const SENTENCE = '2 Low or Info finding(s) no verifier checked are not listed: they are in /r/unverified.md.'

test('the finished answer lists what the step names and leaves out what it held apart', () => {
  const step = { run: '/r', report: '/r/report.md', verdict: 'Block', line: 'Block', degraded: false, findings: FINDINGS }
  const held = finishedAnswer({ ...step, unverifiedLow: HELD })
  assert.ok(held.endsWith(`- [Low] c.rs:5 — checked (confirmed)\n${SENTENCE}`), held)
  assert.ok(!held.includes('— naming (unverified)'), held)
  const whole = finishedAnswer(step)
  assert.ok(whole.includes('— naming (unverified)') && !whole.includes('not listed'), whole)
})

test('a parent reading the list keeps the count and file of what was held apart', () => {
  const answer = `## Verdict\n\nBlock\n\n${findingsList(FINDINGS, HELD)}`
  const rows = cliFindings(answer)
  assert.deepEqual(
    rows.map(r => [r.severity, r.location, r.title]),
    [
      ['High', 'a.rs:1', 'bug (confirmed)'],
      ['Medium', 'a.rs:2', 'dead check (unverified)'],
      ['Low', 'c.rs:5', 'checked (confirmed)'],
      ['Info', '/r/unverified.md', '2 unverified Low or Info finding(s) held apart'],
    ],
  )
  const summary = summaryOf({ code: 0, answer, result: { type: 'result', verdict: 'Block', report: '/r/report.md', run: '/r' }, said: [], progress: START })
  assert.equal(summary.findings.at(-1), SENTENCE)
  assert.equal(summary.findings.length, 4)
})
