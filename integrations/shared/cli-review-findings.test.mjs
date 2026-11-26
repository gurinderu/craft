// The answer's `## Findings` list as the JS driver writes it (integrations/shared/cli-review-verdict.mjs, findingsList): the
// unverified Low and Info findings the binary held apart leave the list, one sentence names their count and file
// (realm @nick/craft, node #636) — the same cases as the binary's own writer (cli/bin/craft/src/run/findings.rs).
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { findingsList } from './cli-review-verdict.mjs'
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
  for (const none of [undefined, { count: 0, file: '/r/u.md' }, { count: 2, file: '' }, { count: 1.5, file: '/r/u.md' }, 'x']) assert.equal(read(none), null)
})
